// Idempotent seed. Safe to re-run.
//
// Inserts:
//   - 4 Oddin esports (CS2, DOTA2, LOL, Valorant)
//   - A dummy category per sport (is_dummy=true, slug=same as sport)
//   - Admin user + test user (argon2id hashed passwords)
//   - Zero-balance wallets for both users
//   - Global odds_config row at 500 bp (5%) payback margin

import argon2 from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./index.js";
import {
  sports,
  categories,
  users,
  wallets,
  oddsConfig,
} from "./schema/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const seedSports = [
  { providerUrn: "od:sport:cs2", slug: "cs2", name: "Counter-Strike 2" },
  { providerUrn: "od:sport:dota2", slug: "dota2", name: "Dota 2" },
  { providerUrn: "od:sport:lol", slug: "lol", name: "League of Legends" },
  { providerUrn: "od:sport:valorant", slug: "valorant", name: "Valorant" },
] as const;

const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@oddzilla.local";
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMeAdmin123!";
const userEmail = process.env.SEED_USER_EMAIL ?? "user@oddzilla.local";
const userPassword = process.env.SEED_USER_PASSWORD ?? "ChangeMeUser123!";

async function hashPassword(plain: string): Promise<string> {
  // algorithm: 2 = Argon2id. Using the literal since the enum from
  // @node-rs/argon2 is const and can't be referenced under isolatedModules.
  return argon2.hash(plain, {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    algorithm: 2,
  });
}

async function main() {
  const { db, sql: pg } = createDb(databaseUrl!);

  // Sports + dummy categories (one insert per sport for clarity)
  for (const s of seedSports) {
    const [sport] = await db
      .insert(sports)
      .values({
        provider: "oddin",
        providerUrn: s.providerUrn,
        slug: s.slug,
        name: s.name,
        kind: "esport",
      })
      .onConflictDoUpdate({
        target: sports.slug,
        set: { name: s.name, active: true },
      })
      .returning();

    if (!sport) throw new Error(`failed to upsert sport ${s.slug}`);

    await db
      .insert(categories)
      .values({
        sportId: sport.id,
        providerUrn: null,
        slug: s.slug,
        name: s.name,
        isDummy: true,
      })
      .onConflictDoUpdate({
        target: [categories.sportId, categories.slug],
        set: { name: s.name, active: true },
      });
  }
  console.log(`seeded ${seedSports.length} sports + dummy categories`);

  // Users — insert only if email absent, then ensure a wallet row exists.
  async function upsertUser(email: string, password: string, role: "admin" | "user") {
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    let user = existing[0];
    if (!user) {
      const hash = await hashPassword(password);
      const [inserted] = await db
        .insert(users)
        .values({
          email,
          passwordHash: hash,
          role,
          status: "active",
          kycStatus: role === "admin" ? "approved" : "none",
        })
        .returning();
      user = inserted;
      console.log(`created ${role} ${email}`);
    } else {
      console.log(`${role} ${email} already exists, skipping`);
    }
    if (!user) throw new Error(`failed to upsert ${role}`);

    await db
      .insert(wallets)
      .values({ userId: user.id })
      .onConflictDoNothing({ target: wallets.userId });
    return user;
  }

  await upsertUser(adminEmail, adminPassword, "admin");
  await upsertUser(userEmail, userPassword, "user");

  // Global payback margin = 500 bp (5%)
  await db
    .insert(oddsConfig)
    .values({ scope: "global", scopeRefId: null, paybackMarginBp: 500 })
    .onConflictDoUpdate({
      target: [oddsConfig.scope, oddsConfig.scopeRefId],
      set: { paybackMarginBp: sql`EXCLUDED.payback_margin_bp`, updatedAt: sql`NOW()` },
    });
  console.log("seeded global odds_config (500 bp)");

  console.log("seed complete");
  await pg.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
