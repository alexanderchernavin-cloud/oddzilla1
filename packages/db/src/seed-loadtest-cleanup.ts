// Remove every loadtest user previously created by seed-loadtest.ts.
//
// Wallets and wallet_ledger reference users with onDelete: "restrict",
// so we delete in dependency order: sessions → wallet_ledger → wallets
// → users. Anything else a loadtest user might have touched (tickets,
// achievements, community_tickets) is also cleared by the same email
// LIKE; the schema's per-table cascade does the rest.
//
// Usage:
//   DATABASE_URL=... pnpm --filter @oddzilla/db db:seed-loadtest:cleanup

import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const EMAIL_PATTERN = "loadtest+%@oddzilla.test";

async function main() {
  const sql = postgres(databaseUrl!, { max: 1 });

  const probe = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM users WHERE email LIKE ${EMAIL_PATTERN}
  `;
  const userCount = probe[0]?.count ?? 0;
  if (userCount === 0) {
    console.log("no loadtest users found — nothing to clean up");
    await sql.end();
    return;
  }
  console.log(`found ${userCount} loadtest users, cleaning up...`);

  await sql.begin(async (tx) => {
    // Sessions reference users(id) directly. Drop them first so the
    // user delete doesn't trip the FK.
    const sessions = await tx`
      DELETE FROM sessions
       WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${EMAIL_PATTERN})
       RETURNING id
    `;
    console.log(`  -${sessions.length} sessions`);

    // Tickets reference users; cascade to ticket_selections, settlements
    // FK behaviour is RESTRICT but loadtest users won't have settled
    // tickets in a normal run. If a settlement landed mid-test, leave
    // those rows for an operator — DELETE will refuse rather than break
    // audit history.
    const tickets = await tx`
      DELETE FROM tickets
       WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${EMAIL_PATTERN})
       RETURNING id
    `;
    console.log(`  -${tickets.length} tickets`);

    const ledger = await tx`
      DELETE FROM wallet_ledger
       WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${EMAIL_PATTERN})
       RETURNING id
    `;
    console.log(`  -${ledger.length} wallet_ledger rows`);

    const wallets = await tx`
      DELETE FROM wallets
       WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${EMAIL_PATTERN})
       RETURNING user_id
    `;
    console.log(`  -${wallets.length} wallet rows`);

    const userAchievements = await tx`
      DELETE FROM user_achievements
       WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${EMAIL_PATTERN})
       RETURNING user_id
    `;
    console.log(`  -${userAchievements.length} user_achievements rows`);

    const communityTickets = await tx`
      DELETE FROM community_tickets
       WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${EMAIL_PATTERN})
       RETURNING ticket_id
    `;
    console.log(`  -${communityTickets.length} community_tickets rows`);

    // user_devices was added in migration 0045 — tolerate the table not
    // existing (e.g. a box that's behind on migrations or doesn't run
    // the push-notification feature) so the rest of the cleanup tx still
    // commits. Without the existence check, a missing table aborts the
    // whole tx and leaves orphan rows (which is what bit us during the
    // 2026-05-11 load test cleanup on prod).
    const userDevicesExists = await tx<{ exists: boolean }[]>`
      SELECT to_regclass('public.user_devices') IS NOT NULL AS exists
    `;
    if (userDevicesExists[0]?.exists) {
      const userDevices = await tx`
        DELETE FROM user_devices
         WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${EMAIL_PATTERN})
         RETURNING token
      `;
      console.log(`  -${userDevices.length} user_devices rows`);
    } else {
      console.log(`  -0 user_devices rows (table absent)`);
    }

    const users = await tx`
      DELETE FROM users WHERE email LIKE ${EMAIL_PATTERN} RETURNING id
    `;
    console.log(`  -${users.length} users`);
  });

  await sql.end();
  console.log("cleanup complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
