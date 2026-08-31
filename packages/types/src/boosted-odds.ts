// Custom Boosted Odds — operator-curated boosts pinned to a sport /
// tournament / match / competitor (team) / single market / single
// selection (migrations 0085 + 0087-0088). Boost math is the same
// Netwinstable key delta ZillaFlash uses: boost_pct percentage points
// shaved off the key, recomputed from live published_odds on every read,
// clamped so the book never reaches fair.
//
// Delivery is gated per bettor by the rule's optional minRiskScore —
// users.risk_score below the threshold sees the standard price.
// Resolution per market when several rules overlap:
//     outcome > market > match > competitor > tournament > sport
// (two competitor rules on the same match resolve to the higher pct).
//
// `outcome` scope is special: it prices ONE cell rather than the whole
// market, so it doesn't merely out-rank the coarser rules — it replaces
// them for that market entirely. See quoteMarketBoost (netwinstable.ts)
// for why.
//
// This module deliberately holds NO relative imports: it is consumed as
// a VALUE subpath (`@oddzilla/types/boosted-odds`) by apps/web, and the
// package is authored for NodeNext, so any relative import here would
// carry a `.js` suffix that webpack can't resolve to the `.ts` file —
// green under tsc, fatal at `next build`. The pricing helpers therefore
// live in netwinstable.ts alongside the math they call.

export type BoostedOddsScope =
  | "sport"
  | "tournament"
  | "match"
  | "competitor"
  | "market"
  | "outcome";

/**
 * How a competitor (team) rule spreads across the team's matches
 * (migration 0093).
 *
 * - `all`: every market of every match the team plays — the original
 *   behaviour, including opponent-facing and symmetric markets.
 * - `team_only`: only the team's OWN outcome, only in team-shaped
 *   markets. Priced like an outcome-scope rule, so the opponent's price
 *   is untouched.
 */
export type CompetitorBoostMarkets = "all" | "team_only";

/**
 * Markets where outcome "1" IS the home competitor and "2" the away one:
 * match winner (1) and map winner (4). This is the existing convention
 * across the codebase — ZillaTips' team-of-interest mapping and the
 * banner endpoint's `teamShaped` flag both key off exactly these two —
 * and a `team_only` team boost needs the same answer, so the predicate
 * lives here once instead of a third copy.
 *
 * Everything else (totals, handicaps, correct score, round winners) is
 * either symmetric or line-shaped: no single outcome "is" a given team,
 * so a team_only boost deliberately does not touch them.
 */
export const TEAM_SHAPED_PROVIDER_MARKET_IDS: readonly number[] = [1, 4];

export function isTeamShapedMarket(providerMarketId: number): boolean {
  return TEAM_SHAPED_PROVIDER_MARKET_IDS.includes(providerMarketId);
}

/**
 * Tolerance for "did the user click the price we compute now" at bet
 * placement. Same rationale + value as ZILLAFLASH_PLACEMENT_TOLERANCE:
 * boosted odds drift sub-cent as the underlying ticks and the display
 * is 2 decimals, so 0.01 is generous.
 */
export const CUSTOM_BOOST_PLACEMENT_TOLERANCE = 0.01;

/** Risk score assumed for anonymous viewers (matches users.risk_score default). */
export const CUSTOM_BOOST_DEFAULT_RISK_SCORE = 1.0;

/**
 * One boosted market on a match, as served by
 * GET /catalog/matches/:id/boosted-odds. Carries only the RULE — no
 * prices. Boosted prices are computed client-side with quoteMarketBoost
 * over the live outcome set the page already tracks via WS ticks, so
 * the boost moves in the same render as the raw odds (true realtime);
 * this endpoint only propagates admin rule changes and the per-viewer
 * Min Risk Score gate. The server calls the same function at placement
 * and compares within CUSTOM_BOOST_PLACEMENT_TOLERANCE.
 */
export interface CustomBoostedMarket {
  /** boosted_odds_config.id — round-trips through POST /bets per leg. */
  ruleId: string;
  marketId: string;
  /** Netwinstable key delta in percentage points. */
  boostPct: number;
  /** ISO end time, or null = boost runs until the operator removes it (no countdown). */
  endsAt: string | null;
}

/** A rule that covers EVERY market of the match (match / competitor /
 * tournament / sport scope, already cascade-resolved server-side). */
