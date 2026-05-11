// /catalog/matches/:matchId/zillatips — per-market historical ROI hints
// the storefront overlays on the match page. Public (anonymous), keyed
// off match-id only.
//
// The endpoint runs one parameterised SQL query that:
//   1. Enumerates every active market × outcome on the requested match.
//   2. For each (market, outcome) decides which team(s) the outcome
//      relates to. Match-winner / map-winner (provider_market_id 1, 4)
//      treat outcome "1" as home-only and "2" as away-only; everything
//      else is symmetric (both teams are relevant).
//   3. For each (market, outcome, team) pulls the team's last
//      ZILLATIP_LOOKBACK_LEGS closed matches with the same
//      (provider_market_id, specifiers_hash) signature.
//   4. Joins each historical match to its market_outcomes row at the
//      "team-equivalent" outcome — swapping outcome "1"↔"2" for
//      team-specific markets when the team's home/away role differs
//      across the two matches.
//   5. Aggregates flat-stake ROI from the prematch_odds snapshot and
//      result enum, and filters to ROI ≥ ZILLATIP_MIN_ROI.
//
// Caching: each match's tips are read-mostly and ROI shifts only on
// new settlements for one of the participants. A 5-minute Redis cache
// absorbs the per-page-render fan-out without staleness anyone would
// feel (the underlying data updates on the hour, not the second).

import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  ZILLATIP_LOOKBACK_LEGS,
  ZILLATIP_MIN_ROI,
  type ZillaTip,
  type ZillaTipLeg,
  type ZillaTipResult,
  type ZillaTipRole,
  type ZillaTipsResponse,
} from "@oddzilla/types";
import { cached } from "../../lib/cache.js";

// Shape of one row out of the raw aggregation CTE. Quoted aliases so
// Postgres preserves camelCase; legsJson stays JSON until we deserialise
// in TS so we don't pay double-encoding inside Postgres. Extends the
// drizzle execute return shape so the row is typed at the call site.
interface AggregateRow extends Record<string, unknown> {
  marketId: string;
  outcomeId: string;
  teamId: number;
  role: ZillaTipRole;
  roi: number;
  ratedCount: number;
  sampleSize: number;
  legsJson: unknown;
}

// Shape of one historical leg as we materialise it in the SQL — kept
// loose because JSON round-trips don't preserve numerics precisely; the
// TS layer is the canonical formatter (string odds, ISO timestamps).
interface RawLeg {
  histMatchId: string;
  histHomeId: number | null;
  histAwayId: number | null;
  histHomeLabel: string;
  histAwayLabel: string;
  teamRoleHist: ZillaTipRole;
  equivOutcomeId: string;
  prematchOdds: string | null;
  result: ZillaTipResult | null;
  liveStartedAt: string;
  scheduledAt: string | null;
}

// Look-back window. 365 days is a soft cap — esports rosters churn
// faster than a year, so older matches are less representative of "this
// team right now". Combined with LIMIT 5 in the lateral, the per-team
// scan stays bounded.
const LOOKBACK_DAYS = 365;

const CACHE_TTL_SECONDS = 300;

export default async function zillatipsRoutes(app: FastifyInstance) {
  app.get("/catalog/matches/:matchId/zillatips", async (request) => {
    const { matchId } = z
      .object({ matchId: z.coerce.bigint() })
      .parse(request.params);

    const cacheKey = `zillatips:v1:${matchId.toString()}`;
    const payload = await cached<ZillaTipsResponse>(
      app.redis,
      cacheKey,
      CACHE_TTL_SECONDS,
      () => loadTips(app, matchId),
    );
    return payload;
  });
}

