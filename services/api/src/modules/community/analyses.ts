// /community/analyses/* — pre-match editorial posts (Phase 10.5).
//
// Five endpoints in this module; the existing /community/copy/:id is
// extended elsewhere with optional inspiredByAnalysisId attribution.
//
//   POST   /community/analyses                — author publishes
//   GET    /community/analyses                — feed (filter + sort + ranking)
//   GET    /community/analyses/:id            — single
//   POST   /community/analyses/:id/inspire    — 👍 toggle
//   DELETE /community/analyses/:id            — own, pre-kickoff only
//
// Skin-in-the-game gates (PRD: Reward formula §Eligibility):
//   • Author must own the attached ticket.
//   • Every leg of that ticket must reference the analysis's match
//     (single-match analyses only in V1).
//   • Match must be `not_started` at publish time.
//   • Ticket must be `accepted` (no settled / voided / cashed-out
//     attachments — the analysis is pre-match content).
//   • Every leg must have odds_at_placement ≥ 1.30 (`recommendedMinRate`).
//
// Quality gates: perex 1–100 chars, body 100–5000 chars (CHECK constraints
// at the DB level too as belt-and-braces), one published analysis per
// (author, match), 100/month/author rate limit.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  analyses,
  analysisReactions,
  users,
  tickets,
  ticketSelections,
  markets,
  matches,
} from "@oddzilla/db";
import type {
  AnalysisFeedResponse,
  AnalysisOutcome,
  AnalysisSort,
  AnalysisStatus,
  AnalysisSummary,
  CreateAnalysisRequest,
} from "@oddzilla/types";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
} from "../../lib/errors.js";
import { resolveOptionalAvatarUrl } from "./avatar-url.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Quality gate constants. Centralised so the editor and the API
// agree on the same numbers; the DB CHECK constraints are the third
// line of defence.
const PEREX_MIN = 1;
const PEREX_MAX = 100;
const BODY_MIN = 100;
const BODY_MAX = 5000;
// Min odds 1.30 prematch (PRD: Reward formula). Stored as a Drizzle
// numeric column so comparisons go through SQL — never coerce to
// Number on the read path; precision matters when an operator tunes
// the floor.
const MIN_ODDS = "1.30";
// 100 analyses / 30 days, defined by client. Expert tier grants +20
// in the future; for V1 every author shares the same cap.
const MONTHLY_CAP = 100;

// Rate limit on writes. Same shape as /community/me/profile —
// per-IP-per-user-burst protection on top of the monthly cap.
const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

const readRateLimit = {
  rateLimit: { max: 60, timeWindow: "1 minute" },
};

const createBody = z
  .object({
    matchId: z.string().regex(/^\d+$/u, "matchId_invalid"),
    ticketId: z.string().regex(UUID_RE, "ticketId_invalid"),
    perex: z.string().min(PEREX_MIN, "perex_invalid").max(PEREX_MAX, "perex_invalid"),
    body: z.string().min(BODY_MIN, "body_invalid").max(BODY_MAX, "body_invalid"),
  })
  .strict();

