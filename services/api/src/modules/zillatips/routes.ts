// /catalog/matches/:matchId/zillatips — per-market historical ROI hints
// the storefront overlays on the match page. Public (anonymous), keyed
// off match-id only.
//
// The endpoint runs one parameterised SQL query that:
//   1. Enumerates every active market × outcome on the requested match.
//      Markets whose specifiers encode team-relative values
//      (handicaps, correct-score) are skipped — those don't survive
//      a home/away role flip without a proper specifier-mirroring
//      pass, which we don't have yet.
//   2. For each (market, outcome) decides which team(s) the outcome
//      relates to. The decision is OUTCOME-driven: outcome "1"
//      always maps to home, "2" always to away. This covers
//      everything where Oddin uses positional outcome IDs
//      (match/map/round winners, first-to-X, first-blood, half
//      winners, etc.) — not just match/map winner (pmi 1, 4) as the
//      previous version assumed. Outcomes outside {"1","2"} and the
//      symmetric allowlist below produce no tips, so unknown markets
//      degrade silently instead of producing backwards numbers.
//   3. For each (market, outcome, team) pulls the team's last
//      ZILLATIP_LOOKBACK_LEGS closed matches with the same
//      (provider_market_id, specifiers_hash) signature.
//   4. Joins each historical match to its market_outcomes row at the
//      "team-equivalent" outcome — swapping outcome "1"↔"2" when the
//      team's home/away role differs across the two matches, so a
//      tip for "Team A wins" (Team A currently home) still finds
//      "Team A wins" in a past match where they were away (outcome
//      "2" there). Without this swap the lookup returns the
//      opponent's result and the tip flips sign.
//   5. Sums per-leg flat-stake returns from the prematch_odds snapshot
//      and result enum, and filters to total ≥ ZILLATIP_MIN_ROI.
//      The "ROI" surfaced to the storefront is the SUM of per-leg
//      returns — i.e. for N unit-stake bets, the net profit expressed
//      as a multiple of one stake. So 2 wins at 1.90 / 2.50 sum to
//      (0.90 + 1.50) = 2.40 → +240%. Lost legs contribute -1.0,
//      voids contribute nothing. Matches the user-facing intuition
//      that "lost-then-won-at-1.80" is -100% + 80% = -20% (filtered).
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
  type ZillaTipRow,
  type ZillaTipsResponse,
} from "@oddzilla/types";
import { cached } from "../../lib/cache.js";

// Shape of one row out of the raw aggregation CTE. Quoted aliases so
// Postgres preserves camelCase; rowsJson stays JSON until we
// deserialise in TS so we don't pay double-encoding inside Postgres.
// Extends the drizzle execute return shape so the row is typed at the
// call site.
interface AggregateRow extends Record<string, unknown> {
  marketId: string;
  outcomeId: string;
  roi: number;
  ratedCount: number;
  sampleSize: number;
  rowsJson: unknown;
}

// One team's trail as it lives inside rowsJson. teamId/role pin the
// row to a specific side of the current match; legs are the team's
// last N closed-match results (already swapped to that team's
// perspective via equiv_outcome_id in the SQL).
interface RawRow {
  teamId: number;
  role: ZillaTipRole;
  legs: RawLeg[];
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

