// GET /community/leaderboard — Top Authors surface.
//
// Ranks bettors by Oz earned in the trailing 30-day window (or
// all-time), with secondary ROI and recency sorts. Reads primarily
// from oz_ledger (migration 0076); analysis-derived stats join in from
// `analyses` for the wins/ROI/recent-outcomes columns.
//
// V1 data shape note: until the engagement-floor and settlement
// trigger hooks land, oz_ledger holds only admin credits. The
// leaderboard renders correctly in that state — it just shows manual
// credits — and the row set will reshape automatically once the
// trigger pipeline mints real Oz.
//
// Sport filter: when a sport is specified, only authors who published
// at least one analysis in that sport during the window are eligible.
// Admin-credited users with no analyses drop out under a sport
// filter. This matches the prototype's "Soccer · 30d" framing — the
// surface is sport-scoped Top Authors, not "all-time global earners".

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type {
  AnalysisOutcome,
  LeaderboardResponse,
  LeaderboardRow,
} from "@oddzilla/types";
import { resolveOptionalAvatarUrl } from "./avatar-url.js";

const readRateLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };

// Slug shape mirrors the sport catalog (lower-kebab) — reject anything
// else upfront so a typo never leaks into the SQL.
const sportSlugSchema = z
  .string()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const querySchema = z.object({
  sport: sportSlugSchema.optional(),
  window: z.enum(["30d", "all_time"]).default("30d"),
  sort: z.enum(["oz", "roi", "recent"]).default("oz"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Row shape returned by the SQL — fields match LeaderboardRow but with
// raw types as Postgres hands them back (bigint as string, etc.).
interface RawLeaderboardRow {
  userId: string;
  nickname: string;
  avatarSlug: string | null;
  avatarImagePath: string | null;
  ozEarned: string | number;
  settled: number;
  wins: number;
  roiPct: string | null;
  recentOutcomes: string[] | null;
  lastPublishedAt: string | null;
}

export default async function communityLeaderboardRoutes(app: FastifyInstance) {
  app.get(
    "/community/leaderboard",
    { config: readRateLimit },
    async (request): Promise<LeaderboardResponse> => {
      const q = querySchema.parse(request.query);
      const viewerId = request.user?.id ?? null;

      const rows = await runLeaderboardQuery(app, {
        sport: q.sport ?? null,
        window: q.window,
        sort: q.sort,
        limit: q.limit,
      });

      const shaped: LeaderboardRow[] = rows.map((r, idx) =>
        shapeRow(r, idx + 1),
      );

      // Viewer row: re-run the same query unbounded by limit for the
      // caller, then pick out their slot. Cheap because the aggregates
      // are already cached for a fresh read; could be tightened later
      // by re-rank-windowing inline, but the corpus is small.
      let viewerRow: LeaderboardRow | null = null;
      if (viewerId && !shaped.some((r) => r.userId === viewerId)) {
        const all = await runLeaderboardQuery(app, {
          sport: q.sport ?? null,
          window: q.window,
          sort: q.sort,
          // Hard ceiling: don't scan more than 1000 rows for the
          // viewer-rank lookup. If the leaderboard ever grows past
          // that, the response shape needs a dedicated rank-of-viewer
          // endpoint anyway.
          limit: 1000,
        });
        const viewerIdx = all.findIndex((r) => r.userId === viewerId);
        if (viewerIdx >= 0) {
          viewerRow = shapeRow(all[viewerIdx]!, viewerIdx + 1);
        }
      } else if (viewerId) {
        const found = shaped.find((r) => r.userId === viewerId);
        viewerRow = found ?? null;
      }

      return {
        sport: q.sport ?? null,
        window: q.window,
        sort: q.sort,
        rows: shaped,
        viewerRow,
      };
    },
  );
}

interface QueryInput {
  sport: string | null;
  window: "30d" | "all_time";
  sort: "oz" | "roi" | "recent";
  limit: number;
}

async function runLeaderboardQuery(
  app: FastifyInstance,
  q: QueryInput,
): Promise<RawLeaderboardRow[]> {
  // Window clause used in both oz_30d and analysis_stats CTEs.
  const windowClause =
    q.window === "30d"
      ? sql`>= now() - interval '30 days'`
      : sql`>= '1970-01-01'::timestamptz`;

  // Sport-eligibility join is conditional. When no sport is set, we
  // skip the sport CTE entirely so admin-only users still appear; when
  // a sport is set, we INNER JOIN against the eligibility CTE to drop
  // anyone with no in-window analyses on that sport.
  const sportCte =
    q.sport !== null
      ? sql`,
sport_filter AS (
  SELECT DISTINCT a.author_id AS user_id
    FROM analyses a
    JOIN matches m     ON m.id  = a.match_id
    JOIN tournaments tn ON tn.id = m.tournament_id
    JOIN categories  c  ON c.id  = tn.category_id
    JOIN sports      s  ON s.id  = c.sport_id
   WHERE a.status = 'published'
     AND a.published_at ${windowClause}
     AND s.slug = ${q.sport}::text
)`
      : sql``;

  const sportJoin =
    q.sport !== null
      ? sql`INNER JOIN sport_filter sf ON sf.user_id = u.id`
      : sql``;

  // Order clause depends on sort. ROI sort hides users with < 3
  // settled by virtue of `roi_pct IS NULL` ranking last under DESC
  // NULLS LAST; the recent sort favours last-published time.
  const orderClause = (() => {
    switch (q.sort) {
      case "oz":
        return sql`oz_earned DESC NULLS LAST, settled DESC NULLS LAST`;
      case "roi":
        return sql`roi_pct DESC NULLS LAST, settled DESC NULLS LAST`;
      case "recent":
        return sql`last_published_at DESC NULLS LAST, oz_earned DESC NULLS LAST`;
    }
  })();

  // execute<T> requires T : Record<string, unknown>; the cast lands
  // the typed shape at the call boundary without weakening the
  // downstream consumers.
  return (await app.db.execute<Record<string, unknown>>(sql`
WITH oz_window AS (
  SELECT user_id, SUM(delta)::bigint AS oz_earned
    FROM oz_ledger
   WHERE created_at ${windowClause}
   GROUP BY user_id
),
analysis_stats AS (
  SELECT
    a.author_id AS user_id,
    COUNT(*) FILTER (WHERE a.outcome IN ('won','lost'))::int AS settled,
    COUNT(*) FILTER (WHERE a.outcome = 'won')::int           AS wins,
    -- ROI: avg per-analysis return %, currency-agnostic. NULL until
    -- the author has ≥3 settled-in-window. NULLIF guards against the
    -- impossible-in-practice stake=0 case.
    CASE
      WHEN COUNT(*) FILTER (WHERE a.outcome IN ('won','lost')) < 3 THEN NULL
      ELSE ROUND(
        AVG(
          (COALESCE(t.actual_payout_micro, 0)::numeric
           / NULLIF(t.stake_micro, 0)::numeric - 1) * 100
        ) FILTER (WHERE a.outcome IN ('won','lost')),
        1
      )
    END                                                       AS roi_pct,
    MAX(a.published_at)                                       AS last_published_at,
    -- Last 5 settled outcomes in the window, newest first. array_agg
    -- with ORDER BY + LIMIT-via-subquery so the array length is
    -- bounded without a window function.
    (
      SELECT array_agg(o ORDER BY sa DESC)
        FROM (
          SELECT a2.outcome::text AS o, a2.settled_at AS sa
            FROM analyses a2
           WHERE a2.author_id = a.author_id
             AND a2.outcome IN ('won','lost')
             AND a2.settled_at ${windowClause}
           ORDER BY a2.settled_at DESC
           LIMIT 5
        ) recent_q
    )                                                         AS recent_outcomes
  FROM analyses a
  JOIN tickets t ON t.id = a.ticket_id
  WHERE a.status = 'published'
    AND a.published_at ${windowClause}
  GROUP BY a.author_id
)
${sportCte}
SELECT
  u.id                              AS "userId",
  u.nickname                        AS "nickname",
  av.slug                           AS "avatarSlug",
  av.image_path                     AS "avatarImagePath",
  COALESCE(o.oz_earned, 0)::bigint  AS "ozEarned",
  COALESCE(s.settled, 0)::int       AS "settled",
  COALESCE(s.wins, 0)::int          AS "wins",
  s.roi_pct                         AS "roiPct",
  s.recent_outcomes                 AS "recentOutcomes",
  s.last_published_at               AS "lastPublishedAt"
  FROM users u
  -- The leaderboard's row set is the union of (users with Oz earned)
  -- and (users with analyses published) inside the window. FULL OUTER
  -- via two LEFT JOINs + a WHERE filter accomplishes this with one
  -- planner pass.
  LEFT JOIN oz_window      o ON o.user_id = u.id
  LEFT JOIN analysis_stats s ON s.user_id = u.id
  LEFT JOIN avatar_templates av ON av.id = u.avatar_template_id
  ${sportJoin}
 WHERE (o.user_id IS NOT NULL OR s.user_id IS NOT NULL)
 ORDER BY ${sql.raw("")} ${orderClause}, u.id
 LIMIT ${q.limit};
  `)) as unknown as RawLeaderboardRow[];
}

function shapeRow(r: RawLeaderboardRow, rank: number): LeaderboardRow {
  // Outcome strings from analyses.outcome are 'won'|'lost' only at this
  // point — settled-window filter excludes void and cashed_out_void —
  // but we cast through AnalysisOutcome to keep the type contract
  // honest if the filter ever loosens.
  const recent: AnalysisOutcome[] = (r.recentOutcomes ?? []).map(
    (o) => o as AnalysisOutcome,
  );
  return {
    rank,
    userId: r.userId,
    nickname: r.nickname,
    avatarUrl: resolveOptionalAvatarUrl(
      r.avatarSlug
        ? { slug: r.avatarSlug, imagePath: r.avatarImagePath }
        : null,
    ),
    ozEarned: Number(r.ozEarned),
    settled: r.settled,
    wins: r.wins,
    roiPct: r.roiPct === null ? null : Number(r.roiPct),
    recentOutcomes: recent,
    // Visual-only cut-off matching the prototype's Stage 6 (Expert
    // candidate marker at top-5). A future PR introducing a real
    // community_experts table will replace this with a join.
    isExpertCandidate: rank <= 5,
  };
}