async function loadTips(
  app: FastifyInstance,
  matchId: bigint,
): Promise<ZillaTipsResponse> {
  // The big CTE. Walk it top-down:
  //
  // current_match        — anchors the (home, away) competitor IDs for
  //                        the open match. Bails early if either side
  //                        has no competitor row (auto-mapper hasn't
  //                        resolved it yet — we can't safely scope the
  //                        team-history lookups without that link).
  // current_markets      — every active market on the open match.
  // outcome_team_pairs   — explode each market × outcome to the
  //                        team(s) it relates to. team-specific
  //                        outcomes (Match Winner "1"/"2") map to one
  //                        side; symmetric outcomes (Totals, Handicaps,
  //                        anything else) map to both sides.
  // historical_per_pair  — lateral pull of the team's last
  //                        ZILLATIP_LOOKBACK_LEGS closed matches with
  //                        the same market signature, then compute the
  //                        equivalent outcome id (1↔2 swap when the
  //                        team's role differs across matches).
  // legs                 — hydrate prematch_odds + result from the
  //                        historical market_outcomes row.
  // roi_aggregates       — flat-stake ROI per (market, outcome,
  //                        team-role) plus the per-leg array.
  //
  // The leg JSON carries opponent label + logo so the storefront can
  // render the row without a second round trip per opponent.
  const rows = await app.db.execute<AggregateRow>(sql`
    WITH
    current_match AS (
      SELECT
        m.id,
        m.home_competitor_id,
        m.away_competitor_id
      FROM matches m
      WHERE m.id = ${matchId}
        AND m.home_competitor_id IS NOT NULL
        AND m.away_competitor_id IS NOT NULL
    ),
    current_markets AS (
      SELECT
        mk.id AS market_id,
        mk.provider_market_id,
        mk.specifiers_hash,
        cm.home_competitor_id,
        cm.away_competitor_id
      FROM markets mk
      CROSS JOIN current_match cm
      WHERE mk.match_id = cm.id
        AND mk.status = 1
    ),
    outcome_team_pairs AS (
      SELECT
        cms.market_id,
        cms.provider_market_id,
        cms.specifiers_hash,
        mo.outcome_id,
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
        -- Team-specific markets: outcome "1" is home, "2" is away,
        -- everything else (e.g. "3" for the draw in 1X2) has no
        -- single team-of-interest and is dropped.
        (
          cms.provider_market_id IN (1, 4)
          AND (
            (mo.outcome_id = '1' AND team.role = 'home')
            OR (mo.outcome_id = '2' AND team.role = 'away')
          )
        )
        -- Symmetric markets: outcome is the same for both teams
        -- (Totals, Handicaps, Correct Score, Map Race, …).
        OR cms.provider_market_id NOT IN (1, 4)
    ),
    historical_per_pair AS (
      SELECT
        otp.market_id AS current_market_id,
        otp.provider_market_id,
        otp.outcome_id AS current_outcome_id,
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
          WHEN otp.provider_market_id IN (1, 4)
           AND h.team_role_hist <> otp.role
          THEN CASE otp.outcome_id
                 WHEN '1' THEN '2'
                 WHEN '2' THEN '1'
                 ELSE otp.outcome_id
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
        JOIN markets hmk
          ON hmk.match_id = hm.id
         AND hmk.provider_market_id = otp.provider_market_id
         AND hmk.specifiers_hash = otp.specifiers_hash
        WHERE hm.status = 'closed'
          AND hm.live_started_at IS NOT NULL
          AND hm.live_started_at > NOW() - (${LOOKBACK_DAYS}::int * INTERVAL '1 day')
          AND (hm.home_competitor_id = otp.team_id OR hm.away_competitor_id = otp.team_id)
          AND hm.id <> ${matchId}
        ORDER BY hm.live_started_at DESC
        LIMIT ${ZILLATIP_LOOKBACK_LEGS}
      ) h
    ),
    legs_raw AS (
      SELECT
        hpp.current_market_id,
        hpp.current_outcome_id,
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
    roi_aggregates AS (
      SELECT
        current_market_id,
        current_outcome_id,
        team_id,
        role,
        -- Per-leg ROI. Won/half_won need a prematch_odds value;
        -- lost/half_lost are a flat -1/-0.5 regardless. Void or null
        -- result yields NULL — SUM ignores it, so the leg drops from
        -- both the numerator and the denominator.
        SUM(CASE
          WHEN result_text = 'won' AND prematch_odds IS NOT NULL
            THEN prematch_odds::numeric - 1
          WHEN result_text = 'lost'
            THEN -1::numeric
          WHEN result_text = 'half_won' AND prematch_odds IS NOT NULL
            THEN (prematch_odds::numeric - 1) / 2
          WHEN result_text = 'half_lost'
            THEN -0.5::numeric
          ELSE NULL
        END) AS profit_sum,
        COUNT(*) FILTER (
          WHERE (result_text IN ('lost', 'half_lost'))
             OR (result_text IN ('won', 'half_won') AND prematch_odds IS NOT NULL)
        ) AS rated_count,
        COUNT(*) AS sample_size,
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
          ORDER BY live_started_at DESC
        ) AS legs_json
      FROM legs_raw
      GROUP BY current_market_id, current_outcome_id, team_id, role
    )
    SELECT
      current_market_id::text                 AS "marketId",
      current_outcome_id                      AS "outcomeId",
      team_id                                 AS "teamId",
      role::text                              AS "role",
      (profit_sum / NULLIF(rated_count, 0))::float8 AS "roi",
      rated_count::int                        AS "ratedCount",
      sample_size::int                        AS "sampleSize",
      legs_json                               AS "legsJson"
    FROM roi_aggregates
    WHERE rated_count > 0
      AND profit_sum / NULLIF(rated_count, 0) >= ${ZILLATIP_MIN_ROI}::numeric
    ORDER BY roi DESC
  `);

  // First pass: collect every opponent id we need to hydrate with
  // logo / brand-colour. We keep the raw rows around so the second
  // pass can build each ZillaTip in one shot once branding lands.
  const opponentIds = new Set<number>();
  const rawByRow: Array<{ row: AggregateRow; legs: RawLeg[] }> = [];

  for (const r of rows) {
    const legs = (Array.isArray(r.legsJson) ? (r.legsJson as RawLeg[]) : []);
    for (const leg of legs) {
      const oppId =
        leg.teamRoleHist === "home" ? leg.histAwayId : leg.histHomeId;
      if (oppId != null) opponentIds.add(oppId);
    }
    rawByRow.push({ row: r, legs });
  }

  // One round-trip for every opponent's branding. competitor.id is the
  // shared key on both ends — competitors are sport-scoped, but we
  // already pinned the lookup chain to a single sport via the team's
  // own competitor row, so a numeric id is unambiguous here.
  const brandById = new Map<
    number,
    { logoUrl: string | null; brandColor: string | null }
  >();
  if (opponentIds.size > 0) {
    // `${jsArray}` in drizzle's sql tag binds positionally as a tuple
    // ($1, $2, ...) which can't be cast to int[]. Mirror the
    // riskzilla/engine.ts pattern: build a single Postgres array
    // literal string `{1,2,3}` and let the SQL-side cast parse it.
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

  const tips: ZillaTip[] = rawByRow.map(({ row, legs }) => ({
    marketId: row.marketId,
    outcomeId: row.outcomeId,
    teamId: Number(row.teamId),
    role: row.role,
    roi: Number(row.roi),
    ratedCount: row.ratedCount,
    sampleSize: row.sampleSize,
    legs: legs.map((leg): ZillaTipLeg => {
      const oppId =
        leg.teamRoleHist === "home" ? leg.histAwayId : leg.histHomeId;
      const brand = oppId != null ? brandById.get(oppId) : undefined;
      return {
        histMatchId: leg.histMatchId,
        teamRoleHist: leg.teamRoleHist,
        opponentLabel:
          leg.teamRoleHist === "home" ? leg.histAwayLabel : leg.histHomeLabel,
        opponentLogoUrl: brand?.logoUrl ?? null,
        opponentBrandColor: brand?.brandColor ?? null,
        prematchOdds: leg.prematchOdds,
        result: leg.result,
        equivOutcomeId: leg.equivOutcomeId,
        liveStartedAt: leg.liveStartedAt,
        scheduledAt: leg.scheduledAt,
      };
    }),
  }));

  return { matchId: matchId.toString(), tips };
}