    // v5: "{side}"-specifier markets (Team home/away total goals,
    // home/away wins at least one map, …) are now correctly handled.
    // They only generate one tip — for the team the side specifier
    // identifies — and the historical lookup joins the past market
    // by matching "side" to the team's role in that match, so a
    // role-flipped past match (different specifiers_hash) still
    // contributes. Bump key so cached v4 (wrong-team / missing-past
    // -match) shapes drain.
    // v6: leg order flipped to ASC (oldest -> newest left-to-right)
    // so the rightmost chip is the most recent match — matches the
    // convention HLTV / Liquipedia results pages use. Bump key so
    // cached v5 reverse-ordered payloads drain.
    const cacheKey = `zillatips:v6:${matchId.toString()}`;
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
    -- Markets whose specifiers carry team-relative values (handicap
    -- lines, correct-score result pairs). Matching past markets via
    -- specifiers_hash for these is unsafe across role flips: a
    -- "hcp=+1.5 on home" past market doesn't represent the same bet
    -- for an away-now team. Exclude entirely until we have a
    -- specifier-mirroring pass. Detection is name-template-driven
    -- so any new handicap / correct-score market Oddin adds is
    -- excluded automatically.
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
        -- specifiers_json carries through so downstream CTEs can
        -- detect "{side}"-specifier markets (Team home/away total
        -- goals, "home wins at least one map", etc.). These are
        -- team-specific to whichever side the "side" specifier
        -- identifies — NOT symmetric — and a role-flipped past
        -- match lives under the MIRRORED "side" value (different
        -- specifiers_hash).
        mk.specifiers_json,
        cm.home_competitor_id,
        cm.away_competitor_id
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
        cms.specifiers_hash,
        cms.specifiers_json,
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
        -- "{side}"-specifier markets: the "side" value pins the
        -- market to ONE team (the side team). Outcomes here are
        -- usually over/under or yes/no — symmetric for that team
        -- in isolation. Pair only with the team whose role matches
        -- the side specifier; ignore outcome-id positionality.
        (
          cms.specifiers_json ? 'side'
          AND team.role = cms.specifiers_json->>'side'
        )
        -- Non-side markets with team-positional outcomes "1"/"2":
        -- outcome "1" → home only, "2" → away only. Covers
        -- match/map/round winners, first-to-X, half winners,
        -- match-winner-DnB (pmi 87), first-blood, etc.
        OR (
          NOT (cms.specifiers_json ? 'side')
          AND mo.outcome_id IN ('1', '2')
          AND (
            (mo.outcome_id = '1' AND team.role = 'home')
            OR (mo.outcome_id = '2' AND team.role = 'away')
          )
        )
        -- Non-side markets with symmetric outcomes (over/under,
        -- yes/no, odd/even). Both teams pair with the outcome;
        -- the per-team trail aggregates into one combined tip
        -- via the (market, outcome) grouping below.
        OR (
          NOT (cms.specifiers_json ? 'side')
          AND mo.outcome_id IN ('4', '5', '6', '7', '60', '61')
        )
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
        -- equiv_outcome_id: when the team's role in the past match
        -- differs from its role on the current match AND the outcome
        -- is team-positional ("1"/"2") on a NON-side market, flip
        -- the outcome to find the team's perspective in the past row.
        --
        -- For "{side}"-specifier markets the outcome is symmetric
        -- for the side team (over/under, yes/no), so no flip is
        -- needed — the cross-market join below handles the "different
        -- specifier hash" half by matching the past market's side
        -- value to the past team's role.
        --
        -- Example (non-side): Astralis is AWAY now (outcome "2"), but
        -- in their last match they were HOME. The "did Astralis win"
        -- answer lives under outcome "1" in that past row.
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
        JOIN markets hmk
          ON hmk.match_id = hm.id
         AND hmk.provider_market_id = otp.provider_market_id
         -- Cross-market lookup for "{side}"-specifier markets.
         --
         --   * Non-side market => fast path: match by the precomputed
         --     specifiers_hash. Same as before.
         --   * Side market => match the non-"side" part of specifiers
         --     for equality AND match the past market's "side" value
         --     to the team role in the past match. So "M80 wins at
         --     least one map" looks up the side=away past market when
         --     M80 was away, and the side=home past market when M80
         --     was home -- covering BOTH past markets that represent
         --     the same team question.
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
          AND hm.live_started_at > NOW() - (${LOOKBACK_DAYS}::int * INTERVAL '1 day')
          -- Sport-scoping is implicit here. otp.team_id is a
          -- competitors.id, and competitors are sport-scoped per
          -- migration 0009's UNIQUE(sport_id, slug). A given
          -- competitor.id therefore belongs to exactly ONE sport,
          -- so any past match whose home/away competitor equals
          -- otp.team_id is necessarily in the same sport as the
          -- current match. No need for an explicit JOIN through
          -- tournaments -> categories -> sports.
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
    -- First aggregation: roll up per (market, outcome, team, role).
    -- Each row here is one "team trail" — the focused team's last N
    -- closed-match results on this market signature. For positional
    -- outcomes ("1"/"2") only one team is paired with the outcome, so
    -- there's exactly one team-trail row per (market, outcome). For
    -- symmetric outcomes (Totals, Parity, etc.) BOTH teams are
    -- paired, producing two team-trail rows that the outer aggregate
    -- combines into a single tip.
    team_legs AS (
      SELECT
        current_market_id,
        current_outcome_id,
        team_id,
        role,
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
        END) AS team_profit,
        COUNT(*) FILTER (
          WHERE (result_text IN ('lost', 'half_lost'))
             OR (result_text IN ('won', 'half_won') AND prematch_odds IS NOT NULL)
        ) AS team_rated,
        COUNT(*) AS team_sample,
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
          -- ASC so the rendered chip row reads left-to-right as
          -- oldest -> newest. The lateral above still picks the top-5
          -- by recency (DESC + LIMIT 5); we just stack them in the
          -- popover so the most recent match anchors the right edge,
          -- matching the convention used by HLTV-style results lists.
          ORDER BY live_started_at ASC
        ) AS team_legs_json
      FROM legs_raw
      GROUP BY current_market_id, current_outcome_id, team_id, role
    ),
    -- Second aggregation: combine team trails into one tip per
    -- (market, outcome). For symmetric markets this gives up to 10
    -- legs (5 per team) and a single combined ROI; for positional
    -- markets it's a passthrough of the single team trail. The 20%
    -- gate applies to the COMBINED profit so a symmetric tip can
    -- surface based on the joint sample even if neither team alone
    -- clears the threshold.
    roi_aggregates AS (
      SELECT
        current_market_id,
        current_outcome_id,
        SUM(team_profit) AS profit_sum,
        SUM(team_rated) AS rated_count,
        SUM(team_sample) AS sample_size,
        jsonb_agg(
          jsonb_build_object(
            'teamId', team_id,
            'role', role,
            'legs', team_legs_json
          )
          -- Stable visual order: home row above away row in the
          -- popover regardless of insert order from the prior CTE.
          ORDER BY (role = 'away'), role
        ) AS rows_json
      FROM team_legs
      GROUP BY current_market_id, current_outcome_id
    )
    SELECT
      current_market_id::text                 AS "marketId",
      current_outcome_id                      AS "outcomeId",
      profit_sum::float8                      AS "roi",
      rated_count::int                        AS "ratedCount",
      sample_size::int                        AS "sampleSize",
      rows_json                               AS "rowsJson"
    FROM roi_aggregates
    WHERE rated_count > 0
      AND profit_sum >= ${ZILLATIP_MIN_ROI}::numeric
    ORDER BY roi DESC
  `);

  // First pass: walk every leg across every row of every tip and
  // collect the unique opponent competitor ids we need to hydrate
  // with logo / brand colour. We stash the parsed raw rows alongside
  // the aggregate so the second pass can build each ZillaTip in one
  // shot once branding lands.
  const opponentIds = new Set<number>();
  const rawByTip: Array<{ agg: AggregateRow; rows: RawRow[] }> = [];

  for (const r of rows) {
    const rawRows = (Array.isArray(r.rowsJson) ? (r.rowsJson as RawRow[]) : []);
    for (const row of rawRows) {
      for (const leg of row.legs ?? []) {
        const oppId =
          leg.teamRoleHist === "home" ? leg.histAwayId : leg.histHomeId;
        if (oppId != null) opponentIds.add(oppId);
      }
    }
    rawByTip.push({ agg: r, rows: rawRows });
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

  // Build a ZillaTipLeg from a raw leg + opponent brand lookup.
  // Extracted because we now hydrate legs nested inside rows.
  const hydrateLeg = (leg: RawLeg): ZillaTipLeg => {
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
  };

  const tips: ZillaTip[] = rawByTip.map(({ agg, rows: rawRows }) => ({
    marketId: agg.marketId,
    outcomeId: agg.outcomeId,
    roi: Number(agg.roi),
    ratedCount: agg.ratedCount,
    sampleSize: agg.sampleSize,
    // rows: 1 entry for positional-outcome tips, 1-2 entries for
    // symmetric-outcome tips. Empty-legs rows (a team with zero past
    // matches matching the signature) are dropped — they'd just
    // render as an empty section in the popover.
    rows: rawRows
      .filter((row) => Array.isArray(row.legs) && row.legs.length > 0)
      .map((row): ZillaTipRow => ({
        teamId: Number(row.teamId),
        role: row.role,
        legs: row.legs.map(hydrateLeg),
      })),
  }));

  return { matchId: matchId.toString(), tips };
}
