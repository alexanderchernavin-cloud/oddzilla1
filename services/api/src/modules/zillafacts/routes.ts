// /catalog/matches/:matchId/zillafacts — per-(market, outcome, team)
// statistical streak cards rendered between the stream and the market
// tabs on the match-detail page. Surfaces only HARD streaks: the
// team's last N closed matches on the same market signature all
// landed the same directional result (won / half_won), where N ≥
// ZILLAFACT_MIN_STREAK.
//
// Where ZillaTips computes flat-stake ROI over the last 5 legs and
// surfaces anything above +20% (mixed W/L is fine), ZillaFacts is
// stricter: a single loss / void / unrated leg breaks the streak.
// The endpoint is keyed only off the match id and is public.
//
// The SQL shape mirrors ZillaTips' CTE — same outcome-team pairing,
// same role-swap logic for cross-match outcome equivalence, same
// {side}-specifier branch, same unsafe-market exclusion — but pulls
// up to ZILLAFACT_LOOKBACK_LEGS per team and returns one JSON row
// per (market, outcome, team). The streak walker in TS counts the
// consecutive-from-newest prefix of won/half_won results and filters
// to streak ≥ ZILLAFACT_MIN_STREAK. The composite score
// `streak × ln(currentOdds)` drives both sort and tier (base / glow /
// fire). Current odds come from the live match's market_outcomes row.
//
// Caching: 5-minute Redis TTL, key `zillafacts:v1:{matchId}`. Same
// rationale as ZillaTips — the underlying data only shifts on new
// settlements involving one of the two teams, so a 5-min window is
// fresh enough that no user perceives staleness.

import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  ZILLAFACT_LOOKBACK_DAYS,
  ZILLAFACT_LOOKBACK_LEGS,
  ZILLAFACT_MAX_CARDS,
  ZILLAFACT_MIN_STREAK,
  zillaFactScore,
  type ZillaFact,
  type ZillaFactLeg,
  type ZillaFactResult,
  type ZillaFactRole,
  type ZillaFactsResponse,
} from "@oddzilla/types";
import { cached } from "../../lib/cache.js";
import {
  substituteTemplate,
  renderOutcomeLabel,
} from "../../lib/market-naming.js";

// Raw SQL row shape — one row per qualifying (market, outcome, team)
// candidate. The streak walker in TS reads `legsJson` (newest-first
// JSON array of leg records) and counts the consecutive prefix of
// won/half_won. Rows whose streak doesn't clear ZILLAFACT_MIN_STREAK
// are dropped before any further work.
interface CandidateRow extends Record<string, unknown> {
  marketId: string;
  outcomeId: string;
  providerMarketId: number;
  variant: string;
  specifiersJson: Record<string, string>;
  matchHomeTeam: string;
  matchAwayTeam: string;
  marketDescTemplate: string | null;
  outcomeDescTemplate: string | null;
  rawOutcomeName: string | null;
  currentOdds: string | null;
  teamId: number;
  teamRole: ZillaFactRole;
  teamName: string;
  teamLogoUrl: string | null;
  teamBrandColor: string | null;
  legsJson: unknown;
}

// One historical leg as carried inside `legsJson`. Result and
// prematchOdds are nullable because pre-migration-0047 closed matches
// have no snapshot; the streak walker treats unrated wins as a break
// so they don't silently inflate streak length.
interface RawLeg {
  histMatchId: string;
  histHomeId: number | null;
  histAwayId: number | null;
  histHomeLabel: string;
  histAwayLabel: string;
  teamRoleHist: ZillaFactRole;
  equivOutcomeId: string;
  prematchOdds: string | null;
  result: ZillaFactResult | null;
  liveStartedAt: string;
  scheduledAt: string | null;
}

const CACHE_TTL_SECONDS = 300;

// Specifier keys Oddin uses to ladder a market into a family of lines.
// Mirror of catalog/routes.ts' LINE_SPECIFIERS — kept local so the
// dedup helper doesn't reach into the catalog module's internals.
// `handicap` is still in the unsafe_markets exclusion so it never
// reaches the dedup pass, but keeping it here means a future relaxation
// of that filter Just Works without two-places-to-update.
const LINE_SPECIFIERS = ["threshold", "handicap"] as const;

// Plain-English sentence for a streak fact. Handles the most common
// market shapes individually (Match Winner, Map Winner, Over / Under
// totals, parity, Yes / No) and falls back to a generic template
// when the outcome doesn't fit one of the canned patterns. The
// frontend renders this verbatim so the storefront doesn't have to
// reason about Oddin's market taxonomy.
function composeStreakFactText(args: {
  teamName: string;
  streak: number;
  marketName: string;
  outcomeLabel: string;
  providerMarketId: number;
  specifiers: Record<string, string>;
}): string {
  const { teamName, streak, marketName, outcomeLabel, providerMarketId, specifiers } = args;
  const olc = outcomeLabel.trim().toLowerCase();

  // Match Winner — outcome 1/2 maps to home/away, label resolves to
  // the team name (substituteTemplate handles the "home" / "away"
  // token). Speak about the team directly.
  if (providerMarketId === 1) {
    return `${teamName} have won their last ${streak} matches`;
  }
  // Map Winner — per-map version of the same shape.
  if (providerMarketId === 4) {
    const mapHint = specifiers.map ? `Map ${specifiers.map}` : "the map";
    return `${teamName} have won ${mapHint} in their last ${streak} matches`;
  }

  // Over / Under threshold markets. outcomeLabel comes through as
  // "Over" or "Under"; the threshold value is in specifiers.
  if (specifiers.threshold && (olc === "over" || olc === "under")) {
    const topic = stripThreshold(marketName, specifiers.threshold);
    const direction = olc === "over" ? "Over" : "Under";
    return `${teamName}'s last ${streak} matches went ${direction} ${specifiers.threshold} ${topic.toLowerCase()}`.trim().replace(/\s+/g, " ");
  }

  // Parity (Odd / Even). outcomeLabel is literally "Odd" or "Even".
  if (olc === "odd" || olc === "even") {
    return `${capitalize(marketName.toLowerCase())} came back ${olc} in ${teamName}'s last ${streak} matches`;
  }

  // Yes / No. The verb depends on direction — "Yes" reads as "had
  // X happen", "No" as "had no X".
  if (olc === "yes") {
    return `${capitalize(marketName.toLowerCase())} hit in ${teamName}'s last ${streak} matches`;
  }
  if (olc === "no") {
    return `No ${marketName.toLowerCase()} in ${teamName}'s last ${streak} matches`;
  }

  // Fallback for everything else (positional outcomes beyond 1/2,
  // novel symmetric outcomes, etc.) — readable enough without
  // over-fitting per-market wording.
  return `${capitalize(marketName.toLowerCase())} — ${outcomeLabel} — in ${teamName}'s last ${streak} matches`;
}

