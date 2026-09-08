import { sql } from "drizzle-orm";
import {
  pgTable,
  integer,
  text,
  boolean,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Our own `provider_market_id` per market TYPE (migration
 * 20260908T115542).
 *
 * A Fonbet market's id used to be `1_000_000 + catalogue table`, and
 * Fonbet reuses one table across every sub-event: "Match result",
 * "2nd half: Match result" and "Corners: Match result" were all 1000120.
 * Measured on production 2026-09-08, 1 886 distinct (table, sub-event)
 * pairs shared 30 ids — so every reader that keyed off the integer alone
 * was looking at the wrong market.
 *
 * Deliberately NOT `fonbet_market_types`: the point of owning the ids is
 * that a second provider's 1X2 can be recognised as the same market as the
 * first one's, which needs every provider's types in one table.
 *
 * The id is OPAQUE by construction. Fonbet's sub-event kinds are 6-digit
 * numbers chaining two deep and `provider_market_id` is int4, so no
 * encoding of (table, kind chain) is both injective and derivable — hence
 * a registry. The trade-off is accepted knowingly: nothing can recover the
 * table from the number, and ids are per environment, so a denylist row
 * exported from production means nothing in development. Every row keeps
 * (table_num, variant, double_chance) so that pairing is always
 * re-resolvable, and `market_kind` is the readable key consumers should
 * prefer.
 */
export const providerMarketTypes = pgTable(
  "provider_market_types",
  {
    providerMarketId: integer("provider_market_id").primaryKey(),
    /** Which feed the type came from. */
    provider: text().notNull().default("fonbet"),
    /** The provider's own type number: Fonbet's table, Oddin's market id. */
    tableNum: integer("table_num").notNull(),
    /**
     * Sub-event kind chain, per-player suffix stripped: "" for the main
     * event, "100201" for the 1st half, "400100/10100201" for a half's
     * corners. The player id is a PARAMETER — 1 202 of the 1 264 live
     * variants carry one, so folding it in would give every player their
     * own type.
     */
    variant: text().notNull().default(""),
    /** The 1X / X2 / 12 cells split off a match-winner table. */
    doubleChance: boolean("double_chance").notNull().default(false),
    /** Generated in SQL: "fb:120", "fb:120@100201", "fb:120#dc", "od:1". */
    marketKind: text("market_kind").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("provider_market_types_key").on(
      t.provider,
      t.tableNum,
      t.variant,
      t.doubleChance,
    ),
    uniqueIndex("provider_market_types_kind_idx").on(t.marketKind),
  ],
);

export type ProviderMarketType = typeof providerMarketTypes.$inferSelect;
