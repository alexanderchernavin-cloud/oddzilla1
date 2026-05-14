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
    // v2: line-family collapse — when 3+ lines in the same Total
    // Kills / Total Maps / etc. family carry the same streak (typical
    // because streaks tend to be identical across same-direction
    // sibling lines), surface only the highest-odds member. Bump the
    // key so cached v1 (uncollapsed) responses drain.
    const cacheKey = `zillafacts:v2:${matchId.toString()}`;
    return cached<ZillaFactsResponse>(
      app.redis,
      cacheKey,
      CACHE_TTL_SECONDS,
      () => loadFacts(app, matchId),
    );
  });
}

async function loadFacts(
  app: FastifyInstance,
  matchId: bigint,
): Promise<ZillaFactsResponse> {
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
    return { matchId: matchId.toString(), facts: [] };
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

  return { matchId: matchId.toString(), facts };
}