function stripThreshold(marketName: string, threshold: string): string {
  // Regex-escape the threshold value so a literal "1.5" doesn't
  // become a regex metachar. Strip it out and tidy up the spacing
  // and any leftover separator characters.
  const escaped = threshold.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return marketName
    .replace(new RegExp(`\\b${escaped}\\b`), "")
    .replace(/\s+/g, " ")
    .replace(/^[-–·\s]+|[-–·\s]+$/g, "")
    .trim();
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

// Group key for line-family collapse. Two markets sit in the same
// family iff they share (providerMarketId, variant, every-other-
// specifier) and differ ONLY in the value of one of the LINE_SPECIFIERS
// keys. Returns null when no line specifier is present — markets in
// that case are single-shot and don't collapse with anything.
//
// Format mirrors catalog/routes.ts' lineInfo so an admin who knows the
// storefront's line-family grouping recognises the shape immediately.
function lineFamilyKey(
  providerMarketId: number,
  variant: string,
  specifiers: Record<string, string>,
): string | null {
  for (const key of LINE_SPECIFIERS) {
    const v = specifiers[key];
    if (v == null || v === "") continue;
    const rest = Object.entries(specifiers)
      .filter(([k]) => k !== key)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, val]) => `${k}=${val}`)
      .join("|");
    return `${providerMarketId}|${variant}|${rest}|line=${key}`;
  }
  return null;
}

export default async function zillafactsRoutes(app: FastifyInstance) {
  app.get("/catalog/matches/:matchId/zillafacts", async (request) => {
    const { matchId } = z
      .object({ matchId: z.coerce.bigint() })
      .parse(request.params);
    // v3: live matches with completed periods switch from streak
    // facts to in-match conditional facts ("After winning Map 1,
    // team has won the match in their last N starts"). Streak
    // shape extended with a server-composed `factText` sentence.
    // Bump key so cached v2 responses drain.
    const cacheKey = `zillafacts:v3:${matchId.toString()}`;
    return cached<ZillaFactsResponse>(
      app.redis,
      cacheKey,
      CACHE_TTL_SECONDS,
      () => loadFacts(app, matchId),
    );
  });
}

// Outer entrypoint: fetch match metadata, dispatch to the right
// fact path, cap the result. Live matches with at least one
// completed map run the conditional-fact catalog (predicates over
// the current in-match state); everything else (prematch, live-
// with-zero-completed-maps, suspended, closed) falls back to the
// streak path — which still reads as "this team is on a 7-match
// run on Total Kills Under 45.5" until the first map settles.
async function loadFacts(
  app: FastifyInstance,
  matchId: bigint,
): Promise<ZillaFactsResponse> {
  const meta = await fetchMatchMeta(app, matchId);
  if (!meta) return { matchId: matchId.toString(), facts: [] };

  const facts = hasCompletedPeriod(meta.liveScore) && meta.status === "live"
    ? await loadConditionalFacts(app, meta)
    : await loadStreakFacts(app, meta);

  // Final cap — both paths sort by score before returning, so this
  // is a guarantee, not a re-sort. Anything past this clutters the
  // band and the storefront would only render the first 6 anyway.
  return {
    matchId: matchId.toString(),
    facts: facts.slice(0, ZILLAFACT_MAX_CARDS),
  };
}

interface MatchMeta {
  matchId: bigint;
  homeCompetitorId: number;
  awayCompetitorId: number;
  homeTeam: string;
  awayTeam: string;
  sportId: number;
  sportSlug: string;
  bestOf: number | null;
  status: string;
  liveScore: LiveScore | null;
}

interface LiveScore {
  home: number | null;
  away: number | null;
  status: number | null;
  currentMap: number | null;
  periods: Period[] | null;
}

interface Period {
  number: number | null;
  type: string | null;
  matchStatusCode: number | null;
  homeScore: number | null;
  awayScore: number | null;
  homeWonRounds: number | null;
  awayWonRounds: number | null;
  homeKills: number | null;
  awayKills: number | null;
  isLive: boolean | null;
}

async function fetchMatchMeta(
  app: FastifyInstance,
  matchId: bigint,
): Promise<MatchMeta | null> {
  const rows = await app.db.execute<{
    homeCompetitorId: number | null;
    awayCompetitorId: number | null;
    homeTeam: string;
    awayTeam: string;
    sportId: number;
    sportSlug: string;
    bestOf: number | null;
    status: string;
    liveScore: unknown;
  }>(sql`
    SELECT
      m.home_competitor_id AS "homeCompetitorId",
      m.away_competitor_id AS "awayCompetitorId",
      m.home_team          AS "homeTeam",
      m.away_team          AS "awayTeam",
      cat.sport_id         AS "sportId",
      s.slug               AS "sportSlug",
      m.best_of            AS "bestOf",
      m.status::text       AS "status",
      m.live_score         AS "liveScore"
    FROM matches m
    JOIN tournaments t ON t.id = m.tournament_id
    JOIN categories cat ON cat.id = t.category_id
    JOIN sports s ON s.id = cat.sport_id
    WHERE m.id = ${matchId}
  `);
  const row = rows[0];
  if (!row) return null;
  if (row.homeCompetitorId == null || row.awayCompetitorId == null) return null;
  return {
    matchId,
    homeCompetitorId: row.homeCompetitorId,
    awayCompetitorId: row.awayCompetitorId,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    sportId: row.sportId,
    sportSlug: row.sportSlug,
    bestOf: row.bestOf,
    status: row.status,
    liveScore: (row.liveScore as LiveScore | null) ?? null,
  };
}

// A "completed period" is one Oddin marked with a terminal map status
// code (UOF >= 50 is ended-states across sport-specific codes —
// matches handler/livescore.go's filter for "this map is done").
// Falls back to comparing isLive flags so the check tolerates brokers
// that don't ship a code.
function hasCompletedPeriod(ls: LiveScore | null): boolean {
  if (!ls || !ls.periods) return false;
  return ls.periods.some((p) => {
    if (p.matchStatusCode != null && p.matchStatusCode >= 50) return true;
    // Some sports never ship the code; treat any period with finalised
    // homeScore/awayScore values AND no live flag as completed.
    return (
      p.isLive === false &&
      p.homeScore != null &&
      p.awayScore != null &&
      (p.homeScore > 0 || p.awayScore > 0)
    );
  });
}

