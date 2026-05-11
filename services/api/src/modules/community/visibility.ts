// Shared visibility predicate for community-facing reads (audit SEC-C1).
//
// Three call shapes are covered here so every community module funnels
// through one helper instead of re-inlining the
// `tickets_public = true AND nickname IS NOT NULL AND is_ai = false`
// triplet. The previous version of this filter only checked
// `tickets_public + nickname`, which let AI seed accounts surface on
// every bettor-visible read even though admin/dashboard.ts and
// admin/riskzilla/* already honoured `users.is_ai = true` as the
// exclusion flag.
//
// The is_ai filter is purely additive — no row that previously
// qualified for the feed loses visibility unless it's an AI seed
// account, which is exactly the audit fix.
//
// Three shapes, one source of truth:
//
//   • `publicAuthorClause(users)` — Drizzle builder predicate. Compose
//     into `where(and(...))` for typed-select queries.
//   • `PUBLIC_AUTHOR_SQL` — raw `sql\`\`` fragment for inline
//     `db.execute(sql\`...\`)` paths (Recent feed, leaderboards,
//     analyses). Uses the `u` table alias that every call site here
//     already gives to the `users` join.
//   • `isPubliclyVisibleAuthor(row)` — JS-side predicate for already-
//     loaded rows. Useful when the row was fetched without the
//     visibility filter on the WHERE (e.g. self-profile preload).
//
// All three return the same logical condition; keep them in lockstep
// when extending (next-up: blocklist / shadow-ban flag).

import { and, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { users } from "@oddzilla/db";

// Drizzle column-clause helper. The argument is the same `users`
// table reference Drizzle exports; callers pass it through to keep
// the import surface obvious at the call site.
export function publicAuthorClause(
  usersTable: typeof users,
): SQL | undefined {
  return and(
    eq(usersTable.ticketsPublic, true),
    isNotNull(usersTable.nickname),
    eq(usersTable.isAi, false),
  );
}

// Raw-SQL fragment for the inline `db.execute(sql\`...\`)` paths.
// Assumes the `users` table is joined under the alias `u`, which is
// the convention every community-module raw query already follows.
// If a new raw query uses a different alias, build a one-off
// `sql\`<alias>.tickets_public = true AND ...\`` rather than aliasing
// the table away from `u` — keeping the alias uniform across the
// module makes the predicate trivially greppable.
export const PUBLIC_AUTHOR_SQL = sql`u.tickets_public = true AND u.nickname IS NOT NULL AND u.is_ai = false`;

// JS-side predicate. Used by code paths that have already loaded the
// `users` row (e.g. nickname → row lookup) and want to gate on the
// same condition without a second roundtrip. Acts as a type predicate
// so callers get nickname: string (non-null) after the guard.
export function isPubliclyVisibleAuthor<
  T extends { ticketsPublic: boolean; nickname: string | null; isAi: boolean },
>(row: T): row is T & { nickname: string } {
  return row.ticketsPublic && row.nickname !== null && !row.isAi;
}
