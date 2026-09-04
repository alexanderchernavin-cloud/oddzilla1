// Sportradar match mapping (migration 0100).
//
// Oddzilla's own match id is `matches.id`, and the Oddin / Fonbet ids are
// derivable from `matches.provider_urn`. Sportradar's is not derivable
// from anything we ingest, so it is stored here with the provenance
// needed to judge it — see the migration header for why.

import {
  bigint,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { matches } from "./catalog.js";
import { users } from "./users.js";

export const sportradarMapStatusEnum = pgEnum("sportradar_map_status", [
  "candidate",
  "confirmed",
  "rejected",
]);

export const sportradarMapSourceEnum = pgEnum("sportradar_map_source", [
  "admin",
  "auto",
]);

export const matchSportradarIds = pgTable(
  "match_sportradar_ids",
  {
    matchId: bigint({ mode: "bigint" })
      .primaryKey()
      .references(() => matches.id, { onDelete: "cascade" }),
    srMatchId: bigint({ mode: "bigint" }).notNull(),
    // Sportradar's own sport taxonomy (1 soccer, 2 basketball, 5 tennis,
    // 12 rugby, 137 esoccer, ...). Stored per row rather than looked up
    // from our sport slug so a one-off correction is expressible.
    srSportId: smallint().notNull(),
    status: sportradarMapStatusEnum().notNull().default("candidate"),
    source: sportradarMapSourceEnum().notNull(),
    // 0..1 for auto-matched rows; NULL when a human typed the id in.
    confidence: numeric({ precision: 4, scale: 3 }),
    // What the matcher matched against — SR-side names + kickoff, the
    // per-component scores, and any runners-up.
    evidence: jsonb(),
    reviewedByUserId: uuid().references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live mapping per SR fixture; rejected rows are tombstones and
    // must not block the correct match from claiming the same id.
    uniqueIndex("match_sportradar_srid_uniq")
      .on(t.srMatchId)
      .where(sql`${t.status} <> 'rejected'`),
    index("match_sportradar_status_idx").on(t.status, t.confidence),
  ],
);

export type MatchSportradarId = typeof matchSportradarIds.$inferSelect;