async function loadStreakFacts(
  app: FastifyInstance,
  meta: MatchMeta,
): Promise<ZillaFact[]> {
  const matchId = meta.matchId;
  // The big CTE. Reads top-down:
  //
  // current_match        — anchors home / away competitor ids + sport
  //                        and stamps both team labels onto every
  //                        downstream row so the outer SELECT can
  //                        render market + outcome strings without
  //                        a second join back to matches.
  // current_markets      — every active market on the open match,
  //                        excluding handicap / correct-score
  //                        templates (same `unsafe_markets` filter
  //                        ZillaTips uses).
  // outcome_team_pairs   — explode each market × outcome to the
  //                        team it relates to. Positional outcomes
  //                        1/2 → single team; symmetric outcomes
  //                        (Over / Under, Yes / No, Odd / Even) →
  //                        both teams; {side}-specifier markets →
  //                        side team only.
  // historical_per_pair  — LATERAL: each team's last N closed matches
  //                        with the same (provider_market_id,
  //                        specifiers_hash) signature (or the
  //                        cross-side variant for {side} markets).
  //                        equiv_outcome_id swaps 1↔2 when the team's
  //                        role differs across matches so the lookup
  //                        stays pointed at "this team's perspective".
  // legs_raw             — hydrate prematch_odds + result from the
  //                        past market_outcomes row.
  // legs_agg             — jsonb_agg into newest-first order, one
  //                        row per (market, outcome, team).
  //
  // The outer SELECT joins to market_descriptions / outcome_descriptions
  // for pre-rendered display strings and to competitors for the
  // team-of-interest's branding (logo + brand colour). Opponents'
  // branding fans out in a second pass to keep this query bounded.
  const rows = await app.db.execute<CandidateRow>(sql`
    WITH
    unsafe_markets AS (
      SELECT DISTINCT provider_market_id
      FROM market_descriptions
      WHERE name_template ILIKE '%handicap%'
         OR name_template ILIKE '%correct%score%'
    ),
    current_match AS (
      SELECT
        m.id,
        m.home_competitor_id,
        m.away_competitor_id,
        m.home_team,
        m.away_team,
        cat.sport_id AS sport_id
      FROM matches m
      JOIN tournaments t ON t.id = m.tournament_id
      JOIN categories cat ON cat.id = t.category_id
      WHERE m.id = ${matchId}
        AND m.home_competitor_id IS NOT NULL
        AND m.away_competitor_id IS NOT NULL
    ),
    current_markets AS (
      SELECT
        mk.id AS market_id,
        mk.provider_market_id,
        -- variant is held inside specifiers_json (Oddin convention,
        -- see catalog/routes.ts where the storefront does the same
        -- COALESCE). The markets table has no variant column; the
        -- value is the join key into market_descriptions /
        -- outcome_descriptions and falls back to empty string when
        -- the market has no variant.
        COALESCE(mk.specifiers_json->>'variant', '') AS variant,
        mk.specifiers_hash,
        mk.specifiers_json,
        cm.id AS current_match_id,
        cm.home_competitor_id,
        cm.away_competitor_id,
        cm.home_team,
        cm.away_team,
        cm.sport_id AS current_sport_id
      FROM markets mk
      CROSS JOIN current_match cm
      WHERE mk.match_id = cm.id
        AND mk.status = 1
        AND mk.provider_market_id NOT IN (SELECT provider_market_id FROM unsafe_markets)
    ),
    outcome_team_pairs AS (
      SELECT
        cms.market_id,
        cms.provider_market_id,
        cms.variant,
        cms.specifiers_hash,
        cms.specifiers_json,
        cms.home_team,
        cms.away_team,
        cms.current_sport_id,
        mo.outcome_id,
        mo.name AS raw_outcome_name,
        mo.published_odds AS current_odds,
        team.competitor_id AS team_id,
        team.role
      FROM current_markets cms
      JOIN market_outcomes mo
        ON mo.market_id = cms.market_id
       AND mo.active = TRUE
      CROSS JOIN LATERAL (
        VALUES
          (cms.home_competitor_id, 'home'::text),
          (cms.away_competitor_id, 'away'::text)
      ) AS team(competitor_id, role)
      WHERE
        (
          cms.specifiers_json ? 'side'
          AND team.role = cms.specifiers_json->>'side'
        )
        OR (
          NOT (cms.specifiers_json ? 'side')
          AND mo.outcome_id IN ('1', '2')
          AND (
            (mo.outcome_id = '1' AND team.role = 'home')
            OR (mo.outcome_id = '2' AND team.role = 'away')
          )
        )
        -- Symmetric outcomes pair with both teams — ZillaFacts emits
        -- one card per team's streak (different from ZillaTips, which
        -- combines them into one ROI).
        OR (
          NOT (cms.specifiers_json ? 'side')
          AND mo.outcome_id IN ('4', '5', '6', '7', '60', '61')
        )
    ),
    historical_per_pair AS (
      SELECT
        otp.market_id AS current_market_id,
        otp.provider_market_id,
        otp.variant,
        otp.specifiers_json,
        otp.home_team,
        otp.away_team,
        otp.outcome_id AS current_outcome_id,
        otp.raw_outcome_name,
        otp.current_odds,
        otp.team_id,
        otp.role,
        h.match_id AS hist_match_id,
        h.hist_home_id,
        h.hist_away_id,
        h.hist_home_label,
        h.hist_away_label,
        h.live_started_at,
        h.scheduled_at,
        h.hist_market_id,
        h.team_role_hist,
        CASE
          WHEN otp.outcome_id IN ('1', '2')
           AND h.team_role_hist <> otp.role
           AND NOT (otp.specifiers_json ? 'side')
          THEN CASE otp.outcome_id
                 WHEN '1' THEN '2'
                 WHEN '2' THEN '1'
               END
          ELSE otp.outcome_id
        END AS equiv_outcome_id
      FROM outcome_team_pairs otp
      CROSS JOIN LATERAL (
        SELECT
          hm.id AS match_id,
          hm.home_competitor_id AS hist_home_id,
          hm.away_competitor_id AS hist_away_id,
          hm.home_team AS hist_home_label,
          hm.away_team AS hist_away_label,
          hm.live_started_at,
          hm.scheduled_at,
          hmk.id AS hist_market_id,
          CASE
            WHEN hm.home_competitor_id = otp.team_id THEN 'home'::text
            ELSE 'away'::text
          END AS team_role_hist
        FROM matches hm
        JOIN tournaments ht ON ht.id = hm.tournament_id
        JOIN categories hcat ON hcat.id = ht.category_id
        JOIN markets hmk
          ON hmk.match_id = hm.id
         AND hmk.provider_market_id = otp.provider_market_id
         AND (
           (NOT (otp.specifiers_json ? 'side')
            AND hmk.specifiers_hash = otp.specifiers_hash)
           OR
           (otp.specifiers_json ? 'side'
            AND hmk.specifiers_json - 'side' = otp.specifiers_json - 'side'
            AND hmk.specifiers_json->>'side' = (
              CASE
                WHEN hm.home_competitor_id = otp.team_id THEN 'home'
                ELSE 'away'
              END
            ))
         )
        WHERE hm.status = 'closed'
          AND hm.live_started_at IS NOT NULL
          AND hm.live_started_at > NOW() - (${ZILLAFACT_LOOKBACK_DAYS}::int * INTERVAL '1 day')
          AND hcat.sport_id = otp.current_sport_id
          AND (hm.home_competitor_id = otp.team_id OR hm.away_competitor_id = otp.team_id)
          AND hm.id <> ${matchId}
        ORDER BY hm.live_started_at DESC
        LIMIT ${ZILLAFACT_LOOKBACK_LEGS}
      ) h
    ),
    legs_raw AS (
      SELECT
        hpp.current_market_id,
        hpp.provider_market_id,
        hpp.variant,
        hpp.specifiers_json,
        hpp.home_team,
        hpp.away_team,
        hpp.current_outcome_id,
        hpp.raw_outcome_name,
        hpp.current_odds,
        hpp.team_id,
        hpp.role,
        hpp.hist_match_id,
        hpp.hist_home_id,
        hpp.hist_away_id,
        hpp.hist_home_label,
        hpp.hist_away_label,
        hpp.live_started_at,
        hpp.scheduled_at,
        hpp.team_role_hist,
        hpp.equiv_outcome_id,
        hmo.prematch_odds,
        hmo.result::text AS result_text
      FROM historical_per_pair hpp
      LEFT JOIN market_outcomes hmo
        ON hmo.market_id = hpp.hist_market_id
       AND hmo.outcome_id = hpp.equiv_outcome_id
    ),
    legs_agg AS (
      SELECT
        current_market_id,
        provider_market_id,
        variant,
        specifiers_json,
        home_team,
        away_team,
        current_outcome_id,
        raw_outcome_name,
        current_odds,
        team_id,
        role,
        jsonb_agg(
          jsonb_build_object(
            'histMatchId', hist_match_id::text,
            'histHomeId', hist_home_id,
            'histAwayId', hist_away_id,
            'histHomeLabel', hist_home_label,
            'histAwayLabel', hist_away_label,
            'teamRoleHist', team_role_hist,
            'equivOutcomeId', equiv_outcome_id,
            'prematchOdds', prematch_odds,
            'result', result_text,
            'liveStartedAt', live_started_at,
            'scheduledAt', scheduled_at
          )
          -- DESC = newest first. The streak walker reads from index 0
          -- and stops at the first break, so newest-first means we
          -- always count "the streak the team is currently riding".
          ORDER BY live_started_at DESC
        ) AS legs_json
      FROM legs_raw
      GROUP BY
        current_market_id, provider_market_id, variant, specifiers_json,
        home_team, away_team, current_outcome_id, raw_outcome_name,
        current_odds, team_id, role
    )
    SELECT
      la.current_market_id::text                AS "marketId",
      la.current_outcome_id                     AS "outcomeId",
      la.provider_market_id                     AS "providerMarketId",
      la.variant                                AS "variant",
      la.specifiers_json                        AS "specifiersJson",
      la.home_team                              AS "matchHomeTeam",
      la.away_team                              AS "matchAwayTeam",
      md.name_template                          AS "marketDescTemplate",
      od.name_template                          AS "outcomeDescTemplate",
      la.raw_outcome_name                       AS "rawOutcomeName",
      la.current_odds                           AS "currentOdds",
      la.team_id                                AS "teamId",
      la.role                                   AS "teamRole",
      CASE
        WHEN la.role = 'home' THEN la.home_team
        ELSE la.away_team
      END                                       AS "teamName",
      c.logo_url                                AS "teamLogoUrl",
      c.brand_color                             AS "teamBrandColor",
      la.legs_json                              AS "legsJson"
    FROM legs_agg la
    LEFT JOIN market_descriptions md
      ON md.provider_market_id = la.provider_market_id
     AND md.variant = la.variant
    LEFT JOIN outcome_descriptions od
      ON od.provider_market_id = la.provider_market_id
     AND od.variant = la.variant
     AND od.outcome_id = la.current_outcome_id
    LEFT JOIN competitors c
      ON c.id = la.team_id
  `);

  // First pass: walk each candidate's legs newest-first and count the
  // consecutive prefix of wins. Drop anything below ZILLAFACT_MIN_STREAK.
  // Opponent ids get collected in a second pass after the line-family
  // dedup so we only hydrate branding for legs that actually ship.
  const survivors: Array<{
    row: CandidateRow;
    streak: number;
    streakLegs: RawLeg[];
  }> = [];

  for (const row of rows) {
    const legs = Array.isArray(row.legsJson) ? (row.legsJson as RawLeg[]) : [];
    let streak = 0;
    for (const leg of legs) {
      // Streak counts BOTH full and half wins. Any other result —
      // lost, half_lost, void, null, or unrated — breaks the streak.
      if (leg.result === "won" || leg.result === "half_won") {
        streak++;
      } else {
        break;
      }
    }
    if (streak < ZILLAFACT_MIN_STREAK) continue;
    const streakLegs = legs.slice(0, streak);
    survivors.push({ row, streak, streakLegs });
  }

  if (survivors.length === 0) {
    return [];
  }

  // Line-family collapse. Within the same (lineFamilyKey, outcomeId,
  // teamId, role) group — for instance "Total kills Under" on three
  // different threshold lines (45.5 / 46.5 / 47.5) — surface only the
  // highest-odds member. Rationale: streaks are typically identical
  // across same-direction sibling lines (a team consistently Under
  // 45.5 is also Under 46.5 and Under 47.5), so the line that adds
  // the most signal as a betting tip is the toughest one — i.e. the
  // highest odds. Tiebreak on odds-equality: longest streak.
  //
  // Markets without a line specifier (no threshold/handicap key in
  // specifiers) get a null family key and pass through unchanged via
  // the `single:` group prefix, so single-shot markets keep their own
  // bucket without colliding with other markets.
  const groupBest = new Map<string, (typeof survivors)[number]>();
  for (const s of survivors) {
    const specs = (s.row.specifiersJson ?? {}) as Record<string, string>;
    const fkey = lineFamilyKey(s.row.providerMarketId, s.row.variant, specs);
    const groupKey =
      fkey == null
        ? `single:${s.row.marketId}:${s.row.outcomeId}:${s.row.teamId}:${s.row.teamRole}`
        : `family:${fkey}:${s.row.outcomeId}:${s.row.teamId}:${s.row.teamRole}`;
    const existing = groupBest.get(groupKey);
    if (!existing) {
      groupBest.set(groupKey, s);
      continue;
    }
    const odds = s.row.currentOdds == null ? 0 : Number(s.row.currentOdds);
    const existingOdds =
      existing.row.currentOdds == null ? 0 : Number(existing.row.currentOdds);
    if (odds > existingOdds || (odds === existingOdds && s.streak > existing.streak)) {
      groupBest.set(groupKey, s);
    }
  }
  const dedupedSurvivors = Array.from(groupBest.values());

  // Second pass: opponent ids for the lines that survived dedup —
  // skipping the dropped sibling lines saves a small amount of brand-
  // lookup work and stops us shipping logos for legs that never get
  // rendered (the chosen line's legs may differ from a dropped sibling's
  // when a near-boundary match split the family).
  const opponentIds = new Set<number>();
  for (const { streakLegs } of dedupedSurvivors) {
    for (const leg of streakLegs) {
      const oppId =
        leg.teamRoleHist === "home" ? leg.histAwayId : leg.histHomeId;
      if (oppId != null) opponentIds.add(oppId);
    }
  }

  // One round-trip for every opponent's branding. Same array-literal
  // cast ZillaTips uses to bypass drizzle's positional tuple binding
  // (which can't be coerced to int[]).
  const brandById = new Map<
    number,
    { logoUrl: string | null; brandColor: string | null }
  >();
  if (opponentIds.size > 0) {
    const opponentIdsLiteral = `{${Array.from(opponentIds).join(",")}}`;
    const brandRows = await app.db.execute<{
      id: number;
      logoUrl: string | null;
      brandColor: string | null;
    }>(sql`
      SELECT id, logo_url AS "logoUrl", brand_color AS "brandColor"
      FROM competitors
      WHERE id = ANY(${opponentIdsLiteral}::int[])
    `);
    for (const b of brandRows) {
      brandById.set(Number(b.id), {
        logoUrl: b.logoUrl,
        brandColor: b.brandColor,
      });
    }
  }

  const facts: ZillaFact[] = dedupedSurvivors.map(({ row, streak, streakLegs }) => {
    const specs = (row.specifiersJson ?? {}) as Record<string, string>;
    const matchHome = row.matchHomeTeam;
    const matchAway = row.matchAwayTeam;

    const marketTemplate =
      row.marketDescTemplate ?? `Market #${row.providerMarketId}`;
    const marketName = substituteTemplate(marketTemplate, specs, {
      homeTeam: matchHome,
      awayTeam: matchAway,
    });
    const outcomeTemplate =
      row.outcomeDescTemplate ?? row.rawOutcomeName ?? row.outcomeId;
    const outcomeLabel = renderOutcomeLabel(
      outcomeTemplate,
      specs,
      matchHome,
      matchAway,
    );

    const currentOddsNum =
      row.currentOdds == null ? null : Number(row.currentOdds);
    const usableOdds =
      currentOddsNum != null &&
      Number.isFinite(currentOddsNum) &&
      currentOddsNum > 1
        ? currentOddsNum
        : null;
    const score = zillaFactScore(streak, usableOdds);

    const legs: ZillaFactLeg[] = streakLegs.map((leg) => {
      const oppId =
        leg.teamRoleHist === "home" ? leg.histAwayId : leg.histHomeId;
      const brand = oppId != null ? brandById.get(oppId) : undefined;
      return {
        histMatchId: leg.histMatchId,
        teamRoleHist: leg.teamRoleHist,
        opponentLabel:
          leg.teamRoleHist === "home"
            ? leg.histAwayLabel
            : leg.histHomeLabel,
        opponentLogoUrl: brand?.logoUrl ?? null,
        opponentBrandColor: brand?.brandColor ?? null,
        prematchOdds: leg.prematchOdds,
        result: leg.result,
        equivOutcomeId: leg.equivOutcomeId,
        liveStartedAt: leg.liveStartedAt,
        scheduledAt: leg.scheduledAt,
      };
    });

    const factText = composeStreakFactText({
      teamName: row.teamName,
      streak,
      marketName,
      outcomeLabel,
      providerMarketId: row.providerMarketId,
      specifiers: specs,
    });

    return {
      marketId: row.marketId,
      outcomeId: row.outcomeId,
      teamId: Number(row.teamId),
      teamName: row.teamName,
      teamRole: row.teamRole,
      teamLogoUrl: row.teamLogoUrl,
      teamBrandColor: row.teamBrandColor,
      marketName,
      outcomeLabel,
      factText,
      streak,
      currentOdds:
        usableOdds != null ? usableOdds.toFixed(2) : row.currentOdds ?? null,
      score,
      legs,
    };
  });

  // Highest-impact facts first. Within the same score, longer streaks
  // win the tiebreak (more "certain"); within identical score AND
  // streak, higher current-odds tiebreaks for "more interesting line".
  facts.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.streak !== a.streak) return b.streak - a.streak;
    const ao = a.currentOdds == null ? 0 : Number(a.currentOdds);
    const bo = b.currentOdds == null ? 0 : Number(b.currentOdds);
    return bo - ao;
  });

  return facts;
}

