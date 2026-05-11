// /community/competitions/* — bettor surface for prediction games (Phase 11).
//
// Six endpoints in this module; admin endpoints live separately in
// admin/competitions.ts.
//
//   GET    /community/competitions                       — list + filter + sort
//   GET    /community/competitions/:id                   — single (detail page header + Overview tab)
//   GET    /community/competitions/:id/matches           — matches tab
//   GET    /community/competitions/:id/leaderboard       — leaderboard tab
//   POST   /community/competitions/:id/join              — idempotent join
//   POST   /community/competitions/:id/predictions       — submit/update one prediction
//
// Read paths are anonymous-friendly; viewer-specific fields
// (viewerJoined, viewerRank, viewerPrediction) are NULL on
// unauthenticated reads. Writes require requireAuth().
//
// Timing rules:
//   • timing-lock-kickoff (locked, on by default) — predictions on a
//     match are immutable once kickoff_at has passed.
//   • timing-grace-period (configurable) — extends the lock by N
//     minutes; we read the rule's value at predict time. Defaults to
//     0 when the rule isn't set.
//
// Aggregate-counter discipline (mirrors analyses.ts):
//   • participant_count is bumped at API join time.
//   • match_count is bumped by the admin add-match endpoint.
//   • points / correct_count / streak / longest_streak on the
//     participant row are written by services/settlement (Go) only.
//     The API never touches them after the join INSERT.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  competitions,
  competitionRules,
  competitionMatches,
  competitionParticipants,
  competitionPredictions,
} from "@oddzilla/db";
import { renderRules } from "@oddzilla/types";
import type {
  CompetitionDetail,
  CompetitionListResponse,
  CompetitionLeaderboardEntry,
  CompetitionLeaderboardResponse,
  CompetitionMatchesResponse,
  CompetitionMatchRow,
  CompetitionRuleAssignment,
  CompetitionStatus,
  CompetitionSummary,
  CompetitionType,
  CreatePredictionRequest,
  CreatePredictionResponse,
  JoinCompetitionResponse,
  ViewerPrediction,
} from "@oddzilla/types";
import { cached } from "../../lib/cache.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../lib/errors.js";
import { resolveOptionalAvatarUrl } from "./avatar-url.js";
import {
  emitNotification,
  ensureCompetitionUpdatesEnabled,
} from "./notifications.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const writeRateLimit = { rateLimit: { max: 30, timeWindow: "1 minute" } };
const readRateLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };

