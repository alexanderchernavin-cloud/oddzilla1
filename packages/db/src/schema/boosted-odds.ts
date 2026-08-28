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
  index,
  customType,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { competitors, matches, sports, tournaments } from "./catalog.js";
import { markets } from "./markets.js";

// Postgres BYTEA mapped to Buffer in/out — same local-copy convention as
// catalog.ts / admin.ts (each schema file keeps its own to avoid a
// cross-file util import).
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

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
    // AI-generated graphic for the banner (migration 0089). Ticking the
    // option enqueues a zillaboost_banner_image_jobs row for the
    // operator-PC worker; the image BYTES live on the job row, not
    // here — the pricing paths full-row-select this table on hot
    // catalog requests and must not drag a BYTEA along.
    graphicsBanner: boolean("graphics_banner").notNull().default(false),
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

// AI-generated banner graphics queue + storage (migration 0089). One row
// per rule: re-generating resets the SAME row to pending, and the previous
// image stays until the replacement lands so the storefront banner never
// blanks mid-regenerate. Drained by the operator-PC worker
// (services/zillaboost-banner-gen) via /webhooks/banner-gen/:secret/* —
// pull model, the production box never dials the operator's LAN, so "PC
// off" just means rows accumulate here.
export const zillaboostBannerImageJobs = pgTable(
  "zillaboost_banner_image_jobs",
  {
    ruleId: uuid("rule_id")
      .primaryKey()
      .references(() => boostedOddsConfig.id, { onDelete: "cascade" }),
    status: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    lastError: text("last_error"),
    // Claim lease — a handed-out job is invisible to further /pending
    // polls until this expires, so a crashed worker's job self-returns.
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    // Generation-failure backoff: pending, but not offered before this.
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    imageData: bytea("image_data"),
    imageMime: text("image_mime"),
    // The diffusion prompt this image was rendered from (migration
    // 0090) — image quality is iterated by changing prompts, so the
    // backoffice needs to see what was actually asked for.
    lastPrompt: text("last_prompt"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "zillaboost_banner_image_jobs_status",
      sql`${t.status} IN ('pending', 'done', 'failed')`,
    ),
    check(
      "zillaboost_banner_image_jobs_mime",
      sql`(${t.imageData} IS NULL AND ${t.imageMime} IS NULL) OR (${t.imageData} IS NOT NULL AND ${t.imageMime} IN ('image/png', 'image/jpeg', 'image/webp'))`,
    ),
    index("zillaboost_banner_image_jobs_pending_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export type ZillaboostBannerImageJobRow =
  typeof zillaboostBannerImageJobs.$inferSelect;