// ── Live conditional facts ────────────────────────────────────────────
//
// Live matches replace the streak-based facts with predicates tied
// to the current in-match state — "After winning Map 1, team has
// won the match in their last N starts". The pattern catalog below
// runs against each team independently: for each pattern, evaluate
// the CURRENT predicate against the live match's `live_score`, and
// if it's TRUE, walk the team's recent closed matches looking for
// the same predicate. Among matches where the predicate held, count
// the consecutive-from-newest streak where the OUTCOME held; surface
// when the streak clears ZILLAFACT_MIN_STREAK.
//
// Each pattern names a TARGET market on the open match — e.g. Match
// Winner / Map Winner Map 2 — so the surfaced card attaches to a
// live odds button the user can click into. Patterns whose target
// market isn't currently offered (suspended, not listed) are dropped.

// What goes into evaluating one historical leg.
interface PastMatch {
  matchId: string;
  teamRole: ZillaFactRole; // role of the focused team in THIS past match
  liveScore: LiveScore;
  liveStartedAt: string;
  homeTeam: string;
  awayTeam: string;
}

// Pattern shape. `current` decides whether the pattern applies to
// the CURRENT in-match state for a given team role; `historical`
// is the same predicate against a past match; `outcome` is the
// metric we're proving from history; `target` picks which market
// on the open match the fact attaches to.
interface ConditionalPattern {
  id: string;
  // Restrict to specific sports when the pattern needs sport-specific
  // shape (e.g. round-margin patterns only make sense for CS2 /
  // Valorant). Null/undefined = applies to every sport.
  sports?: string[];
  current: (
    ls: LiveScore,
    role: ZillaFactRole,
  ) => { applicable: boolean; conditionText: string };
  historical: (m: PastMatch) => boolean;
  outcome: (m: PastMatch) => "won" | "lost" | "void" | null;
  target: (role: ZillaFactRole) => {
    providerMarketId: number;
    outcomeId: string;
    specifierMatch?: (specs: Record<string, string>) => boolean;
  };
  formatFact: (
    teamName: string,
    streak: number,
    conditionText: string,
  ) => string;
}