const listQuery = z.object({
  // Status tab strip on the home (All omits the param). 'all' is an
  // explicit alias for "no filter" so the FE can build deterministic
  // URLs from a tab id.
  status: z
    .enum(["all", "draft", "scheduled", "upcoming", "live", "ended"])
    .default("all"),
  sport: z.coerce.number().int().positive().optional(),
  // Bettor surface only ever shows public statuses by default;
  // featured=true narrows to the rotator pool.
  featured: z.coerce.boolean().optional(),
  // List is small in V1 (<100 comps per operator), so a single page
  // size is fine. Capped at 50 for safety.
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

// Predictions can carry either score-only (prediction comps) or score
// + tip (tipping comps). The API decides which shape to enforce after
// loading the competition's type.
const createPredictionBody = z.object({
  competitionMatchId: z.string().regex(/^\d+$/u, "competition_match_invalid"),
  predictedScoreA: z.number().int().min(0).max(99),
  predictedScoreB: z.number().int().min(0).max(99),
  tip: z.enum(["1", "X", "2"]).optional(),
});

// Leaderboard returns top N + viewer's row out-of-band. 50 is the
// limit on the leaderboard tab; the YourPositionPanel above the
// table reads viewerEntry separately.
const LEADERBOARD_TOP_N = 50;

// Bettor-visible statuses are inlined as SQL literals in the
// 'all' branch of statusClause because parameterising a JS array as
// `ANY($1::competition_status[])` makes pg-js spread the elements
// into a record tuple it can't cast to the enum array. 'draft' is
// always excluded from the bettor list.

export default async function communityCompetitionsRoutes(app: FastifyInstance) {
  // ─── GET /community/competitions ──────────────────────────────────────────
  //
  // List endpoint. Drives:
  //   • CompetitionsHome top-of-funnel (status='upcoming')
  //   • FeaturedHero rotator (featured=true)
  //   • Status-tab strip filtering
  //
  // Cross-comp leaderboard reads, MyCompetitionsStrip ("comps you've
  // joined") use a different shape — those join to
  // competition_participants and live in their own endpoints
  // (deferred to V1.1).
  app.get(
    "/community/competitions",
    { config: readRateLimit },
    async (request): Promise<CompetitionListResponse> => {
      const q = listQuery.parse(request.query);
      const viewerId = request.user?.id ?? null;

      // Status filter. 'all' becomes the bettor-visible set; an
      // explicit status narrows to that single value (and 'draft'
      // gets silently dropped — bettors never see drafts).
      const statusClause =
        q.status === "all"
          ? sql`c.status IN ('scheduled', 'upcoming', 'live', 'ended')`
          : q.status === "draft"
            ? sql`FALSE` // bettors never see drafts
            : sql`c.status = ${q.status}::competition_status`;

      const sportClause =
        q.sport !== undefined ? sql`AND c.sport_id = ${q.sport}::int` : sql``;

      const featuredClause = q.featured === true ? sql`AND c.featured = TRUE` : sql``;

      const offset = (q.page - 1) * q.pageSize;
      const limit = q.pageSize + 1;

      const rows = await app.db.execute<Record<string, unknown>>(sql`
SELECT
  c.id                   AS "id",
  c.title                AS "title",
  c.type::text           AS "type",
  c.status::text         AS "status",
  c.sport_id             AS "sportId",
  s.slug                 AS "sportSlug",
  s.name                 AS "sportName",
  c.league               AS "league",
  c.launch_at            AS "launchAt",
  c.bet_close_at         AS "betCloseAt",
  c.match_start_at       AS "matchStartAt",
  c.stop_show_at         AS "stopShowAt",
  c.banner_url           AS "bannerUrl",
  c.thumbnail_url        AS "thumbnailUrl",
  c.featured             AS "featured",
  c.markets              AS "markets",
  c.participant_count    AS "participantCount",
  c.match_count          AS "matchCount",
  -- M3 rewrite: was an EXISTS subquery evaluated per row. Now a LEFT
  -- JOIN against the viewer's single participant row keyed on
  -- (competition_id, user_id) — one indexed nested-loop lookup per
  -- comp page row vs. 20 EXISTS subqueries on a 20-row page. NULL on
  -- anonymous reads (viewerId::uuid IS NULL ⇒ no row joins).
  CASE
    WHEN ${viewerId}::uuid IS NULL THEN NULL
    ELSE (vcp.user_id IS NOT NULL)
  END                    AS "viewerJoined"
  FROM competitions c
  LEFT JOIN sports s ON s.id = c.sport_id
  LEFT JOIN competition_participants vcp
    ON vcp.competition_id = c.id
   AND vcp.user_id = ${viewerId}::uuid
 WHERE ${statusClause}
   ${sportClause}
   ${featuredClause}
 ORDER BY
   c.featured DESC,
   c.launch_at DESC
 LIMIT ${limit}
 OFFSET ${offset}
`);

      const all = rows.map(normaliseCompetitionSummary);
      const hasMore = all.length > q.pageSize;
      return {
        competitions: all.slice(0, q.pageSize),
        page: q.page,
        pageSize: q.pageSize,
        hasMore,
      };
    },
  );

  // ─── GET /community/competitions/:id ──────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/community/competitions/:id",
    { config: readRateLimit },
    async (request): Promise<CompetitionDetail> => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();
      const viewerId = request.user?.id ?? null;
      return loadCompetitionDetail(app, id, viewerId);
    },
  );

  // ─── GET /community/competitions/:id/matches ──────────────────────────────
  //
  // Matches tab. Inlines the viewer's prediction on each match so the
  // tab + the "your picks" rail share one fetch.
  app.get<{ Params: { id: string } }>(
    "/community/competitions/:id/matches",
    { config: readRateLimit },
    async (request): Promise<CompetitionMatchesResponse> => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();
      const viewerId = request.user?.id ?? null;

      // Confirm comp exists. Cheap cover for the per-comp 404.
      const [comp] = await app.db
        .select({ id: competitions.id })
        .from(competitions)
        .where(eq(competitions.id, id))
        .limit(1);
      if (!comp) throw new NotFoundError();

      const rows = await app.db.execute<Record<string, unknown>>(sql`
SELECT
  cm.id::text             AS "id",
  cm.competition_id       AS "competitionId",
  cm.match_id::text       AS "matchId",
  cm.team_a               AS "teamA",
  cm.team_b               AS "teamB",
  cm.league               AS "league",
  cm.kickoff_at           AS "kickoffAt",
  cm.status::text         AS "status",
  cm.score_a              AS "scoreA",
  cm.score_b              AS "scoreB",
  cm.suspended            AS "suspended",
  cm.cancelled            AS "cancelled",
  -- Inlined viewer prediction. NULL for anonymous, NULL for joined-
  -- but-not-yet-predicted. The CASE preserves the NULL distinction
  -- the FE uses to render the predict CTA vs. the locked badge.
  CASE WHEN ${viewerId}::uuid IS NULL THEN NULL ELSE (
    SELECT json_build_object(
      'id', cp.id::text,
      'predictedScoreA', cp.predicted_score_a,
      'predictedScoreB', cp.predicted_score_b,
      'tip', cp.tip,
      'placedAt', cp.placed_at,
      'pointsAwarded', cp.points_awarded,
      'outcome', cp.outcome,
      'settledAt', cp.settled_at
    )
    FROM competition_predictions cp
    WHERE cp.competition_match_id = cm.id
      AND cp.user_id = ${viewerId}::uuid
    LIMIT 1
  ) END                   AS "viewerPrediction"
  FROM competition_matches cm
 WHERE cm.competition_id = ${id}::uuid
 ORDER BY cm.sort_order ASC, cm.kickoff_at ASC
`);

      return { matches: rows.map(normaliseMatchRow) };
    },
  );

  // ─── GET /community/competitions/:id/leaderboard ──────────────────────────
  //
  // Leaderboard tab. Returns top N + viewer's row separately when the
  // viewer is outside the top N. rank is 1-based; ties are broken by
  // longest_streak then user_id (deterministic). Servers
  // recentResults from the predictions table — the participant row
  // doesn't store the result history.
  app.get<{ Params: { id: string } }>(
    "/community/competitions/:id/leaderboard",
    { config: readRateLimit },
    async (request): Promise<CompetitionLeaderboardResponse> => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();
      const viewerId = request.user?.id ?? null;

      const [comp] = await app.db
        .select({ id: competitions.id })
        .from(competitions)
        .where(eq(competitions.id, id))
        .limit(1);
      if (!comp) throw new NotFoundError();

      // M1 rewrite: previously this CTE ran ROW_NUMBER() OVER the
      // entire participants table for the comp, then filtered to the
      // top N. That ranks every row in a 10K-participant comp just to
      // throw 9,950 away. New shape reads the top N rows directly
      // (the leaderboard_idx (competition_id, points DESC,
      // longest_streak DESC) drives the order; the user_id ASC tail
      // tie-breaker re-sorts within an index-prefix-equal slice — for
      // V1 corpus sizes the planner can do this cheaply, and a
      // follow-up index extension to include user_id ASC makes it
      // perfectly index-driven). ROW_NUMBER() OVER () after the
      // ORDER BY/LIMIT just assigns sequential ranks to the already
      // ordered slice.
      const top = await app.db.execute<Record<string, unknown>>(sql`
WITH page AS (
  SELECT
    cp.user_id,
    cp.points,
    cp.correct_count,
    cp.total_settled,
    cp.streak,
    cp.longest_streak,
    cp.recent_outcomes
    FROM competition_participants cp
    -- Exclude AI seed bettors from the ranking entirely so ranks are
    -- contiguous against human participants only. Mirrors the audit
    -- finding (SEC-C1): admin surfaces honoured is_ai = true, the
    -- bettor surface did not -- leaderboards listed seed accounts as
    -- first-class entrants. The JOIN runs once per participant row,
    -- bounded by participant_count, so the cost is negligible.
    INNER JOIN users u ON u.id = cp.user_id AND u.is_ai = false
   WHERE cp.competition_id = ${id}::uuid
   ORDER BY cp.points DESC, cp.longest_streak DESC, cp.user_id ASC
   LIMIT ${LEADERBOARD_TOP_N}
)
SELECT
  (ROW_NUMBER() OVER (
    ORDER BY p.points DESC, p.longest_streak DESC, p.user_id ASC
  ))::int                         AS "rank",
  p.user_id                       AS "userId",
  u.nickname                      AS "nickname",
  av.slug                         AS "avatarSlug",
  av.image_path                   AS "avatarImagePath",
  p.points                        AS "points",
  p.correct_count                 AS "correctCount",
  p.total_settled                 AS "totalSettled",
  CASE WHEN p.total_settled = 0 THEN NULL
       ELSE ROUND(100.0 * p.correct_count / p.total_settled)::int END
                                  AS "winRatePct",
  p.streak                        AS "streak",
  p.longest_streak                AS "longestStreak",
  -- Audit 0046 (M2): last 5 settled outcomes read straight off
  -- competition_participants.recent_outcomes. The array is already
  -- newest-first because scoreMatchPredictions prepends on settle
  -- and truncates to 5. Replaces the per-row 5-element correlated
  -- subquery that ran 50 times per leaderboard page.
  p.recent_outcomes               AS "recentResults",
  -- isYou flagged server-side so the FE doesn't have to compare on
  -- every row. Anonymous viewers always see false.
  (p.user_id = ${viewerId}::uuid) AS "isYou"
  FROM page p
  INNER JOIN users u ON u.id = p.user_id AND u.is_ai = false
  LEFT JOIN avatar_templates av ON av.id = u.avatar_template_id
 ORDER BY p.points DESC, p.longest_streak DESC, p.user_id ASC
`);

      // Total count in one cheap aggregate. Matches the ranked CTE
      // above by excluding AI seed bettors — the count drives the
      // "X participants" chip on the leaderboard header, which must
      // stay in lockstep with the visible rows.
      const totalRows = await app.db.execute<{ total: number }>(sql`
        SELECT COUNT(*)::int AS total
          FROM competition_participants cp
          INNER JOIN users u ON u.id = cp.user_id AND u.is_ai = false
         WHERE cp.competition_id = ${id}::uuid
      `);
      const totalParticipants = Number(totalRows[0]?.total ?? 0);

      const entries = top.map(normaliseLeaderboardEntry);

      // Viewer entry. Fetched only when the viewer is authed AND not
      // already in the top-N page; saves a roundtrip on most reads.
      let viewerEntry: CompetitionLeaderboardEntry | null = null;
      if (viewerId && !entries.some((e) => e.userId === viewerId)) {
        // M1 rewrite: was a second pass of ROW_NUMBER() OVER the full
        // participants table just to find the viewer's rank. Now a
        // correlated COUNT — for each participant strictly ahead of
        // the viewer in the (points, longest_streak) order, add 1.
        // The leaderboard_idx makes that COUNT planner-cheap, and we
        // never materialise the long tail. The user_id ASC tail
        // tie-breaker is consistent with the top-N path because we
        // count strict-greater on the leading sort keys; an exact tie
        // collapses to the same rank, which matches the V1 product
        // spec ("rank is shared on a tie").
        const viewerRows = await app.db.execute<Record<string, unknown>>(sql`
SELECT
  (
    -- Correlated count for viewer rank; excludes AI seed bettors so
    -- the denominator matches the leaderboard population.
    SELECT COUNT(*)::int + 1
      FROM competition_participants p2
      INNER JOIN users u2 ON u2.id = p2.user_id AND u2.is_ai = false
     WHERE p2.competition_id = ${id}::uuid
       AND (p2.points, p2.longest_streak) > (cp.points, cp.longest_streak)
  )                               AS "rank",
  cp.user_id                      AS "userId",
  u.nickname                      AS "nickname",
  av.slug                         AS "avatarSlug",
  av.image_path                   AS "avatarImagePath",
  cp.points                       AS "points",
  cp.correct_count                AS "correctCount",
  cp.total_settled                AS "totalSettled",
  CASE WHEN cp.total_settled = 0 THEN NULL
       ELSE ROUND(100.0 * cp.correct_count / cp.total_settled)::int END
                                  AS "winRatePct",
  cp.streak                       AS "streak",
  cp.longest_streak               AS "longestStreak",
  -- Audit 0046 (M2): viewer entry surfaces the same projected
  -- recent_outcomes the top-N rows use; FE renders the run identically
  -- whether the viewer is in or out of the visible page.
  cp.recent_outcomes              AS "recentResults",
  TRUE                            AS "isYou"
  FROM competition_participants cp
  INNER JOIN users u ON u.id = cp.user_id AND u.is_ai = false
  LEFT JOIN avatar_templates av ON av.id = u.avatar_template_id
 WHERE cp.competition_id = ${id}::uuid
   AND cp.user_id = ${viewerId}::uuid
 LIMIT 1
`);
        if (viewerRows.length > 0) {
          viewerEntry = normaliseLeaderboardEntry(viewerRows[0]!);
        }
      }

      return { entries, totalParticipants, viewerEntry };
    },
  );

  // ─── POST /community/competitions/:id/join ────────────────────────────────
  //
  // Idempotent. Returns alreadyJoined=true on a no-op POST so the FE
  // can render the JoinPanel → YourPositionPanel transition without
  // surfacing an error toast.
  app.post<{ Params: { id: string } }>(
    "/community/competitions/:id/join",
    { config: writeRateLimit },
    async (request): Promise<JoinCompetitionResponse> => {
      const u = request.requireAuth();
      const { id } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();

      const [comp] = await app.db
        .select({
          id: competitions.id,
          status: competitions.status,
          title: competitions.title,
          betCloseAt: competitions.betCloseAt,
        })
        .from(competitions)
        .where(eq(competitions.id, id))
        .limit(1);
      if (!comp) throw new NotFoundError();
      // Bettors can only join open comps. Drafts and ended comps
      // 400 with `competition_not_open`; live comps 200 because some
      // formats accept late joiners (their predictions are scored
      // from the join point onward).
      if (comp.status === "draft" || comp.status === "ended") {
        throw new BadRequestError("competition_not_open", "competition_not_open");
      }

      // Eligibility-max-participants gate. We read the rule and
      // compare against the current denormalised count; if absent,
      // skip the check.
      const cap = await getMaxParticipantsCap(app, id);
      if (cap !== null) {
        const countRows = await app.db.execute<{ count: number }>(sql`
          SELECT COUNT(*)::int AS count FROM competition_participants
           WHERE competition_id = ${id}::uuid
        `);
        if (Number(countRows[0]?.count ?? 0) >= cap) {
          throw new ConflictError("competition_full", "competition_full");
        }
      }

      // Insert + denormalised counter bump in one tx. The
      // ON CONFLICT DO NOTHING keeps repeat POSTs idempotent without
      // a SELECT-then-INSERT race.
      const result = await app.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(competitionParticipants)
          .values({ competitionId: id, userId: u.id })
          .onConflictDoNothing()
          .returning({ joinedAt: competitionParticipants.joinedAt });
        const isNew = inserted.length > 0;
        if (isNew) {
          await tx
            .update(competitions)
            .set({ participantCount: sql`${competitions.participantCount} + 1` })
            .where(eq(competitions.id, id));
        }
        // On the no-op path, fetch the existing joined_at so the
        // response is faithful even when nothing was inserted.
        if (!isNew) {
          const [existing] = await tx
            .select({ joinedAt: competitionParticipants.joinedAt })
            .from(competitionParticipants)
            .where(
              and(
                eq(competitionParticipants.competitionId, id),
                eq(competitionParticipants.userId, u.id),
              ),
            )
            .limit(1);
          return { joinedAt: existing?.joinedAt ?? new Date(), isNew: false };
        }
        return { joinedAt: inserted[0]!.joinedAt, isNew: true };
      });

      // PRD acceptance criteria NOTIF_25/NOTIF_26: a fresh join
      // auto-enables Competition Updates unless the user has
      // manually toggled the pref OFF beforehand. Idempotent + race-
      // safe (single UPSERT) — see ensureCompetitionUpdatesEnabled.
      // Skip on alreadyJoined; the user has presumably been getting
      // updates already.
      if (result.isNew) {
        // Fire-and-forget: pref auto-enable must not block the join
        // response. `void` makes intent explicit (no missing await).
        void ensureCompetitionUpdatesEnabled(app, u.id).catch((err: unknown) => {
          app.log.warn(
            { err, userId: u.id, competitionId: id },
            "competition_updates auto-enable failed",
          );
        });

        // If the bet-close window is within 24h, fire a one-shot
        // `competition_deadline` so the joiner sees something useful
        // in their panel without waiting for a cron worker. The
        // future cron (PRD: future Iframe-era reminders) will fan
        // out reminders to joined users at T-2h; that's a
        // settlement/cron concern outside this PR.
        const hoursToClose =
          (comp.betCloseAt.getTime() - Date.now()) / (60 * 60 * 1000);
        if (hoursToClose > 0 && hoursToClose <= 24) {
          // Fire-and-forget deadline reminder; logged on failure.
          void emitNotification(app, {
            userId: u.id,
            type: "competition_deadline",
            // System emit — no actor. The PRD's competition_deadline
            // copy ("'Weekend Warriors' closes in 2 hours") leads
            // with the comp name, not a name.
            actorId: null,
            payload: {
              competitionId: id,
              competitionTitle: comp.title,
              hoursRemaining: Math.max(1, Math.round(hoursToClose)),
            },
            // No group_key: each unique deadline reminder should
            // surface separately (a future cron may emit T-24h, T-2h
            // — collapsing them would lose the urgency progression).
            deepLink: `/community/competitions/${encodeURIComponent(id)}`,
          }).catch((err: unknown) => {
            app.log.warn(
              { err, userId: u.id, competitionId: id },
              "competition_deadline emit failed",
            );
          });
        }
      }

      return {
        competitionId: id,
        joinedAt: result.joinedAt.toISOString(),
        alreadyJoined: !result.isNew,
      };
    },
  );

  // ─── POST /community/competitions/:id/predictions ─────────────────────────
  //
  // Submit or update one prediction. Idempotent on
  // (competition_match_id, user_id) — the second POST of the same
  // shape returns the existing row; a different shape updates in
  // place. Predictions lock at kickoff (timing-lock-kickoff +
  // optional timing-grace-period).
  app.post<{ Params: { id: string } }>(
    "/community/competitions/:id/predictions",
    { config: writeRateLimit },
    async (request): Promise<CreatePredictionResponse> => {
      const u = request.requireAuth();
      const { id } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();
      const body: CreatePredictionRequest = createPredictionBody.parse(request.body);
      const competitionMatchId = BigInt(body.competitionMatchId);

      // 1. Comp + type check. We need the type to enforce tip
      // shape rules; we need the status to block on ended.
      const [comp] = await app.db
        .select({
          id: competitions.id,
          type: competitions.type,
          status: competitions.status,
        })
        .from(competitions)
        .where(eq(competitions.id, id))
        .limit(1);
      if (!comp) throw new NotFoundError();
      if (comp.status === "draft" || comp.status === "ended") {
        throw new BadRequestError("competition_not_open", "competition_not_open");
      }

      // Type-shape enforcement. Tipping comps require a tip;
      // prediction-only comps reject one. Challenge comps accept
      // either (rules drive scoring).
      enforceTipShape(comp.type as CompetitionType, body.tip);

      // 2. Match must belong to this comp.
      const [match] = await app.db
        .select({
          id: competitionMatches.id,
          kickoffAt: competitionMatches.kickoffAt,
          cancelled: competitionMatches.cancelled,
        })
        .from(competitionMatches)
        .where(
          and(
            eq(competitionMatches.id, competitionMatchId),
            eq(competitionMatches.competitionId, id),
          ),
        )
        .limit(1);
      if (!match) {
        throw new NotFoundError("prediction_match_not_found");
      }
      if (match.cancelled) {
        throw new BadRequestError("prediction_locked", "prediction_locked");
      }

      // 3. Timing lock. kickoff + grace_period.
      const graceMinutes = await getGraceMinutes(app, id);
      const lockAt = new Date(match.kickoffAt.getTime() + graceMinutes * 60_000);
      if (Date.now() >= lockAt.getTime()) {
        throw new BadRequestError("prediction_locked", "prediction_locked");
      }

      // 4. Caller must have joined the comp. We don't auto-join on
      // first-prediction because the UI funnel always shows the
      // JoinPanel CTA first; auto-join would make the funnel
      // measurement noisy.
      const [participant] = await app.db
        .select({ userId: competitionParticipants.userId })
        .from(competitionParticipants)
        .where(
          and(
            eq(competitionParticipants.competitionId, id),
            eq(competitionParticipants.userId, u.id),
          ),
        )
        .limit(1);
      if (!participant) {
        throw new BadRequestError("competition_not_open", "competition_not_open");
      }

      // 5. Upsert. ON CONFLICT (match_id, user_id) DO UPDATE — we
      // intentionally allow updates pre-lock. The FE keeps the
      // user inside their own picks UX without surfacing a 409.
      const inserted = await app.db
        .insert(competitionPredictions)
        .values({
          competitionId: id,
          competitionMatchId,
          userId: u.id,
          predictedScoreA: body.predictedScoreA,
          predictedScoreB: body.predictedScoreB,
          tip: body.tip ?? null,
        })
        .onConflictDoUpdate({
          target: [
            competitionPredictions.competitionMatchId,
            competitionPredictions.userId,
          ],
          set: {
            predictedScoreA: body.predictedScoreA,
            predictedScoreB: body.predictedScoreB,
            tip: body.tip ?? null,
            placedAt: sql`now()`,
          },
        })
        .returning({
          id: competitionPredictions.id,
          predictedScoreA: competitionPredictions.predictedScoreA,
          predictedScoreB: competitionPredictions.predictedScoreB,
          tip: competitionPredictions.tip,
          placedAt: competitionPredictions.placedAt,
          pointsAwarded: competitionPredictions.pointsAwarded,
          outcome: competitionPredictions.outcome,
          settledAt: competitionPredictions.settledAt,
        });
      const row = inserted[0];
      if (!row) throw new Error("prediction insert returned no row");

      const prediction: ViewerPrediction = {
        id: row.id.toString(),
        predictedScoreA: row.predictedScoreA,
        predictedScoreB: row.predictedScoreB,
        tip: (row.tip ?? null) as ViewerPrediction["tip"],
        placedAt: row.placedAt.toISOString(),
        pointsAwarded: row.pointsAwarded,
        outcome: (row.outcome ?? null) as ViewerPrediction["outcome"],
        settledAt: row.settledAt ? row.settledAt.toISOString() : null,
      };
      return { prediction };
    },
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function enforceTipShape(type: CompetitionType, tip: string | undefined): void {
  if (type === "tipping" && !tip) {
    throw new BadRequestError("tip_required", "tip_required");
  }
  if (type === "prediction" && tip !== undefined) {
    throw new BadRequestError("tip_not_allowed", "tip_not_allowed");
  }
}

// Per-competition rule cache. Rules are immutable post-publish so a
// modest TTL is safe; the v1 suffix lets us reshape the cached payload
// later without flushing. Draft-mutation invalidation is intentionally
// not wired up: rules can't change on a published competition and the
// hot paths (join, predict) only run against published comps anyway.
const RULES_CACHE_TTL_SECONDS = 60;
function rulesCacheKey(competitionId: string): string {
  return `competition:rules:${competitionId}:v1`;
}

type CompetitionRulesMap = Record<string, string | null>;

async function loadCompetitionRules(
  app: FastifyInstance,
  competitionId: string,
): Promise<CompetitionRulesMap> {
  return cached(
    app.redis,
    rulesCacheKey(competitionId),
    RULES_CACHE_TTL_SECONDS,
    async () => {
      const rows = await app.db
        .select({
          ruleId: competitionRules.ruleId,
          value: competitionRules.value,
        })
        .from(competitionRules)
        .where(eq(competitionRules.competitionId, competitionId));
      const out: CompetitionRulesMap = {};
      for (const r of rows) out[r.ruleId] = r.value;
      return out;
    },
  );
}

async function getGraceMinutes(
  app: FastifyInstance,
  competitionId: string,
): Promise<number> {
  const rules = await loadCompetitionRules(app, competitionId);
  const raw = rules["timing-grace-period"] ?? null;
  const parsed = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function getMaxParticipantsCap(
  app: FastifyInstance,
  competitionId: string,
): Promise<number | null> {
  const rules = await loadCompetitionRules(app, competitionId);
  const raw = rules["eligibility-max-participants"] ?? null;
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function loadCompetitionDetail(
  app: FastifyInstance,
  id: string,
  viewerId: string | null,
): Promise<CompetitionDetail> {
  // L4 rewrite: the legacy query ran two separate subqueries that
  // looked up the same (competition_id, viewerId) participant row —
  // once for viewerJoined (EXISTS) and once inside the viewerRank
  // self-join (`me`). Fold into one viewer_row CTE so the index
  // probe happens once; both fields read from it.
  const detailRows = await app.db.execute<Record<string, unknown>>(sql`
WITH viewer_row AS (
  SELECT user_id, points, longest_streak
    FROM competition_participants
   WHERE competition_id = ${id}::uuid
     AND user_id = ${viewerId}::uuid
)
SELECT
  c.id                   AS "id",
  c.title                AS "title",
  c.description          AS "description",
  c.type::text           AS "type",
  c.status::text         AS "status",
  c.sport_id             AS "sportId",
  s.slug                 AS "sportSlug",
  s.name                 AS "sportName",
  c.league               AS "league",
  c.launch_at            AS "launchAt",
  c.bet_close_at         AS "betCloseAt",
  c.match_start_at       AS "matchStartAt",
  c.stop_show_at         AS "stopShowAt",
  c.banner_url           AS "bannerUrl",
  c.thumbnail_url        AS "thumbnailUrl",
  c.featured             AS "featured",
  c.markets              AS "markets",
  c.participant_count    AS "participantCount",
  c.match_count          AS "matchCount",
  cu.nickname            AS "createdByNickname",
  CASE
    WHEN ${viewerId}::uuid IS NULL THEN NULL
    ELSE EXISTS (SELECT 1 FROM viewer_row)
  END                    AS "viewerJoined",
  -- Viewer rank. Reads (points, longest_streak) from viewer_row to
  -- count strict-greater participants; +1 gives the viewer's rank.
  -- viewer_row is empty when the viewer isn't joined → rank NULL.
  -- Excludes AI seed bettors so the denominator matches the
  -- leaderboard view.
  CASE WHEN ${viewerId}::uuid IS NULL THEN NULL
       WHEN NOT EXISTS (SELECT 1 FROM viewer_row) THEN NULL
       ELSE (
         SELECT COUNT(*)::int + 1
           FROM competition_participants p
           CROSS JOIN viewer_row v
           INNER JOIN users pu ON pu.id = p.user_id AND pu.is_ai = false
          WHERE p.competition_id = c.id
            AND (p.points, p.longest_streak) > (v.points, v.longest_streak)
       )
  END                    AS "viewerRank"
  FROM competitions c
  LEFT JOIN sports s ON s.id = c.sport_id
  LEFT JOIN users cu ON cu.id = c.created_by
 WHERE c.id = ${id}::uuid
 LIMIT 1
`);
  const row = detailRows[0];
  if (!row) throw new NotFoundError();

  const ruleRows = await app.db
    .select({
      ruleId: competitionRules.ruleId,
      value: competitionRules.value,
      sortOrder: competitionRules.sortOrder,
    })
    .from(competitionRules)
    .where(eq(competitionRules.competitionId, id))
    .orderBy(competitionRules.sortOrder);
  const ruleAssignments: CompetitionRuleAssignment[] = ruleRows.map((r) => ({
    ruleId: r.ruleId,
    value: r.value ?? undefined,
  }));

  const summary = normaliseCompetitionSummary(row);
  return {
    ...summary,
    description: String(row.description ?? ""),
    rules: renderRules(ruleAssignments),
    ruleAssignments,
    createdByNickname: (row.createdByNickname as string | null) ?? null,
  };
}

function normaliseCompetitionSummary(
  r: Record<string, unknown>,
): CompetitionSummary {
  return {
    id: String(r.id),
    title: String(r.title),
    type: String(r.type) as CompetitionSummary["type"],
    status: String(r.status) as CompetitionSummary["status"],
    sportId: r.sportId === null || r.sportId === undefined ? null : Number(r.sportId),
    sportSlug: (r.sportSlug as string | null) ?? null,
    sportName: (r.sportName as string | null) ?? null,
    league: (r.league as string | null) ?? null,
    launchAt: toIso(r.launchAt),
    betCloseAt: toIso(r.betCloseAt),
    matchStartAt: toIso(r.matchStartAt),
    stopShowAt: toIso(r.stopShowAt),
    bannerUrl: (r.bannerUrl as string | null) ?? null,
    thumbnailUrl: (r.thumbnailUrl as string | null) ?? null,
    featured: Boolean(r.featured),
    markets: ((r.markets as string[] | null) ?? []),
    participantCount: Number(r.participantCount ?? 0),
    matchCount: Number(r.matchCount ?? 0),
    viewerJoined: r.viewerJoined === null ? null : Boolean(r.viewerJoined),
    viewerRank:
      r.viewerRank === null || r.viewerRank === undefined
        ? null
        : Number(r.viewerRank),
  };
}

function normaliseMatchRow(r: Record<string, unknown>): CompetitionMatchRow {
  const vp = r.viewerPrediction as Record<string, unknown> | null;
  return {
    id: String(r.id),
    competitionId: String(r.competitionId),
    matchId: r.matchId === null || r.matchId === undefined ? null : String(r.matchId),
    teamA: String(r.teamA),
    teamB: String(r.teamB),
    league: String(r.league ?? ""),
    kickoffAt: toIso(r.kickoffAt),
    status: String(r.status) as CompetitionMatchRow["status"],
    scoreA: r.scoreA === null || r.scoreA === undefined ? null : Number(r.scoreA),
    scoreB: r.scoreB === null || r.scoreB === undefined ? null : Number(r.scoreB),
    suspended: Boolean(r.suspended),
    cancelled: Boolean(r.cancelled),
    viewerPrediction: vp
      ? {
          id: String(vp.id),
          predictedScoreA: Number(vp.predictedScoreA),
          predictedScoreB: Number(vp.predictedScoreB),
          tip: (vp.tip ?? null) as ViewerPrediction["tip"],
          placedAt: toIso(vp.placedAt),
          pointsAwarded:
            vp.pointsAwarded === null || vp.pointsAwarded === undefined
              ? null
              : Number(vp.pointsAwarded),
          outcome: (vp.outcome ?? null) as ViewerPrediction["outcome"],
          settledAt: vp.settledAt ? toIso(vp.settledAt) : null,
        }
      : null,
  };
}

function normaliseLeaderboardEntry(
  r: Record<string, unknown>,
): CompetitionLeaderboardEntry {
  return {
    rank: Number(r.rank),
    userId: String(r.userId),
    nickname: String(r.nickname),
    avatarUrl: resolveOptionalAvatarUrl(
      r.avatarSlug
        ? {
            slug: r.avatarSlug as string,
            imagePath: (r.avatarImagePath as string | null) ?? null,
          }
        : null,
    ),
    points: Number(r.points ?? 0),
    correctCount: Number(r.correctCount ?? 0),
    totalSettled: Number(r.totalSettled ?? 0),
    winRatePct:
      r.winRatePct === null || r.winRatePct === undefined ? null : Number(r.winRatePct),
    streak: Number(r.streak ?? 0),
    longestStreak: Number(r.longestStreak ?? 0),
    recentResults: ((r.recentResults as string[] | null) ?? []).filter(
      (o): o is "correct" | "partial" | "wrong" | "void" =>
        o === "correct" || o === "partial" || o === "wrong" || o === "void",
    ),
    isYou: Boolean(r.isYou),
    // rankDelta: 0 in V1 (no historical snapshots yet). Phase 11.5
    // adds a settled-at-snapshot table to compute deltas; until then
    // the FE shows no caret.
    rankDelta: 0,
  };
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") {
    // Postgres returns timestamps as "YYYY-MM-DD HH:MM:SS.fff+TZ"
    // through execute() raw queries; coerce to ISO-8601 so the wire
    // shape matches Drizzle-typed selects (which already return
    // Date) and the FE doesn't have to special-case the format.
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return v;
  }
  return new Date(0).toISOString();
}

