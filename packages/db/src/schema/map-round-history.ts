import {
  pgTable,
  bigint,
  smallint,
  text,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { matches } from "./catalog.js";

// One row per (match, map). `roundWinners` is a compact chronological
// string — 'H' = home won the round, 'A' = away won — appended to as
// rounds finalise on the feed. See migration 0051 for the design
// notes and consistency invariants enforced at the DB level.
export const mapRoundHistory = pgTable(
  "map_round_history",
  {
    matchId: bigint("match_id", { mode: "bigint" })
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    mapNumber: smallint("map_number").notNull(),
    roundWinners: text("round_winners").notNull().default(""),
    homeWonTotal: smallint("home_won_total").notNull().default(0),
    awayWonTotal: smallint("away_won_total").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.mapNumber] }),
    index("map_round_history_match_idx").on(t.matchId),
  ],
);

export type MapRoundHistory = typeof mapRoundHistory.$inferSelect;