// Predicate helpers shared across patterns.
function findPeriod(ls: LiveScore | null, n: number): Period | null {
  if (!ls || !ls.periods) return null;
  return ls.periods.find((p) => p.number === n) ?? null;
}

function periodIsComplete(p: Period | null): boolean {
  if (!p) return false;
  if (p.matchStatusCode != null && p.matchStatusCode >= 50) return true;
  return (
    p.isLive === false &&
    p.homeScore != null &&
    p.awayScore != null &&
    (p.homeScore > 0 || p.awayScore > 0)
  );
}

function wonMap(p: Period | null, role: ZillaFactRole): boolean {
  if (!periodIsComplete(p)) return false;
  if (p!.homeScore == null || p!.awayScore == null) return false;
  return role === "home"
    ? p!.homeScore > p!.awayScore
    : p!.awayScore > p!.homeScore;
}

function lostMap(p: Period | null, role: ZillaFactRole): boolean {
  if (!periodIsComplete(p)) return false;
  if (p!.homeScore == null || p!.awayScore == null) return false;
  return role === "home"
    ? p!.awayScore > p!.homeScore
    : p!.homeScore > p!.awayScore;
}

function wonSeries(ls: LiveScore | null, role: ZillaFactRole): boolean {
  if (!ls || ls.home == null || ls.away == null) return false;
  return role === "home" ? ls.home > ls.away : ls.away > ls.home;
}

function map1RoundMargin(p: Period | null, role: ZillaFactRole): number | null {
  if (!periodIsComplete(p)) return null;
  if (p!.homeWonRounds == null || p!.awayWonRounds == null) return null;
  return role === "home"
    ? p!.homeWonRounds - p!.awayWonRounds
    : p!.awayWonRounds - p!.homeWonRounds;
}

function map1TotalRounds(p: Period | null): number | null {
  if (!periodIsComplete(p)) return null;
  if (p!.homeWonRounds == null || p!.awayWonRounds == null) return null;
  return p!.homeWonRounds + p!.awayWonRounds;
}

const ROUND_SPORTS = ["cs2", "valorant"];