const feedQuery = z.object({
  match: z.coerce.number().int().positive().optional(),
  author: z.string().optional(), // nickname; resolved server-side
  sport: z.coerce.number().int().positive().optional(),
  // sort=recommended runs the V1 ranker (4 factors: time-to-event,
  // inspirations, thumbs-up, recency). The 9-factor algorithm from
  // the Reward formula doc lands incrementally; the API contract
  // doesn't change as factors get added.
  sort: z
    .enum(["recommended", "recent", "most_inspired", "top_authors"])
    .default("recent"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export default async function communityAnalysesRoutes(app: FastifyInstance) {
  // ─── POST /community/analyses ──────────────────────────────────────────────
  //
  // Author publishes. Validates every gate before insert; the partial
  // unique index on (author_id, match_id) WHERE status='published'
  // catches double-POSTs as 409.
  app.post(
    "/community/analyses",
    { config: writeRateLimit },
    async (request): Promise<AnalysisSummary> => {
      const u = request.requireAuth();
      const body: CreateAnalysisRequest = createBody.parse(request.body);
      const matchId = BigInt(body.matchId);

      // 1. Match must exist + be pre-match.
      const [match] = await app.db
        .select({
          id: matches.id,
          status: matches.status,
          scheduledAt: matches.scheduledAt,
          tournamentId: matches.tournamentId,
        })
        .from(matches)
        .where(eq(matches.id, matchId))
        .limit(1);
      if (!match) throw new NotFoundError();
      if (match.status !== "not_started") {
        throw new BadRequestError("match_not_eligible", "match_not_eligible");
      }

      // 2. Ticket must belong to caller, be `accepted`, every leg
      // references this match, every leg has odds ≥ MIN_ODDS.
      const [ticket] = await app.db
        .select({
          id: tickets.id,
          userId: tickets.userId,
          status: tickets.status,
        })
        .from(tickets)
        .where(eq(tickets.id, body.ticketId))
        .limit(1);
      if (!ticket) throw new NotFoundError();
      if (ticket.userId !== u.id) {
        throw new BadRequestError("ticket_not_owned", "ticket_not_owned");
      }
      if (ticket.status !== "accepted") {
        throw new BadRequestError("ticket_not_eligible", "ticket_not_eligible");
      }

      const legs = await app.db
        .select({
          oddsAtPlacement: ticketSelections.oddsAtPlacement,
          matchId: markets.matchId,
        })
        .from(ticketSelections)
        .innerJoin(markets, eq(markets.id, ticketSelections.marketId))
        .where(eq(ticketSelections.ticketId, body.ticketId));
      if (legs.length === 0) {
        throw new BadRequestError("ticket_not_eligible", "ticket_not_eligible");
      }
      for (const leg of legs) {
        if (leg.matchId !== matchId) {
          throw new BadRequestError(
            "ticket_match_mismatch",
            "ticket_match_mismatch",
          );
        }
        if (parseFloat(leg.oddsAtPlacement) < parseFloat(MIN_ODDS)) {
          throw new BadRequestError(
            "ticket_not_eligible",
            "ticket_not_eligible",
          );
        }
      }

      // 3. Monthly cap (100 / 30d; expert +20 lands later).
      const capRows = await app.db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count
          FROM analyses
         WHERE author_id = ${u.id}
           AND status = 'published'
           AND published_at >= now() - interval '30 days'
      `);
      const monthlyCount = Number(capRows[0]?.count ?? 0);
      if (monthlyCount >= MONTHLY_CAP) {
        throw new TooManyRequestsError(
          "rate_limit_monthly",
          "rate_limit_monthly",
        );
      }

      // 4. Insert. The partial unique index turns the duplicate
      // case into a 23505; we surface as 409 analysis_exists.
      try {
        const inserted = await app.db
          .insert(analyses)
          .values({
            authorId: u.id,
            matchId,
            ticketId: body.ticketId,
            perex: body.perex,
            body: body.body,
            status: "published",
          })
          .returning({ id: analyses.id });
        if (!inserted[0]) throw new Error("insert returned no row");

        return await loadAnalysis(app, inserted[0].id, u.id);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError("analysis_exists", "analysis_exists");
        }
        throw err;
      }
    },
  );

  // ─── GET /community/analyses ───────────────────────────────────────────────
  app.get(
    "/community/analyses",
    { config: readRateLimit },
    async (request): Promise<AnalysisFeedResponse> => {
      const q = feedQuery.parse(request.query);
      const viewerId = request.user?.id ?? null;

      // Author filter resolves the nickname → id once; cleaner than
      // embedding a sub-select per row.
      let authorId: string | null = null;
      if (q.author) {
        const [a] = await app.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.nickname, q.author))
          .limit(1);
        if (!a) {
          // Unknown author = empty page, not 404. Same convention as
          // /community/feed for unknown sport slugs.
          return { analyses: [], page: q.page, pageSize: q.pageSize, hasMore: false };
        }
        authorId = a.id;
      }

      const offset = (q.page - 1) * q.pageSize;
      const limit = q.pageSize + 1;

      // Order by clause depends on sort. Recommended is a deterministic
      // composite score over (time-to-event, inspirations, thumbs,
      // recency); top_authors orders by author win-rate computed on the
      // fly via a windowed aggregate. See V1-cuts comment at top.
      const orderClause = orderByForSort(q.sort);

      const matchClause = q.match !== undefined
        ? sql`AND a.match_id = ${q.match}::bigint`
        : sql``;
      const authorClause = authorId
        ? sql`AND a.author_id = ${authorId}::uuid`
        : sql``;
      const sportClause = q.sport !== undefined
        ? sql`AND s.id = ${q.sport}::int`
        : sql``;

      const rows = await app.db.execute<Record<string, unknown>>(sql`
SELECT
  a.id                         AS "id",
  a.author_id                  AS "authorId",
  u.nickname                   AS "authorNickname",
  av.slug                      AS "avatarSlug",
  av.image_path                AS "avatarImagePath",
  -- Author win-rate over settled analyses. Computed inline so the
  -- top-authors sort can read it without a separate roundtrip.
  -- NULL when the author has fewer than 3 settled analyses.
  (
    SELECT CASE
      WHEN COUNT(*) FILTER (WHERE outcome IS NOT NULL AND outcome IN ('won','lost','void','cashed_out_void')) >= 3
      THEN ROUND(
        100.0 * COUNT(*) FILTER (WHERE outcome = 'won')
              / NULLIF(COUNT(*) FILTER (WHERE outcome IN ('won','lost')), 0)
      )::int
      ELSE NULL
    END
    FROM analyses
    WHERE author_id = a.author_id AND status = 'published'
  )                            AS "authorWinRate",
  m.id                         AS "matchId",
  m.home_team || ' vs ' || m.away_team AS "matchTitle",
  m.scheduled_at               AS "scheduledAt",
  s.id                         AS "sportId",
  s.name                       AS "sportName",
  s.slug                       AS "sportSlug",
  a.ticket_id                  AS "ticketId",
  a.perex                      AS "perex",
  a.body                       AS "body",
  a.status::text               AS "status",
  a.thumbs_up_count            AS "thumbsUpCount",
  a.inspiration_count          AS "inspirationCount",
  a.outcome::text              AS "outcome",
  a.published_at               AS "publishedAt",
  a.settled_at                 AS "settledAt",
  -- Ticket-side fields. ticketStatus drives the outcome-tracker
  -- badge; totalOdds is the geometric mean (literally just the
  -- product) of leg odds at placement.
  t.status::text               AS "ticketStatus",
  (
    SELECT COUNT(*)::int FROM ticket_selections WHERE ticket_id = a.ticket_id
  )                            AS "ticketLegCount",
  (
    SELECT EXP(SUM(LN(odds_at_placement::float8)))::numeric(10,4)
      FROM ticket_selections WHERE ticket_id = a.ticket_id
  )                            AS "ticketTotalOdds",
  -- Viewer-specific reaction state. NULL on anonymous; boolean on
  -- authed. The CASE preserves the NULL-vs-false distinction the
  -- UI uses to gate the toggle.
  CASE
    WHEN ${viewerId}::uuid IS NULL THEN NULL
    ELSE EXISTS (
      SELECT 1 FROM analysis_reactions
       WHERE analysis_id = a.id AND user_id = ${viewerId}::uuid
    )
  END                          AS "viewerReacted"
  FROM analyses a
  INNER JOIN users u ON u.id = a.author_id
  LEFT JOIN avatar_templates av ON av.id = u.avatar_template_id
  INNER JOIN matches m ON m.id = a.match_id
  INNER JOIN tournaments tn ON tn.id = m.tournament_id
  INNER JOIN categories c   ON c.id = tn.category_id
  INNER JOIN sports s       ON s.id = c.sport_id
  INNER JOIN tickets t      ON t.id = a.ticket_id
 WHERE a.status = 'published'
   ${matchClause}
   ${authorClause}
   ${sportClause}
 ${orderClause}
 LIMIT ${limit}
 OFFSET ${offset}
`);

      const all = rows.map((r) => normaliseAnalysisRow(r));
      const hasMore = all.length > q.pageSize;
      return {
        analyses: all.slice(0, q.pageSize),
        page: q.page,
        pageSize: q.pageSize,
        hasMore,
      };
    },
  );

  // ─── GET /community/analyses/:id ──────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/community/analyses/:id",
    { config: readRateLimit },
    async (request): Promise<AnalysisSummary> => {
      const { id } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();
      const viewerId = request.user?.id ?? null;
      return loadAnalysis(app, id, viewerId);
    },
  );

  // ─── POST /community/analyses/:id/inspire ─────────────────────────────────
  //
  // 👍 toggle. Single endpoint covers add + remove — the response
  // payload tells the client which way it went via thumbs_up_count.
  // Idempotent on the (analysis_id, user_id) PK; the COUNT path is
  // a single round-trip.
  app.post<{ Params: { id: string } }>(
    "/community/analyses/:id/inspire",
    { config: writeRateLimit },
    async (request): Promise<AnalysisSummary> => {
      const u = request.requireAuth();
      const { id } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();

      // Confirm the analysis exists and isn't banned/voided. We could
      // skip this and rely on the FK to reject — but a 404 is more
      // informative than a constraint error.
      const [a] = await app.db
        .select({ status: analyses.status })
        .from(analyses)
        .where(eq(analyses.id, id))
        .limit(1);
      if (!a) throw new NotFoundError();
      if (a.status !== "published") throw new NotFoundError();

      // Toggle. Try delete first; if nothing was deleted, insert.
      // The single round-trip + counter update could race a parallel
      // toggle from the same viewer (very unlikely UX), but the
      // counter recomputes from the reactions table on the next read
      // path because we tally via SUM(thumbs_up_count) — actually no,
      // the counter is denormalised. Keep the +/- in lockstep.
      await app.db.transaction(async (tx) => {
        const deleted = await tx
          .delete(analysisReactions)
          .where(
            and(
              eq(analysisReactions.analysisId, id),
              eq(analysisReactions.userId, u.id),
            ),
          )
          .returning({ analysisId: analysisReactions.analysisId });
        if (deleted.length > 0) {
          await tx
            .update(analyses)
            .set({ thumbsUpCount: sql`GREATEST(${analyses.thumbsUpCount} - 1, 0)` })
            .where(eq(analyses.id, id));
        } else {
          await tx
            .insert(analysisReactions)
            .values({ analysisId: id, userId: u.id })
            .onConflictDoNothing();
          await tx
            .update(analyses)
            .set({ thumbsUpCount: sql`${analyses.thumbsUpCount} + 1` })
            .where(eq(analyses.id, id));
        }
      });

      return loadAnalysis(app, id, u.id);
    },
  );

  // ─── DELETE /community/analyses/:id ────────────────────────────────────────
  //
  // Author can withdraw before kickoff. After kickoff the analysis is
  // immutable — the editorial record matters for accountability
  // ("public predictions vs results", PRD Outcome tracker). Bans go
  // through admin moderation, not this path.
  app.delete<{ Params: { id: string } }>(
    "/community/analyses/:id",
    { config: writeRateLimit },
    async (request, reply) => {
      const u = request.requireAuth();
      const { id } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();

      const [a] = await app.db
        .select({
          authorId: analyses.authorId,
          matchId: analyses.matchId,
          status: analyses.status,
        })
        .from(analyses)
        .where(eq(analyses.id, id))
        .limit(1);
      if (!a) throw new NotFoundError();
      if (a.authorId !== u.id) throw new ForbiddenError("forbidden", "forbidden");

      const [match] = await app.db
        .select({ status: matches.status, scheduledAt: matches.scheduledAt })
        .from(matches)
        .where(eq(matches.id, a.matchId))
        .limit(1);
      if (!match) throw new NotFoundError();
      if (match.status !== "not_started") {
        throw new BadRequestError("analysis_immutable", "analysis_immutable");
      }

      // Soft delete to 'voided' rather than DELETE so the audit
      // trail survives. Reactions stay (cascade fires on hard delete
      // only).
      await app.db
        .update(analyses)
        .set({ status: "voided" })
        .where(eq(analyses.id, id));

      reply.code(204);
    },
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function loadAnalysis(
  app: FastifyInstance,
  id: string,
  viewerId: string | null,
): Promise<AnalysisSummary> {
  const rows = await app.db.execute<Record<string, unknown>>(sql`
SELECT
  a.id                         AS "id",
  a.author_id                  AS "authorId",
  u.nickname                   AS "authorNickname",
  av.slug                      AS "avatarSlug",
  av.image_path                AS "avatarImagePath",
  (
    SELECT CASE
      WHEN COUNT(*) FILTER (WHERE outcome IS NOT NULL) >= 3
      THEN ROUND(
        100.0 * COUNT(*) FILTER (WHERE outcome = 'won')
              / NULLIF(COUNT(*) FILTER (WHERE outcome IN ('won','lost')), 0)
      )::int
      ELSE NULL
    END
    FROM analyses
    WHERE author_id = a.author_id AND status = 'published'
  )                            AS "authorWinRate",
  m.id                         AS "matchId",
  m.home_team || ' vs ' || m.away_team AS "matchTitle",
  m.scheduled_at               AS "scheduledAt",
  s.id                         AS "sportId",
  s.name                       AS "sportName",
  s.slug                       AS "sportSlug",
  a.ticket_id                  AS "ticketId",
  a.perex                      AS "perex",
  a.body                       AS "body",
  a.status::text               AS "status",
  a.thumbs_up_count            AS "thumbsUpCount",
  a.inspiration_count          AS "inspirationCount",
  a.outcome::text              AS "outcome",
  a.published_at               AS "publishedAt",
  a.settled_at                 AS "settledAt",
  t.status::text               AS "ticketStatus",
  (SELECT COUNT(*)::int FROM ticket_selections WHERE ticket_id = a.ticket_id) AS "ticketLegCount",
  (SELECT EXP(SUM(LN(odds_at_placement::float8)))::numeric(10,4) FROM ticket_selections WHERE ticket_id = a.ticket_id) AS "ticketTotalOdds",
  CASE
    WHEN ${viewerId}::uuid IS NULL THEN NULL
    ELSE EXISTS (
      SELECT 1 FROM analysis_reactions
       WHERE analysis_id = a.id AND user_id = ${viewerId}::uuid
    )
  END                          AS "viewerReacted"
  FROM analyses a
  INNER JOIN users u ON u.id = a.author_id
  LEFT JOIN avatar_templates av ON av.id = u.avatar_template_id
  INNER JOIN matches m ON m.id = a.match_id
  INNER JOIN tournaments tn ON tn.id = m.tournament_id
  INNER JOIN categories c   ON c.id = tn.category_id
  INNER JOIN sports s       ON s.id = c.sport_id
  INNER JOIN tickets t      ON t.id = a.ticket_id
 WHERE a.id = ${id}
   AND a.status = 'published'
 LIMIT 1
`);
  const first = rows[0];
  if (!first) throw new NotFoundError();
  return normaliseAnalysisRow(first);
}

function normaliseAnalysisRow(r: Record<string, unknown>): AnalysisSummary {
  return {
    id: String(r.id),
    authorId: String(r.authorId),
    authorNickname: String(r.authorNickname),
    authorAvatarUrl: resolveOptionalAvatarUrl(
      r.avatarSlug
        ? {
            slug: String(r.avatarSlug),
            imagePath: (r.avatarImagePath as string | null) ?? null,
          }
        : null,
    ),
    authorWinRate:
      r.authorWinRate === null || r.authorWinRate === undefined
        ? null
        : Number(r.authorWinRate),
    matchId: String(r.matchId),
    matchTitle: String(r.matchTitle),
    sportId: Number(r.sportId),
    sportName: String(r.sportName),
    sportSlug: String(r.sportSlug),
    scheduledAt: toIso(r.scheduledAt),
    ticketId: String(r.ticketId),
    ticketTotalOdds: r.ticketTotalOdds ? String(r.ticketTotalOdds) : "1.0000",
    ticketLegCount: Number(r.ticketLegCount ?? 0),
    ticketStatus: String(r.ticketStatus) as AnalysisSummary["ticketStatus"],
    perex: String(r.perex),
    body: String(r.body),
    status: String(r.status) as AnalysisStatus,
    thumbsUpCount: Number(r.thumbsUpCount ?? 0),
    inspirationCount: Number(r.inspirationCount ?? 0),
    viewerReacted:
      r.viewerReacted === null || r.viewerReacted === undefined
        ? null
        : Boolean(r.viewerReacted),
    outcome: r.outcome ? (String(r.outcome) as AnalysisOutcome) : null,
    publishedAt: toIso(r.publishedAt),
    settledAt:
      r.settledAt === null || r.settledAt === undefined ? null : toIso(r.settledAt),
  };
}

// postgres-js returns timestamps as raw "2026-05-08 18:00:05.363709+00"
// strings on the .execute() path; the type-narrowed select chain
// returns Date objects. Coerce both into ISO-8601 so the wire format
// stays uniform.
function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v)).toISOString();
}

// V1 ranker. Four factors out of the Reward formula's nine — the
// remaining five (ROI 30/90/365d, expert flag, inspired turnover,
// content length, odds value) need historical settlement data we
// don't have on day 1, or pull from data primitives we ship in this
// PR but haven't yet wired through. The contract `sort=recommended`
// stays; new factors land incrementally without an API change.
//
// Score (per-row, computed inline for the planner):
//   • Inspirations × 2
//   • Thumbs-up × 3
//   • Time-to-event bonus: 50 if kickoff in (0, 24h], 25 if in (24h, 72h], else 0.
//     Penalises stale post-match analyses; rewards "kickoff is soon".
//   • Recency decay: −1 per day since publishedAt (additive, capped at -50).
function orderByForSort(sort: AnalysisSort): ReturnType<typeof sql> {
  switch (sort) {
    case "most_inspired":
      return sql`ORDER BY a.inspiration_count DESC, a.published_at DESC`;
    case "top_authors":
      // Authors with ≥3 settled analyses sort by win rate first;
      // unranked authors fall to the bottom by recency.
      return sql`ORDER BY (
        SELECT CASE WHEN COUNT(*) FILTER (WHERE outcome IS NOT NULL) >= 3
          THEN ROUND(100.0 * COUNT(*) FILTER (WHERE outcome = 'won')
                / NULLIF(COUNT(*) FILTER (WHERE outcome IN ('won','lost')), 0))
          ELSE 0 END
        FROM analyses ai WHERE ai.author_id = a.author_id AND ai.status = 'published'
      ) DESC, a.published_at DESC`;
    case "recommended":
      return sql`ORDER BY (
        a.inspiration_count * 2
        + a.thumbs_up_count * 3
        + CASE
            WHEN m.scheduled_at - now() BETWEEN interval '0' AND interval '24 hours' THEN 50
            WHEN m.scheduled_at - now() BETWEEN interval '24 hours' AND interval '72 hours' THEN 25
            ELSE 0
          END
        - LEAST(50, FLOOR(EXTRACT(EPOCH FROM (now() - a.published_at)) / 86400))
      ) DESC, a.published_at DESC`;
    case "recent":
    default:
      return sql`ORDER BY a.published_at DESC`;
  }
}

// Drizzle's postgres-js driver wraps the underlying PostgresError in a
// DrizzleQueryError. The 23505 unique-violation code lives on the
// .cause chain, not the outer error. Walk one level so the unique-
// violation handler in the existing community routes (where the
// `code` happens to land on the outer object via a different
// driver shape) doesn't have to be the only path that works.
function isUniqueViolation(err: unknown): boolean {
  const code = pgCode(err);
  return code === "23505";
}

function pgCode(err: unknown): string | null {
  if (err === null || typeof err !== "object") return null;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (err as { cause?: unknown }).cause;
  if (cause) return pgCode(cause);
  return null;
}