export interface CustomBoostMatchWideRule {
  ruleId: string;
  boostPct: number;
  endsAt: string | null;
  /**
   * Set only for a `team_only` competitor rule (migration 0093): the
   * outcome id that IS the boosted team on this match ("1" home / "2"
   * away). When present the client must apply the boost as a SELECTION
   * boost on that outcome, and only where `isTeamShapedMarket` holds —
   * never market-wide, or the opponent's price moves too.
   *
   * Delivered as an instruction rather than a market list on purpose: a
   * live match mints new market rows as maps start, and an enumerated
   * list would silently miss them.
   */
  teamOutcomeId?: "1" | "2" | null;
}

/**
 * One boosted SELECTION — a rule pinned to a single (market, outcome)
 * cell rather than a whole market. Like CustomBoostedMarket this carries
 * only the rule; the price is computed client-side from the live outcome
 * set via quoteMarketBoost.
 */
export interface CustomBoostedSelection {
  ruleId: string;
  marketId: string;
  /** market_outcomes.outcome_id — Oddin's id ("1" / "2" / "3" / a URN). */
  outcomeId: string;
  boostPct: number;
  endsAt: string | null;
}

export interface CustomBoostedOddsResponse {
  /**
   * Market-scope rules only — one entry per explicitly boosted market.
   * Match-wide coverage rides `matchWide` instead of being flattened
   * per market: live ladders CREATE new market rows on odds updates
   * (new handicap/total lines) and suspend/reactivate lines between
   * rounds, so a per-market flattening was stale the moment it was
   * built and every fresh line rendered unboosted until the next poll.
   *
   * Markets that carry at least one entry in `selections` are omitted
   * here — a selection boost takes over its market's pricing (see
   * quoteMarketBoost).
   */
  entries: CustomBoostedMarket[];
  /**
   * Outcome-scope rules. Market ids ARE stable here (the rule pins the
   * row), so unlike match-wide coverage these are safe to ship flat.
   */
  selections: CustomBoostedSelection[];
  /** Cascade-resolved match-wide rule (match > competitor > tournament > sport), or null. */
  matchWide: CustomBoostMatchWideRule | null;
  /** Server-time at response build so clients can correct clock skew. */
  serverNow: string;
}

// ── ZillaBoost promo banners (migration 0086) ────────────────────────
// Rules with banner=true surface on the storefront home page per
// scope. Served by GET /catalog/zillaboost-banners, RS-gated per
// viewer like the per-match rules endpoint.

/**
 * AI-generated banner graphic (migration 0089), present on any banner
 * shape whose rule has one. `imageUrl` points at the byte-serve route
 * with a `?v=` stamp so a regenerated image busts the browser cache.
 */
export interface ZillaBoostBannerImage {
  imageUrl: string;
}

// ── Graphics-banner generation (migration 0089) ──────────────────────
// Wire shapes between the api's /webhooks/banner-gen/:secret/* routes
// and the operator-PC worker (services/zillaboost-banner-gen). Pull
// model: the worker polls /pending over outbound HTTPS; while the PC is
// off, jobs accumulate server-side and drain when it returns.

/** One claimed generation job, with everything the prompt needs. */
export interface BannerGenJob {
  ruleId: string;
  scope: BoostedOddsScope;
  boostPct: number;
  endsAt: string | null;
  attempts: number;
  /**
   * Entity context for research + prompt authoring. Fields are filled
   * per scope: sport rules carry sportName/sportSlug; tournament rules
   * add tournamentName; match / market / outcome rules add the teams;
   * competitor rules carry competitorName. Never all at once.
   *
   * The brand colours matter more than they look: the prompt tells the
   * image model to build a versus composition out of the two teams'
   * actual palettes. Without them (they were missing until 2026-08-28)
   * "evoke the teams through colour" is an instruction the model can't
   * follow, and it falls back to stock neon arena art.
   */
  context: {
    sportName: string | null;
    sportSlug: string | null;
    tournamentName: string | null;
    tournamentBrandColor: string | null;
    homeTeam: string | null;
    homeBrandColor: string | null;
    awayTeam: string | null;
    awayBrandColor: string | null;
    competitorName: string | null;
    competitorBrandColor: string | null;
  };
}

export interface BannerGenPendingResponse {
  jobs: BannerGenJob[];
  serverNow: string;
}

/** Upload cap for the finished graphic (base64 payload decodes to this). */
export const BANNER_GEN_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const BANNER_GEN_ALLOWED_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export interface ZillaBoostBannerOutcome {
  outcomeId: string;
  label: string;
  originalOdds: string;
  boostedOdds: string;
}