// Catalog. Twelve patterns at v1; round-margin + overtime patterns
// gate on round-based sports. Order doesn't matter — every pattern
// runs against every team and only surviving cards rank by score.
const CONDITIONAL_PATTERNS: ConditionalPattern[] = [
  // 1. Won Map 1 → won match
  {
    id: "won_m1_won_match",
    current: (ls, role) => {
      const won = wonMap(findPeriod(ls, 1), role);
      return { applicable: won, conditionText: "After winning Map 1" };
    },
    historical: (m) => wonMap(findPeriod(m.liveScore, 1), m.teamRole),
    outcome: (m) => (wonSeries(m.liveScore, m.teamRole) ? "won" : "lost"),
    target: (role) => ({ providerMarketId: 1, outcomeId: role === "home" ? "1" : "2" }),
    formatFact: (team, streak, cond) =>
      `${cond}, ${team} have won the match in their last ${streak} starts`,
  },
  // 2. Won Map 1 → won Map 2
  {
    id: "won_m1_won_m2",
    current: (ls, role) => {
      const won = wonMap(findPeriod(ls, 1), role);
      return { applicable: won, conditionText: "After winning Map 1" };
    },
    historical: (m) =>
      wonMap(findPeriod(m.liveScore, 1), m.teamRole) &&
      periodIsComplete(findPeriod(m.liveScore, 2)),
    outcome: (m) => (wonMap(findPeriod(m.liveScore, 2), m.teamRole) ? "won" : "lost"),
    target: (role) => ({
      providerMarketId: 4,
      outcomeId: role === "home" ? "1" : "2",
      specifierMatch: (specs) => specs.map === "2",
    }),
    formatFact: (team, streak, cond) =>
      `${cond}, ${team} have taken Map 2 in their last ${streak} starts`,
  },
  // 3. Lost Map 1 → won match (comeback)
  {
    id: "lost_m1_won_match",
    current: (ls, role) => {
      const lost = lostMap(findPeriod(ls, 1), role);
      return { applicable: lost, conditionText: "After dropping Map 1" };
    },
    historical: (m) => lostMap(findPeriod(m.liveScore, 1), m.teamRole),
    outcome: (m) => (wonSeries(m.liveScore, m.teamRole) ? "won" : "lost"),
    target: (role) => ({ providerMarketId: 1, outcomeId: role === "home" ? "1" : "2" }),
    formatFact: (team, streak, cond) =>
      `${cond}, ${team} have come back to win the match ${streak} times in a row`,
  },
  // 4. Lost Map 1 → won Map 2 (must-win)
  {
    id: "lost_m1_won_m2",
    current: (ls, role) => {
      const lost = lostMap(findPeriod(ls, 1), role);
      return { applicable: lost, conditionText: "After dropping Map 1" };
    },
    historical: (m) =>
      lostMap(findPeriod(m.liveScore, 1), m.teamRole) &&
      periodIsComplete(findPeriod(m.liveScore, 2)),
    outcome: (m) => (wonMap(findPeriod(m.liveScore, 2), m.teamRole) ? "won" : "lost"),
    target: (role) => ({
      providerMarketId: 4,
      outcomeId: role === "home" ? "1" : "2",
      specifierMatch: (specs) => specs.map === "2",
    }),
    formatFact: (team, streak, cond) =>
      `${cond}, ${team} have taken Map 2 ${streak} times in a row`,
  },
  // 5. Won Map 2 → won match
  {
    id: "won_m2_won_match",
    current: (ls, role) => {
      const won = wonMap(findPeriod(ls, 2), role);
      return { applicable: won, conditionText: "After winning Map 2" };
    },
    historical: (m) => wonMap(findPeriod(m.liveScore, 2), m.teamRole),
    outcome: (m) => (wonSeries(m.liveScore, m.teamRole) ? "won" : "lost"),
    target: (role) => ({ providerMarketId: 1, outcomeId: role === "home" ? "1" : "2" }),
    formatFact: (team, streak, cond) =>
      `${cond}, ${team} have closed out the match in their last ${streak} starts`,
  },
  // 6. Split first two maps (1-1) → won match
  {
    id: "split_m1_m2_won_match",
    current: (ls, role) => {
      const p1 = findPeriod(ls, 1);
      const p2 = findPeriod(ls, 2);
      if (!periodIsComplete(p1) || !periodIsComplete(p2)) {
        return { applicable: false, conditionText: "" };
      }
      const wp1 = wonMap(p1, role);
      const wp2 = wonMap(p2, role);
      const split = (wp1 && !wp2) || (!wp1 && wp2);
      return { applicable: split, conditionText: "After splitting the first two maps" };
    },
    historical: (m) => {
      const p1 = findPeriod(m.liveScore, 1);
      const p2 = findPeriod(m.liveScore, 2);
      if (!periodIsComplete(p1) || !periodIsComplete(p2)) return false;
      const wp1 = wonMap(p1, m.teamRole);
      const wp2 = wonMap(p2, m.teamRole);
      return (wp1 && !wp2) || (!wp1 && wp2);
    },
    outcome: (m) => (wonSeries(m.liveScore, m.teamRole) ? "won" : "lost"),
    target: (role) => ({ providerMarketId: 1, outcomeId: role === "home" ? "1" : "2" }),
    formatFact: (team, streak, cond) =>
      `${cond}, ${team} have won the decider in their last ${streak} matches`,
  },
  // 7. Up 2-0 in BO5+ → won match (closeout)
  {
    id: "up_2_0_won_match",
    current: (ls, role) => {
      const p1 = findPeriod(ls, 1);
      const p2 = findPeriod(ls, 2);
      if (!periodIsComplete(p1) || !periodIsComplete(p2)) {
        return { applicable: false, conditionText: "" };
      }
      const up = wonMap(p1, role) && wonMap(p2, role);
      return { applicable: up, conditionText: "Up 2-0" };
    },
    historical: (m) => {
      const p1 = findPeriod(m.liveScore, 1);
      const p2 = findPeriod(m.liveScore, 2);
      return (
        periodIsComplete(p1) &&
        periodIsComplete(p2) &&
        wonMap(p1, m.teamRole) &&
        wonMap(p2, m.teamRole)
      );
    },
    outcome: (m) => (wonSeries(m.liveScore, m.teamRole) ? "won" : "lost"),
    target: (role) => ({ providerMarketId: 1, outcomeId: role === "home" ? "1" : "2" }),
    formatFact: (team, streak, cond) =>
      `${cond}, ${team} have closed out the series in their last ${streak} starts`,
  },
  // 8. Won Map 1 by ≥10 rounds (CS2 / Valorant) → won match
  {
    id: "won_m1_by_10_won_match",
    sports: ROUND_SPORTS,
    current: (ls, role) => {
      const margin = map1RoundMargin(findPeriod(ls, 1), role);
      return {
        applicable: margin != null && margin >= 10,
        conditionText: "After a 10+ round Map 1 win",
      };
    },
    historical: (m) => {
      const margin = map1RoundMargin(findPeriod(m.liveScore, 1), m.teamRole);
      return margin != null && margin >= 10;
    },
    outcome: (m) => (wonSeries(m.liveScore, m.teamRole) ? "won" : "lost"),
    target: (role) => ({ providerMarketId: 1, outcomeId: role === "home" ? "1" : "2" }),
    formatFact: (team, streak, cond) =>
      `${cond}, ${team} have gone on to win the match in their last ${streak} starts`,
  },
  // 9. Map 1 went into overtime AND team won it → won match
  {
    id: "won_m1_ot_won_match",
    sports: ROUND_SPORTS,
    current: (ls, role) => {
      const p1 = findPeriod(ls, 1);
      const total = map1TotalRounds(p1);
      const won = wonMap(p1, role);
      return {
        applicable: total != null && total > 30 && won,
        conditionText: "After surviving Map 1 overtime",
      };
    },
    historical: (m) => {
      const p1 = findPeriod(m.liveScore, 1);
      const total = map1TotalRounds(p1);
      return total != null && total > 30 && wonMap(p1, m.teamRole);
    },
    outcome: (m) => (wonSeries(m.liveScore, m.teamRole) ? "won" : "lost"),
    target: (role) => ({ providerMarketId: 1, outcomeId: role === "home" ? "1" : "2" }),
    formatFact: (team, streak, cond) =>
      `${cond}, ${team} have closed out the match in their last ${streak} starts`,
  },
  // 10. Won Map 1 close (≤5-round margin) → won match (the cling-on)
  {
    id: "won_m1_close_won_match",
    sports: ROUND_SPORTS,
    current: (ls, role) => {
      const margin = map1RoundMargin(findPeriod(ls, 1), role);
      const won = wonMap(findPeriod(ls, 1), role);
      return {
        applicable: won && margin != null && margin <= 5,
        conditionText: "After grinding out Map 1",
      };
    },
    historical: (m) => {
      const margin = map1RoundMargin(findPeriod(m.liveScore, 1), m.teamRole);
      return (
        wonMap(findPeriod(m.liveScore, 1), m.teamRole) &&
        margin != null &&
        margin <= 5
      );
    },
    outcome: (m) => (wonSeries(m.liveScore, m.teamRole) ? "won" : "lost"),
    target: (role) => ({ providerMarketId: 1, outcomeId: role === "home" ? "1" : "2" }),
    formatFact: (team, streak, cond) =>
      `${cond}, ${team} have gone on to win the match in their last ${streak} starts`,
  },
  // 11. Lost Map 1 by ≥10 rounds → won match (the comeback)
  {
    id: "lost_m1_by_10_won_match",
    sports: ROUND_SPORTS,
    current: (ls, role) => {
      const margin = map1RoundMargin(findPeriod(ls, 1), role);
      return {
        applicable: margin != null && margin <= -10,
        conditionText: "After a 10+ round Map 1 loss",
      };
    },
    historical: (m) => {
      const margin = map1RoundMargin(findPeriod(m.liveScore, 1), m.teamRole);
      return margin != null && margin <= -10;
    },
    outcome: (m) => (wonSeries(m.liveScore, m.teamRole) ? "won" : "lost"),
    target: (role) => ({ providerMarketId: 1, outcomeId: role === "home" ? "1" : "2" }),
    formatFact: (team, streak, cond) =>
      `${cond}, ${team} have come back to win the match in their last ${streak} starts`,
  },
  // 12. Won Map 1 → match goes the distance (2-1 in BO3)
  {
    id: "won_m1_to_decider",
    current: (ls, role) => {
      const won = wonMap(findPeriod(ls, 1), role);
      return { applicable: won, conditionText: "After winning Map 1" };
    },
    historical: (m) => wonMap(findPeriod(m.liveScore, 1), m.teamRole),
    outcome: (m) => {
      // "Went to decider" = at least 3 maps were played (BO3 split or BO5+).
      const p3 = findPeriod(m.liveScore, 3);
      return periodIsComplete(p3) ? "won" : "lost";
    },
    // No exact "match goes to decider" market we can target reliably —
    // skip target check on this one by pointing at Match Winner; the
    // pattern still produces interesting commentary but only when
    // Match Winner is offered.
    target: (role) => ({ providerMarketId: 1, outcomeId: role === "home" ? "1" : "2" }),
    formatFact: (team, streak, _cond) =>
      `${team}'s last ${streak} starts after winning Map 1 went to a deciding map`,
  },
];

