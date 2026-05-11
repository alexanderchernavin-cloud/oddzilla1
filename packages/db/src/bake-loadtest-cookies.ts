// Mint pre-authed cookies for k6 to bypass the /auth/login rate limit
// (5/min/IP) during a load test. For every loadtest user it:
//
//   1. Creates a new session row (revokedAt=null, expires in 30d).
//   2. Signs an access JWT with sub=userId, role=user, sid=sessionId.
//      TTL defaults to 2h so a long ramp doesn't outlive cookies.
//   3. Generates a refresh token; stores its sha256 in
//      sessions.refresh_token_hash and emits the raw token to JSON.
//
// Output: a JSON array on stdout (or to OUTPUT_FILE) shaped like:
//   [{ userId, email, access, refresh }, ...]
//
// k6 consumes this with `JSON.parse(open('loadtest-cookies.json'))` and
// distributes one entry per VU via `__VU - 1` index.
//
// Run on the prod box (where JWT_SECRET lives), NOT from a dev laptop:
//   ssh team@<prod> "cd /home/team/oddzilla && \
//     set -a; . .env; set +a; \
//     export DATABASE_URL=\$(echo \"\$DATABASE_URL\" | sed 's|@postgres:|@127.0.0.1:|'); \
//     pnpm --filter @oddzilla/db db:bake-loadtest-cookies > /tmp/cookies.json"
//   scp team@<prod>:/tmp/cookies.json ./tests/load/
//
// Cleanup: pnpm --filter @oddzilla/db db:seed-loadtest:cleanup
// (revokes every session because the user delete cascades to sessions).

import { ilike } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { signAccessToken, secretKey, newRefreshToken } from "@oddzilla/auth";
import { createDb } from "./index.js";
import { users, sessions } from "./schema/index.js";

const databaseUrl = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (!jwtSecret) {
  console.error("JWT_SECRET is required (read it from prod /home/team/oddzilla/.env)");
  process.exit(1);
}

const COUNT = Number(process.env.COUNT ?? 5000);
const ACCESS_TTL_SECONDS = Number(process.env.ACCESS_TTL_SECONDS ?? 7200); // 2h
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS ?? 30);
const OUTPUT_FILE = process.env.OUTPUT_FILE; // defaults to stdout
const EMAIL_PATTERN = "loadtest+%@oddzilla.test";

interface Cookie {
  userId: string;
  email: string;
  access: string;
  refresh: string;
}

async function main() {
  const { db, sql: pg } = createDb(databaseUrl!);
  const key = secretKey(jwtSecret!);

  const targetUsers = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(ilike(users.email, EMAIL_PATTERN))
    .orderBy(users.email)
    .limit(COUNT);
  if (targetUsers.length === 0) {
    console.error(`no loadtest users matching ${EMAIL_PATTERN}. Run db:seed-loadtest first.`);
    process.exit(1);
  }
  process.stderr.write(
    `baking cookies for ${targetUsers.length} users (access TTL ${ACCESS_TTL_SECONDS}s)...\n`,
  );

  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);
  const out: Cookie[] = [];
  let signed = 0;

  const BATCH = 500;
  for (let offset = 0; offset < targetUsers.length; offset += BATCH) {
    const slice = targetUsers.slice(offset, offset + BATCH);
    const minted = slice.map((u) => {
      const refresh = newRefreshToken();
      return {
        sessionId: randomUUID(),
        familyId: randomUUID(),
        refresh,
        user: u,
      };
    });

    await db.insert(sessions).values(
      minted.map((s) => ({
        id: s.sessionId,
        userId: s.user.id,
        refreshTokenHash: s.refresh.hash,
        familyId: s.familyId,
        deviceId: "loadtest",
        userAgent: "k6/loadtest",
        expiresAt,
      })),
    );

    for (const s of minted) {
      const access = await signAccessToken(
        { sub: s.user.id, role: s.user.role, sid: s.sessionId },
        key,
        ACCESS_TTL_SECONDS,
      );
      out.push({
        userId: s.user.id,
        email: s.user.email,
        access,
        refresh: s.refresh.raw,
      });
      signed++;
    }
    process.stderr.write(`  ${signed}/${targetUsers.length}\r`);
  }
  process.stderr.write("\n");

  const json = JSON.stringify(out);
  if (OUTPUT_FILE) {
    writeFileSync(OUTPUT_FILE, json);
    process.stderr.write(`wrote ${out.length} cookies to ${OUTPUT_FILE}\n`);
  } else {
    process.stdout.write(json);
  }

  await pg.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
