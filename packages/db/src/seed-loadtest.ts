// Bulk-create N test users for k6 load testing.
//
// Why this exists: the signup API costs ~150–300 ms per call (argon2id,
// wallet inserts, audit log, OZ bonus ledger row), so driving 5000 signups
// through it would take 15+ minutes of pegged CPU AND poison admin views
// with the test rows. This script bypasses the API and writes directly:
//
//   - Hash one shared password ONCE. Every test user logs in with the same
//     password — fine because they're isolated by email/uuid.
//   - Mark them `is_ai = true` so /admin/stats and the community feed
//     already filter them out (Phase 10.4 wiring).
//   - Email pattern: loadtest+NNNN@oddzilla.test — the .test TLD is
//     reserved (RFC 2606) so no real address can collide and cleanup is
//     one DELETE on the LIKE.
//
// Idempotent. Re-running adds only the missing rows.
//
// Usage:
//   DATABASE_URL=... pnpm --filter @oddzilla/db db:seed-loadtest
//   COUNT=5000 LOADTEST_PASSWORD=hunter2 pnpm --filter @oddzilla/db db:seed-loadtest
//
// Cleanup: pnpm --filter @oddzilla/db db:seed-loadtest:cleanup

import argon2 from "@node-rs/argon2";
import { SIGNUP_BONUS_OZ_MICRO } from "@oddzilla/types";
import { createDb } from "./index.js";
import { users, wallets, walletLedger } from "./schema/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const COUNT = Number(process.env.COUNT ?? 5000);
const PASSWORD = process.env.LOADTEST_PASSWORD ?? "loadtest-password-1";
const EMAIL_PREFIX = "loadtest+";
const EMAIL_DOMAIN = "@oddzilla.test";
const BATCH = 500;

function paddedIndex(i: number, total: number): string {
  const width = String(total - 1).length;
  return String(i).padStart(width, "0");
}

async function main() {
  if (COUNT < 1 || COUNT > 100_000) {
    throw new Error(`COUNT out of range: ${COUNT} (expected 1..100000)`);
  }

  console.log(`hashing shared password (argon2id m=19MiB t=2)...`);
  const t0 = Date.now();
  const hash = await argon2.hash(PASSWORD, {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    algorithm: 2,
  });
  console.log(`  hashed in ${Date.now() - t0} ms`);

  const { db, sql: pg } = createDb(databaseUrl!);

  console.log(`seeding ${COUNT} loadtest users (batch=${BATCH})...`);
  let createdUsers = 0;
  let createdWallets = 0;
  let createdLedger = 0;

  for (let offset = 0; offset < COUNT; offset += BATCH) {
    const end = Math.min(offset + BATCH, COUNT);
    const userRows = [] as Array<{
      email: string;
      passwordHash: string;
      role: "user";
      status: "active";
      isAi: boolean;
    }>;
    for (let i = offset; i < end; i++) {
      userRows.push({
        email: `${EMAIL_PREFIX}${paddedIndex(i, COUNT)}${EMAIL_DOMAIN}`,
        passwordHash: hash,
        role: "user",
        status: "active",
        isAi: true,
      });
    }

    const newUsers = await db
      .insert(users)
      .values(userRows)
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    createdUsers += newUsers.length;
    if (newUsers.length === 0) {
      process.stdout.write(`  ${end}/${COUNT}\r`);
      continue;
    }

    const walletRows = newUsers.flatMap((u) => [
      { userId: u.id, currency: "USDC", balanceMicro: 0n },
      { userId: u.id, currency: "OZ", balanceMicro: SIGNUP_BONUS_OZ_MICRO },
    ]);
    const insertedWallets = await db
      .insert(wallets)
      .values(walletRows)
      .onConflictDoNothing({ target: [wallets.userId, wallets.currency] })
      .returning({ userId: wallets.userId });
    createdWallets += insertedWallets.length;

    const ledgerRows = newUsers.map((u) => ({
      userId: u.id,
      currency: "OZ",
      deltaMicro: SIGNUP_BONUS_OZ_MICRO,
      type: "adjustment" as const,
      refType: "signup_bonus",
      refId: u.id,
      memo: "loadtest OZ signup bonus",
    }));
    const insertedLedger = await db
      .insert(walletLedger)
      .values(ledgerRows)
      .onConflictDoNothing()
      .returning({ id: walletLedger.id });
    createdLedger += insertedLedger.length;

    process.stdout.write(`  ${end}/${COUNT}\r`);
  }

  process.stdout.write("\n");
  console.log(
    `done: +${createdUsers} users, +${createdWallets} wallets, +${createdLedger} signup-bonus ledger rows`,
  );
  console.log("");
  console.log("--- credentials for k6 ---");
  console.log(`  email pattern: ${EMAIL_PREFIX}NNNN${EMAIL_DOMAIN}  (zero-padded, 0..${COUNT - 1})`);
  console.log(`  password:      ${PASSWORD}`);
  console.log("");
  console.log("Cleanup: pnpm --filter @oddzilla/db db:seed-loadtest:cleanup");

  await pg.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