// Active markets on the open match — pre-resolved so each pattern's
// target lookup is a plain TS find() rather than a fresh SQL hit.
interface CurrentMarket {
  marketId: string;
  providerMarketId: number;
  variant: string;
  specifiers: Record<string, string>;
  outcomes: Array<{
    outcomeId: string;
    rawName: string | null;
    descTemplate: string | null;
    publishedOdds: string | null;
    probability: string | null;
  }>;
  marketDescTemplate: string | null;
}

async function fetchCurrentMarkets(
  app: FastifyInstance,
  matchId: bigint,
): Promise<CurrentMarket[]> {
  const rows = await app.db.execute<{
    marketId: string;
    providerMarketId: number;
    variant: string;
    specifiersJson: Record<string, string>;
    marketDescTemplate: string | null;
    outcomeId: string;
    rawName: string | null;
    outcomeDescTemplate: string | null;
    publishedOdds: string | null;
    probability: string | null;
  }>(sql`
    SELECT
      mk.id::text                                                AS "marketId",
      mk.provider_market_id                                      AS "providerMarketId",
      COALESCE(mk.specifiers_json->>'variant', '')               AS "variant",
      mk.specifiers_json                                         AS "specifiersJson",
      md.name_template                                           AS "marketDescTemplate",
      mo.outcome_id                                              AS "outcomeId",
      mo.name                                                    AS "rawName",
      od.name_template                                           AS "outcomeDescTemplate",
      mo.published_odds                                          AS "publishedOdds",
      mo.probability                                             AS "probability"
    FROM markets mk
    JOIN market_outcomes mo ON mo.market_id = mk.id AND mo.active = TRUE
    LEFT JOIN market_descriptions md
      ON md.provider_market_id = mk.provider_market_id
     AND md.variant = COALESCE(mk.specifiers_json->>'variant', '')
    LEFT JOIN outcome_descriptions od
      ON od.provider_market_id = mk.provider_market_id
     AND od.variant = COALESCE(mk.specifiers_json->>'variant', '')
     AND od.outcome_id = mo.outcome_id
    WHERE mk.match_id = ${matchId}
      AND mk.status = 1
  `);

  const byMarket = new Map<string, CurrentMarket>();
  for (const r of rows) {
    let m = byMarket.get(r.marketId);
    if (!m) {
      m = {
        marketId: r.marketId,
        providerMarketId: r.providerMarketId,
        variant: r.variant,
        specifiers: (r.specifiersJson ?? {}) as Record<string, string>,
        outcomes: [],
        marketDescTemplate: r.marketDescTemplate,
      };
      byMarket.set(r.marketId, m);
    }
    m.outcomes.push({
      outcomeId: r.outcomeId,
      rawName: r.rawName,
      descTemplate: r.outcomeDescTemplate,
      publishedOdds: r.publishedOdds,
      probability: r.probability,
    });
  }
  return Array.from(byMarket.values());
}