/** market-scope rule → ZillaFlash-style offer card. */
export interface ZillaBoostMarketBanner {
  ruleId: string;
  boostPct: number;
  endsAt: string | null;
  /** AI-generated graphic, when the rule has one (migration 0089). */
  imageUrl?: string | null;
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  sportSlug: string;
  status: string;
  marketId: string;
  marketLabel: string;
  outcomes: ZillaBoostBannerOutcome[];
}

/** match-scope rule → scoreless match card with old + boosted winner prices. */
export interface ZillaBoostMatchBanner {
  ruleId: string;
  boostPct: number;
  endsAt: string | null;
  /** AI-generated graphic, when the rule has one (migration 0089). */
  imageUrl?: string | null;
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  homeLogoUrl: string | null;
  awayLogoUrl: string | null;
  sportSlug: string;
  status: string;
  scheduledAt: string | null;
  tournamentName: string;
  bestOf: number | null;
  /**
   * The match's MAIN priced market: match winner when active, else the
   * current map winner, else the first remaining active market. Null
   * only when nothing on the match is priced.
   */
  marketId: string | null;
  /** Display label of that market ("Match winner", "Map 3 winner", ...). */
  marketLabel: string | null;
  /**
   * True when outcomes 1/2 are the teams themselves (match / map
   * winner) — the card attaches the prices to the team rows. False =
   * arbitrary market; the card renders labeled outcome rows instead.
   */
  teamShaped: boolean;
  outcomes: ZillaBoostBannerOutcome[];
}

/**
 * sport-scope rule → ZillaBoost sport banner linking to the sport's
 * match list, plus the bolt icon beside that sport in the sidebar.
 *
 * Carries no odds: a sport-wide boost covers every market of every match
 * under it, so there is no single price to quote. Same shape as the
 * tournament banner for exactly that reason — both are "a boost is
 * running across this whole scope, go look" rather than an offer.
 */
export interface ZillaBoostSportBanner {
  ruleId: string;
  boostPct: number;
  endsAt: string | null;
  /** AI-generated graphic, when the rule has one (migration 0089). */
  imageUrl?: string | null;
  sportId: number;
  slug: string;
  name: string;
  logoUrl: string | null;
  brandColor: string | null;
  /** Bettable matches (live + upcoming with >= 1 active market). */
  matchCount: number;
}

/**
 * competitor-scope rule → ZillaBoost team banner linking to the team's
 * fixtures (`/sport/:slug?team=<id>`).
 *
 * Carries no odds for the same reason the sport and tournament banners
 * don't: the rule spans every match the team plays, so there is no
 * single price to quote. `teamOnly` is surfaced so the copy can say
 * whether the boost is on the team's own prices or the whole match.
 */
export interface ZillaBoostCompetitorBanner {
  ruleId: string;
  boostPct: number;
  endsAt: string | null;
  competitorId: number;
  name: string;
  abbreviation: string | null;
  logoUrl: string | null;
  brandColor: string | null;
  sportSlug: string;
  /** Bettable matches (live + upcoming with >= 1 active market). */
  matchCount: number;
  /** True when the rule only boosts this team's own outcomes. */
  teamOnly: boolean;
}

/** tournament-scope rule → ZillaBoost tournament banner linking to its match list. */
export interface ZillaBoostTournamentBanner {
  ruleId: string;
  boostPct: number;
  endsAt: string | null;
  /** AI-generated graphic, when the rule has one (migration 0089). */
  imageUrl?: string | null;
  tournamentId: number;
  name: string;
  sportSlug: string;
  logoUrl: string | null;
  brandColor: string | null;
  matchCount: number;
}

export interface ZillaBoostBannersResponse {
  /**
   * sport-scope rules → a home-page banner AND the bolt icon next to
   * the sport in the sidebar. (Before 2026-08-28 this was the bolt only,
   * so ticking "create promo banner" on a sport-wide boost appeared to
   * do nothing.)
   */
  sports: ZillaBoostSportBanner[];
  /** competitor-scope rules → team banners (migration 0093). */
  competitors: ZillaBoostCompetitorBanner[];
  tournaments: ZillaBoostTournamentBanner[];
  matches: ZillaBoostMatchBanner[];
  markets: ZillaBoostMarketBanner[];
  serverNow: string;
}
