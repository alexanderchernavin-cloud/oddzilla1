// Custom events — operator-authored offer, migration
// 20260906T133515_custom_events.
//
// The events themselves live in `matches` / `markets` / `market_outcomes`
// like everything else; these two tables carry only what the feed shape
// has nowhere to put. See the migration for why that split is where it is.

import {
  pgTable,
  bigint,
  boolean,
  integer,
  numeric,
  text,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { markets } from "./markets.js";
import { matches } from "./catalog.js";

/**
 * Per-event presentation and closing date — migration
 * 20260906T200754_custom_event_layout.
 *
 * Custom events cover two shapes: a fixture, which is defined by its
 * kickoff, and an outright, which is defined by the date it stops taking
 * bets. This carries both halves.
 */
export const customEventConfig = pgTable("custom_event_config", {
  matchId: bigint("match_id", { mode: "bigint" })
    .primaryKey()
    .references(() => matches.id, { onDelete: "cascade" }),
  /**
   * `matchup` renders the usual two-sided card. `markets` drops it and
   * puts the event's markets on the card itself — the shape a question
   * with answers needs, where there is no home and away side to stack.
   */
  layout: text("layout").notNull().default("matchup"),
  /**
   * When betting closes. NULL = no automatic close.
   *
   * Read in two places, and the first is easy to miss: the catalog's
   * staleness gate drops a `not_started` match whose kickoff is over six
   * hours old, so without this an outright would leave the storefront the
   * afternoon it opened. The sweeper reads it to suspend the markets once
   * the window shuts — suspend, not settle, because the book closes while
   * the result is still unknown.
   */
  endsAt: timestamp("ends_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customMarketConfig = pgTable("custom_market_config", {
  marketId: bigint("market_id", { mode: "bigint" })
    .primaryKey()
    .references(() => markets.id, { onDelete: "cascade" }),
  /** Book margin in basis points: 500 = prices summing to a 1.05 key. */
  overroundBp: integer("overround_bp").notNull().default(500),
  /**
   * Pull priced probabilities toward each outcome's share of the book's
   * exposure. Shortens the side holding the money, lengthens the rest.
   */
  liabilityTrading: boolean("liability_trading").notNull().default(false),
  /** 0 = ignore bets entirely, 10000 = price purely off the money. */
  liabilityStrengthBp: integer("liability_strength_bp").notNull().default(3000),
  /** Cap on how far one outcome may move from the operator's own view. */
  liabilityMaxShiftBp: integer("liability_max_shift_bp").notNull().default(1500),
  /** Last time the sweeper repriced this market. */
  liabilityPricedAt: timestamp("liability_priced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customOutcomeConfig = pgTable(
  "custom_outcome_config",
  {
    marketId: bigint("market_id", { mode: "bigint" })
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    outcomeId: text("outcome_id").notNull(),
    /**
     * The operator's own probability, kept apart from
     * `market_outcomes.probability` so liability trading has a stable
     * anchor to blend from. Without it each repricing would compound on
     * the last and the operator's view would be lost after one bet.
     */
    baseProbability: numeric("base_probability", { precision: 8, scale: 7 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.marketId, t.outcomeId] })],
);

export type CustomMarketConfig = typeof customMarketConfig.$inferSelect;
export type CustomOutcomeConfig = typeof customOutcomeConfig.$inferSelect;
export type CustomEventConfig = typeof customEventConfig.$inferSelect;