// Past matches the focused team played — newest-first, scoped to the
// same sport so cross-sport competitor collisions (which the seed +
// auto-mapper still produce) don't bleed in. live_score is the
// JSON we walk for predicate + outcome evaluation.
async function fetchTeamHistory(
  app: FastifyInstance,
  teamId: number,
  sportId: number,
  excludeMatchId: bigint,
): Promise<PastMatch[]> {
  const rows = await app.db.execute<{
    matchId: string;
    homeCompetitorId: number | null;
    homeTeam: string;
    awayTeam: string;
    liveScore: unknown;
    liveStartedAt: string;
  }>(sql`
    SELECT
      m.id::text                          AS "matchId",
      m.home_competitor_id                AS "homeCompetitorId",
      m.home_team                         AS "homeTeam",
      m.away_team                         AS "awayTeam",
      m.live_score                        AS "liveScore",
      m.live_started_at                   AS "liveStartedAt"
    FROM matches m
    JOIN tournaments t ON t.id = m.tournament_id
    JOIN categories cat ON cat.id = t.category_id
    WHERE m.status = 'closed'
      AND m.live_started_at IS NOT NULL
      AND m.live_started_at > NOW() - (${ZILLAFACT_LOOKBACK_DAYS}::int * INTERVAL '1 day')
      AND cat.sport_id = ${sportId}
      AND (m.home_competitor_id = ${teamId} OR m.away_competitor_id = ${teamId})
      AND m.id <> ${excludeMatchId}
      AND m.live_score IS NOT NULL
    ORDER BY m.live_started_at DESC
    LIMIT ${ZILLAFACT_LOOKBACK_LEGS}
  `);
  const past: PastMatch[] = [];
  for (const r of rows) {
    const ls = r.liveScore as LiveScore | null;
    if (!ls) continue;
    past.push({
      matchId: r.matchId,
      teamRole: r.homeCompetitorId === teamId ? "home" : "away",
      liveScore: ls,
      liveStartedAt: r.liveStartedAt,
      homeTeam: r.homeTeam,
      awayTeam: r.awayTeam,
    });
  }
  return past;
}

async function loadConditionalFacts(
  app: FastifyInstance,
  meta: MatchMeta,
): Promise<ZillaFact[]> {
  if (!meta.liveScore) return [];

  const [currentMarkets, homeHistory, awayHistory] = await Promise.all([
    fetchCurrentMarkets(app, meta.matchId),
    fetchTeamHistory(app, meta.homeCompetitorId, meta.sportId, meta.matchId),
    fetchTeamHistory(app, meta.awayCompetitorId, meta.sportId, meta.matchId),
  ]);

  const teams: Array<{
    role: ZillaFactRole;
    competitorId: number;
    teamName: string;
    history: PastMatch[];
  }> = [
    {
      role: "home",
      competitorId: meta.homeCompetitorId,
      teamName: meta.homeTeam,
      history: homeHistory,
    },
    {
      role: "away",
      competitorId: meta.awayCompetitorId,
      teamName: meta.awayTeam,
      history: awayHistory,
    },
  ];

  // Team branding for the team-of-interest. Opponent branding is
  // unused by the conditional path (we don't render leg chips).
  const teamBrand = await fetchTeamBranding(app, [
    meta.homeCompetitorId,
    meta.awayCompetitorId,
  ]);

  const facts: ZillaFact[] = [];
  const emittedKeys = new Set<string>();

  for (const team of teams) {
    for (const pattern of CONDITIONAL_PATTERNS) {
      if (pattern.sports && !pattern.sports.includes(meta.sportSlug)) continue;
      const check = pattern.current(meta.liveScore, team.role);
      if (!check.applicable) continue;

      // Among team's past matches that satisfy the historical
      // predicate, walk newest-first and count consecutive matches
      // where the outcome was a win (or half-win).
      let streak = 0;
      for (const past of team.history) {
        if (!pattern.historical(past)) continue;
        const out = pattern.outcome(past);
        if (out === "won") streak++;
        else break;
      }
      if (streak < ZILLAFACT_MIN_STREAK) continue;

      // Resolve target market on the current match.
      const tgt = pattern.target(team.role);
      const market = currentMarkets.find(
        (m) =>
          m.providerMarketId === tgt.providerMarketId &&
          m.outcomes.some((o) => o.outcomeId === tgt.outcomeId) &&
          (tgt.specifierMatch == null || tgt.specifierMatch(m.specifiers)),
      );
      if (!market) continue;
      const outcome = market.outcomes.find((o) => o.outcomeId === tgt.outcomeId)!;

      // Dedup at the (marketId, outcomeId, teamId) level — two
      // patterns can both fire on the same outcome (e.g. "Won Map 1"
      // AND "Won Map 1 by 10+"), in which case the longer-streak /
      // more specific one should be the surfaced card. Score wins.
      const key = `${market.marketId}:${tgt.outcomeId}:${team.competitorId}`;
      const oddsNum =
        outcome.publishedOdds == null ? null : Number(outcome.publishedOdds);
      const usableOdds =
        oddsNum != null && Number.isFinite(oddsNum) && oddsNum > 1
          ? oddsNum
          : null;
      const score = zillaFactScore(streak, usableOdds);
      if (emittedKeys.has(key)) {
        // Replace if this pattern scores higher.
        const existingIdx = facts.findIndex(
          (f) =>
            f.marketId === market.marketId &&
            f.outcomeId === tgt.outcomeId &&
            f.teamId === team.competitorId,
        );
        if (existingIdx >= 0 && facts[existingIdx]!.score >= score) continue;
        if (existingIdx >= 0) facts.splice(existingIdx, 1);
      }
      emittedKeys.add(key);

      // Resolve display strings via the same renderer the catalog
      // endpoint uses so the market + outcome labels read the same
      // as the corresponding outcome button on the match page.
      const marketTemplate =
        market.marketDescTemplate ?? `Market #${market.providerMarketId}`;
      const marketName = substituteTemplate(marketTemplate, market.specifiers, {
        homeTeam: meta.homeTeam,
        awayTeam: meta.awayTeam,
      });
      const outcomeTemplate =
        outcome.descTemplate ?? outcome.rawName ?? outcome.outcomeId;
      const outcomeLabel = renderOutcomeLabel(
        outcomeTemplate,
        market.specifiers,
        meta.homeTeam,
        meta.awayTeam,
      );

      const brand = teamBrand.get(team.competitorId);
      facts.push({
        marketId: market.marketId,
        outcomeId: tgt.outcomeId,
        teamId: team.competitorId,
        teamName: team.teamName,
        teamRole: team.role,
        teamLogoUrl: brand?.logoUrl ?? null,
        teamBrandColor: brand?.brandColor ?? null,
        marketName,
        outcomeLabel,
        factText: pattern.formatFact(team.teamName, streak, check.conditionText),
        streak,
        currentOdds: usableOdds != null ? usableOdds.toFixed(2) : outcome.publishedOdds,
        score,
        // The conditional path doesn't render leg chips — keep legs
        // empty so the response stays small and the frontend's
        // existing `legs` ignore is a no-op.
        legs: [],
      });
    }
  }

  facts.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.streak !== a.streak) return b.streak - a.streak;
    const ao = a.currentOdds == null ? 0 : Number(a.currentOdds);
    const bo = b.currentOdds == null ? 0 : Number(b.currentOdds);
    return bo - ao;
  });

  return facts;
}

async function fetchTeamBranding(
  app: FastifyInstance,
  teamIds: number[],
): Promise<Map<number, { logoUrl: string | null; brandColor: string | null }>> {
  const result = new Map<
    number,
    { logoUrl: string | null; brandColor: string | null }
  >();
  if (teamIds.length === 0) return result;
  const literal = `{${teamIds.join(",")}}`;
  const rows = await app.db.execute<{
    id: number;
    logoUrl: string | null;
    brandColor: string | null;
  }>(sql`
    SELECT id, logo_url AS "logoUrl", brand_color AS "brandColor"
    FROM competitors
    WHERE id = ANY(${literal}::int[])
  `);
  for (const r of rows) {
    result.set(Number(r.id), { logoUrl: r.logoUrl, brandColor: r.brandColor });
  }
  return result;
}
