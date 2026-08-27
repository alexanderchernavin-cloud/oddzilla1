// Custom Boosted Odds — operator-curated Netwinstable boosts pinned to
// any catalog entity (migration 0085; 'outcome' scope added in
// 0087-0088). One rule per (scope, ref); resolution per market is
// most-specific-wins:
//     outcome > market > match > competitor > tournament > sport
// boost_pct is a key delta in percentage points, applied at read /
// placement time via boostMarketKey (whole market) or
// boostSelectionKeys ('outcome' scope — one cell) — the boosted price
// is never stored. min_risk_score gates delivery per bettor
// (users.risk_score below the threshold sees the standard price).

import { sql } from "drizzle-orm";
import {
  boolean,
  pgTable,
  pgEnum,
  uuid,
  integer,
  bigint,
  numeric,
  text,
  timestamp,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { competitors, matches, sports, tournaments } from "./catalog.js";
import { markets } from "./markets.js";

export const boostedOddsScopeEnum = pgEnum("boosted_odds_scope", [
  "sport",
  "tournament",
  "match",
  "competitor",
  "market",
  "outcome",
]);

export const boostedOddsConfig = pgTable(
  "boosted_odds_config",
  {
    id: uuid()
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    scope: boostedOddsScopeEnum().notNull(),
    sportId: integer("sport_id").references(() => sports.id, {
      onDelete: "cascade",
    }),
    tournamentId: integer("tournament_id").references(() => tournaments.id, {
      onDelete: "cascade",
    }),
    matchId: bigint("match_id", { mode: "bigint" }).references(
      () => matches.id,
      { onDelete: "cascade" },
    ),
    competitorId: integer("competitor_id").references(() => competitors.id, {
      onDelete: "cascade",
    }),
    marketId: bigint("market_id", { mode: "bigint" }).references(
      () => markets.id,
      { onDelete: "cascade" },
    ),
    // scope='outcome' only: the market_outcomes.outcome_id half of the
    // (market_id, outcome_id) key. Intentionally NOT an FK — validating
    // one would lock market_outcomes against the live feed (see
    // migration 0088). The admin route checks the row exists on write.
    outcomeId: text("outcome_id"),
    boostPct: numeric("boost_pct", { precision: 5, scale: 2 }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    minRiskScore: numeric("min_risk_score", { precision: 4, scale: 3 }),
    // Promo banner on the storefront home page (migration 0086):
    // market -> ZillaFlash-style card, match -> scoreless match card
    // with original + boosted prices, tournament -> ZillaBoost banner
    // linking to its match list, sport -> boost icon in the sidebar.
    banner: boolean().notNull().default(false),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "boosted_odds_pct_range",
      sql`${t.boostPct} > 0 AND ${t.boostPct} <= 50`,
    ),
    check(
      "boosted_odds_min_rs_range",
      sql`${t.minRiskScore} IS NULL OR (${t.minRiskScore} >= 0.01 AND ${t.minRiskScore} <= 10)`,
    ),
    check(
      "boosted_odds_outcome_id_len",
      sql`${t.outcomeId} IS NULL OR (length(${t.outcomeId}) BETWEEN 1 AND 64)`,
    ),
    uniqueIndex("boosted_odds_sport_uniq")
      .on(t.sportId)
      .where(sql`${t.scope} = 'sport'`),
    uniqueIndex("boosted_odds_tournament_uniq")
      .on(t.tournamentId)
      .where(sql`${t.scope} = 'tournament'`),
    uniqueIndex("boosted_odds_match_uniq")
      .on(t.matchId)
      .where(sql`${t.scope} = 'match'`),
    uniqueIndex("boosted_odds_competitor_uniq")
      .on(t.competitorId)
      .where(sql`${t.scope} = 'competitor'`),
    uniqueIndex("boosted_odds_market_uniq")
      .on(t.marketId)
      .where(sql`${t.scope} = 'market'`),
    // Selection rules share market_id with market rules but live in
    // their own partial index, so a market can carry a market-scope
    // rule AND per-outcome rules simultaneously (the pricing path picks
    // one — selections win, see quoteMarketBoost).
    uniqueIndex("boosted_odds_outcome_uniq")
      .on(t.marketId, t.outcomeId)
      .where(sql`${t.scope} = 'outcome'`),
  ],
);

export type BoostedOddsConfigRow = typeof boostedOddsConfig.$inferSelect;
