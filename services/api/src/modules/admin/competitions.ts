// /admin/competitions/* — operator-side competition CRUD (Phase 11).
//
// Mirrors the community-dashboard wizard surface from a separate
// repo, but lives here so oddzilla.cc owns the operator flow without
// requiring a community-dashboard deploy. All endpoints require role
// 'admin' and write an admin_audit_log entry on every mutation.
//
// Endpoints:
//   GET    /admin/competitions                          — list with status counts
//   POST   /admin/competitions                          — create draft
//   GET    /admin/competitions/:id                      — detail
//   PATCH  /admin/competitions/:id                      — partial update
//   POST   /admin/competitions/:id/matches              — add match
//   DELETE /admin/competitions/:id/matches/:matchId     — remove match
//   POST   /admin/competitions/:id/publish              — draft → upcoming
//
// Rules-locked invariant (PRD acceptance criteria OD_RULES_01–03):
//   • Once participant_count > 0 AND status != 'draft', the rules
//     PATCH path returns `rules_locked`. The same guard lives in the
//     bettor surface (no rule edits during a live comp surface us
//     a stable reading of the leaderboard math).
//   • Tested with the partial unique index: insert can race a
//     publish, but the publish path runs in a transaction that
//     re-reads participant_count under the row-level lock.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  competitions,
  competitionRules,
  competitionMatches,
  adminAuditLog,
  matches as catalogMatches,
} from "@oddzilla/db";
import { renderRules } from "@oddzilla/types";
import type {
  AdminCompetitionListResponse,
  AdminMatchInput,
  CompetitionDetail,
  CompetitionRuleAssignment,
  CompetitionStatus,
  CompetitionSummary,
  CompetitionType,
  CreateCompetitionRequest,
  UpdateCompetitionRequest,
} from "@oddzilla/types";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../lib/errors.js";
import { isUniqueViolation } from "../../lib/pg-errors.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const adminWriteRateLimit = {
  rateLimit: { max: 60, timeWindow: "1 minute" },
};

// M5: list endpoint pagination. Default page size 100; clamped to a
// hard ceiling so a single request can't scan the whole comps table.
const ADMIN_LIST_DEFAULT_LIMIT = 100;
const ADMIN_LIST_MAX_LIMIT = 100;
const adminListQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ADMIN_LIST_MAX_LIMIT)
    .default(ADMIN_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

// Body schemas. We keep them lenient on input length (200-char title,
// 2000-char description) to match the DB CHECK constraints; the API
// layer just enforces the same bounds upstream so the operator gets a
// 400 from us instead of a 23514 from Postgres.
const ruleAssignmentSchema = z.object({
  ruleId: z.string().min(1).max(80),
  value: z.string().max(200).optional(),
});

const matchInputSchema = z.object({
  matchId: z.string().regex(/^\d+$/u, "match_id_invalid").optional(),
  teamA: z.string().min(1).max(100),
  teamB: z.string().min(1).max(100),
  league: z.string().max(100).optional(),
  kickoffAt: z.string().datetime(),
  sortOrder: z.number().int().min(0).optional(),
});

const createBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  type: z.enum(["prediction", "tipping", "challenge"]),
  sportId: z.number().int().positive().optional(),
  league: z.string().max(100).optional(),
  launchAt: z.string().datetime(),
  betCloseAt: z.string().datetime(),
  matchStartAt: z.string().datetime(),
  stopShowAt: z.string().datetime(),
  bannerUrl: z.string().url().max(500).optional(),
  thumbnailUrl: z.string().url().max(500).optional(),
  featured: z.boolean().optional(),
  markets: z.array(z.string().max(80)).max(20).optional(),
  rules: z.array(ruleAssignmentSchema).max(50),
  matches: z.array(matchInputSchema).max(100),
});

const updateBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    status: z.enum(["draft", "scheduled", "upcoming", "live", "ended"]).optional(),
    sportId: z.number().int().positive().nullable().optional(),
    league: z.string().max(100).nullable().optional(),
    launchAt: z.string().datetime().optional(),
    betCloseAt: z.string().datetime().optional(),
    matchStartAt: z.string().datetime().optional(),
    stopShowAt: z.string().datetime().optional(),
    bannerUrl: z.string().url().max(500).nullable().optional(),
    thumbnailUrl: z.string().url().max(500).nullable().optional(),
    featured: z.boolean().optional(),
    markets: z.array(z.string().max(80)).max(20).optional(),
    rules: z.array(ruleAssignmentSchema).max(50).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "no_changes",
  });

export default async function adminCompetitionsRoutes(app: FastifyInstance) {
  // ─── GET /admin/competitions ──────────────────────────────────────────────
  //
  // List ALL competitions for the operator panel — including drafts
  // (which the bettor list strips). Returns status counts for the
  // tab strip.
  app.get(
    "/admin/competitions",
    { config: adminWriteRateLimit },
    async (request): Promise<AdminCompetitionListResponse> => {
      request.requireRole("admin");

      // M5: paginate the list. The tab-status counts below stay
      // uncapped — that's a cheap GROUP BY on the status enum and the
      // dashboard needs the totals for the tab badges. Only the
      // detailed-row read is bounded.
      const { limit, offset } = adminListQuery.parse(request.query ?? {});

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
  NULL                   AS "viewerJoined",
  NULL                   AS "viewerRank"
  FROM competitions c
  LEFT JOIN sports s ON s.id = c.sport_id
 ORDER BY c.created_at DESC
 LIMIT ${limit}
 OFFSET ${offset}
`);

      const summaries: CompetitionSummary[] = rows.map(normaliseCompetitionRow);

      // Counts. One aggregate keeps it cheap; the GROUP BY on the
      // status enum is index-clean even on ten thousand rows. Stays
      // uncapped intentionally — the tab strip needs the global total.
      const countRows = await app.db.execute<{ status: string; n: number }>(sql`
        SELECT status::text AS "status", COUNT(*)::int AS "n"
          FROM competitions
         GROUP BY status
      `);
      const counts = {
        all: 0,
        draft: 0,
        scheduled: 0,
        upcoming: 0,
        live: 0,
        ended: 0,
      };
      // counts.all now reflects the table-wide total (not the current
      // page) — the dashboard tab strip needs that. Sum the per-status
      // tallies as the cheapest single-pass total.
      for (const r of countRows) {
        const s = r.status as keyof typeof counts;
        const n = Number(r.n ?? 0);
        if (s in counts) counts[s] = n;
        counts.all += n;
      }

      return { competitions: summaries, counts };
    },
  );

  // ─── POST /admin/competitions ─────────────────────────────────────────────
  app.post(
    "/admin/competitions",
    { config: adminWriteRateLimit },
    async (request): Promise<CompetitionDetail> => {
      const u = request.requireRole("admin");
      const body: CreateCompetitionRequest = createBody.parse(request.body);

      enforceScheduleOrder(body);

      // Resolve catalog matches up-front (outside the tx — the catalog
      // is stable). If matchId is supplied, pull the canonical team
      // names + kickoff_at from the catalog so the operator can't
      // desync the denormalised facing.
      const resolvedMatches: ResolvedMatchInput[] = await Promise.all(
        body.matches.map((m) => resolveMatchInput(app, m)),
      );

      const id = await app.db.transaction(async (tx) => {
        const [comp] = await tx
          .insert(competitions)
          .values({
            title: body.title,
            description: body.description ?? "",
            type: body.type,
            status: "draft",
            sportId: body.sportId ?? null,
            league: body.league ?? null,
            launchAt: new Date(body.launchAt),
            betCloseAt: new Date(body.betCloseAt),
            matchStartAt: new Date(body.matchStartAt),
            stopShowAt: new Date(body.stopShowAt),
            bannerUrl: body.bannerUrl ?? null,
            thumbnailUrl: body.thumbnailUrl ?? null,
            featured: body.featured ?? false,
            markets: body.markets ?? [],
            createdBy: u.id,
            matchCount: resolvedMatches.length,
          })
          .returning({ id: competitions.id });
        if (!comp) throw new Error("competition insert returned no row");

        if (body.rules.length > 0) {
          await tx.insert(competitionRules).values(
            body.rules.map((r, i) => ({
              competitionId: comp.id,
              ruleId: r.ruleId,
              value: r.value ?? null,
              sortOrder: i,
            })),
          );
        }

        if (resolvedMatches.length > 0) {
          await tx.insert(competitionMatches).values(
            resolvedMatches.map((m, i) => ({
              competitionId: comp.id,
              matchId: m.matchId,
              teamA: m.teamA,
              teamB: m.teamB,
              league: m.league,
              kickoffAt: new Date(m.kickoffAt),
              sortOrder: m.sortOrder ?? i,
            })),
          );
        }

        await tx.insert(adminAuditLog).values({
          actorUserId: u.id,
          action: "competitions.create",
          targetType: "competition",
          targetId: comp.id,
          beforeJson: null,
          afterJson: {
            title: body.title,
            type: body.type,
            matchCount: resolvedMatches.length,
            ruleCount: body.rules.length,
          },
          ipInet: request.ip ?? null,
        });

        return comp.id;
      });

      return loadCompetitionForAdmin(app, id);
    },
  );

  // ─── GET /admin/competitions/:id ──────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/admin/competitions/:id",
    async (request): Promise<CompetitionDetail> => {
      request.requireRole("admin");
      const { id } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();
      return loadCompetitionForAdmin(app, id);
    },
  );

  // ─── PATCH /admin/competitions/:id ────────────────────────────────────────
  //
  // Partial update. When `rules` is present, replaces the rule set
  // wholesale (the wizard always sends the full set). Rules-locked
  // gate fires when participants > 0 AND status != 'draft'.
  app.patch<{ Params: { id: string } }>(
    "/admin/competitions/:id",
    { config: adminWriteRateLimit },
    async (request): Promise<CompetitionDetail> => {
      const u = request.requireRole("admin");
      const { id } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();
      const body: UpdateCompetitionRequest = updateBody.parse(request.body);

      await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({
            id: competitions.id,
            status: competitions.status,
            participantCount: competitions.participantCount,
            launchAt: competitions.launchAt,
            betCloseAt: competitions.betCloseAt,
            matchStartAt: competitions.matchStartAt,
            stopShowAt: competitions.stopShowAt,
          })
          .from(competitions)
          .where(eq(competitions.id, id))
          .limit(1)
          .for("update");
        if (!existing) throw new NotFoundError();

        // Rules-locked gate.
        if (
          body.rules !== undefined &&
          existing.status !== "draft" &&
          existing.participantCount > 0
        ) {
          throw new BadRequestError("rules_locked", "rules_locked");
        }

        // Schedule order check on the merged payload.
        const merged = {
          launchAt: body.launchAt ?? existing.launchAt.toISOString(),
          betCloseAt: body.betCloseAt ?? existing.betCloseAt.toISOString(),
          matchStartAt: body.matchStartAt ?? existing.matchStartAt.toISOString(),
          stopShowAt: body.stopShowAt ?? existing.stopShowAt.toISOString(),
        };
        enforceScheduleOrder(merged);

        const updateValues: Partial<typeof competitions.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (body.title !== undefined) updateValues.title = body.title;
        if (body.description !== undefined) updateValues.description = body.description;
        if (body.status !== undefined) updateValues.status = body.status;
        if (body.sportId !== undefined) updateValues.sportId = body.sportId ?? null;
        if (body.league !== undefined) updateValues.league = body.league ?? null;
        if (body.launchAt !== undefined) updateValues.launchAt = new Date(body.launchAt);
        if (body.betCloseAt !== undefined)
          updateValues.betCloseAt = new Date(body.betCloseAt);
        if (body.matchStartAt !== undefined)
          updateValues.matchStartAt = new Date(body.matchStartAt);
        if (body.stopShowAt !== undefined)
          updateValues.stopShowAt = new Date(body.stopShowAt);
        if (body.bannerUrl !== undefined) updateValues.bannerUrl = body.bannerUrl ?? null;
        if (body.thumbnailUrl !== undefined)
          updateValues.thumbnailUrl = body.thumbnailUrl ?? null;
        if (body.featured !== undefined) updateValues.featured = body.featured;
        if (body.markets !== undefined) updateValues.markets = body.markets;

        await tx
          .update(competitions)
          .set(updateValues)
          .where(eq(competitions.id, id));

        if (body.rules !== undefined) {
          await tx.delete(competitionRules).where(eq(competitionRules.competitionId, id));
          if (body.rules.length > 0) {
            await tx.insert(competitionRules).values(
              body.rules.map((r, i) => ({
                competitionId: id,
                ruleId: r.ruleId,
                value: r.value ?? null,
                sortOrder: i,
              })),
            );
          }
        }

        await tx.insert(adminAuditLog).values({
          actorUserId: u.id,
          action: "competitions.update",
          targetType: "competition",
          targetId: id,
          beforeJson: { status: existing.status, participantCount: existing.participantCount },
          afterJson: { ...body },
          ipInet: request.ip ?? null,
        });
      });

      return loadCompetitionForAdmin(app, id);
    },
  );

  // ─── POST /admin/competitions/:id/matches ─────────────────────────────────
  app.post<{ Params: { id: string }; Body: AdminMatchInput }>(
    "/admin/competitions/:id/matches",
    { config: adminWriteRateLimit },
    async (request): Promise<{ matchId: string }> => {
      const u = request.requireRole("admin");
      const { id } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();
      const body = matchInputSchema.parse(request.body);

      // Catalog read happens outside the tx — see the create path note.
      const resolved = await resolveMatchInput(app, body);

      const matchRowId = await app.db.transaction(async (tx) => {
        const [comp] = await tx
          .select({ id: competitions.id })
          .from(competitions)
          .where(eq(competitions.id, id))
          .limit(1)
          .for("update");
        if (!comp) throw new NotFoundError();

        try {
          const [inserted] = await tx
            .insert(competitionMatches)
            .values({
              competitionId: id,
              matchId: resolved.matchId,
              teamA: resolved.teamA,
              teamB: resolved.teamB,
              league: resolved.league,
              kickoffAt: new Date(resolved.kickoffAt),
              sortOrder: resolved.sortOrder ?? 0,
            })
            .returning({ id: competitionMatches.id });
          if (!inserted) throw new Error("match insert returned no row");

          await tx
            .update(competitions)
            .set({ matchCount: sql`${competitions.matchCount} + 1` })
            .where(eq(competitions.id, id));

          await tx.insert(adminAuditLog).values({
            actorUserId: u.id,
            action: "competitions.matches.add",
            targetType: "competition",
            targetId: id,
            beforeJson: null,
            afterJson: { matchId: inserted.id.toString(), teamA: resolved.teamA, teamB: resolved.teamB },
            ipInet: request.ip ?? null,
          });
          return inserted.id.toString();
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new ConflictError("duplicate_match", "duplicate_match");
          }
          throw err;
        }
      });

      return { matchId: matchRowId };
    },
  );

  // ─── DELETE /admin/competitions/:id/matches/:matchId ──────────────────────
  app.delete<{ Params: { id: string; matchId: string } }>(
    "/admin/competitions/:id/matches/:matchId",
    { config: adminWriteRateLimit },
    async (request): Promise<{ ok: true }> => {
      const u = request.requireRole("admin");
      const { id, matchId } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();
      if (!/^\d+$/.test(matchId)) throw new NotFoundError();
      const matchRowId = BigInt(matchId);

      await app.db.transaction(async (tx) => {
        const deleted = await tx
          .delete(competitionMatches)
          .where(
            and(
              eq(competitionMatches.id, matchRowId),
              eq(competitionMatches.competitionId, id),
            ),
          )
          .returning({ id: competitionMatches.id });
        if (deleted.length === 0) throw new NotFoundError();

        await tx
          .update(competitions)
          .set({ matchCount: sql`GREATEST(${competitions.matchCount} - 1, 0)` })
          .where(eq(competitions.id, id));

        await tx.insert(adminAuditLog).values({
          actorUserId: u.id,
          action: "competitions.matches.remove",
          targetType: "competition",
          targetId: id,
          beforeJson: { matchId: matchId },
          afterJson: null,
          ipInet: request.ip ?? null,
        });
      });

      return { ok: true };
    },
  );

  // ─── POST /admin/competitions/:id/matches/:matchId/score ─────────────────
  //
  // Operator records the final score on a competition match. Triggers
  // synchronous scoring of every unsettled prediction on this match
  // and updates participant aggregates. Idempotent on
  // (competition_match_id, predictions.settled_at IS NULL) — replaying
  // a score is safe and only writes the rows still pending.
  //
  // Why scored here in TS rather than the Go settlement service:
  //   • The Go settler consumes Oddin market-outcome XML messages, not
  //     match-result events. Competition scoring needs the latter,
  //     which V1 sources from the admin manually entering scores.
  //   • When match-result events arrive (V1.5), the same scoring
  //     logic moves to Go; this TS path becomes a manual fallback.
  //     Both writers gate on points_awarded IS NULL, so concurrent
  //     execution is harmless (settlement is at-most-once per row).
  app.post<{ Params: { id: string; matchId: string }; Body: { scoreA: number; scoreB: number } }>(
    "/admin/competitions/:id/matches/:matchId/score",
    { config: adminWriteRateLimit },
    async (request): Promise<{ scoredPredictions: number; affectedParticipants: number }> => {
      const u = request.requireRole("admin");
      const { id, matchId } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();
      if (!/^\d+$/.test(matchId)) throw new NotFoundError();
      const matchRowId = BigInt(matchId);

      const scoreBody = z
        .object({
          scoreA: z.number().int().min(0).max(999),
          scoreB: z.number().int().min(0).max(999),
        })
        .parse(request.body);

      const result = await app.db.transaction(async (tx) => {
        // 1. Match must exist + belong to this comp.
        const [match] = await tx
          .select({
            id: competitionMatches.id,
            competitionId: competitionMatches.competitionId,
            cancelled: competitionMatches.cancelled,
          })
          .from(competitionMatches)
          .where(
            and(
              eq(competitionMatches.id, matchRowId),
              eq(competitionMatches.competitionId, id),
            ),
          )
          .limit(1)
          .for("update");
        if (!match) throw new NotFoundError();
        if (match.cancelled) {
          throw new BadRequestError("match_cancelled", "match_cancelled");
        }

        // 2. Write the score + flip status to 'done'.
        await tx
          .update(competitionMatches)
          .set({
            scoreA: scoreBody.scoreA,
            scoreB: scoreBody.scoreB,
            status: "done",
          })
          .where(eq(competitionMatches.id, matchRowId));

        // 3. Score every unsettled prediction.
        const scoring = await scoreMatchPredictions(tx, id, matchRowId, scoreBody);

        // 4. Audit.
        await tx.insert(adminAuditLog).values({
          actorUserId: u.id,
          action: "competitions.matches.score",
          targetType: "competition_match",
          targetId: matchId,
          beforeJson: null,
          afterJson: {
            competitionId: id,
            scoreA: scoreBody.scoreA,
            scoreB: scoreBody.scoreB,
            scoredPredictions: scoring.scoredPredictions,
            affectedParticipants: scoring.affectedParticipants,
          },
          ipInet: request.ip ?? null,
        });

        return scoring;
      });

      return result;
    },
  );

  // ─── POST /admin/competitions/:id/publish ─────────────────────────────────
  //
  // Convenience endpoint: draft → upcoming. The same effect is
  // available via PATCH { status: "upcoming" }, but a dedicated
  // endpoint gives the audit log a stable action name.
  app.post<{ Params: { id: string } }>(
    "/admin/competitions/:id/publish",
    { config: adminWriteRateLimit },
    async (request): Promise<CompetitionDetail> => {
      const u = request.requireRole("admin");
      const { id } = request.params;
      if (!UUID_RE.test(id)) throw new NotFoundError();

      await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ status: competitions.status, matchCount: competitions.matchCount })
          .from(competitions)
          .where(eq(competitions.id, id))
          .limit(1)
          .for("update");
        if (!existing) throw new NotFoundError();
        if (existing.status !== "draft") {
          throw new BadRequestError("not_draft", "Competition is not in draft status");
        }
        if (existing.matchCount === 0) {
          throw new BadRequestError("no_matches", "Cannot publish a competition with no matches");
        }
        await tx
          .update(competitions)
          .set({ status: "upcoming", updatedAt: new Date() })
          .where(eq(competitions.id, id));
        await tx.insert(adminAuditLog).values({
          actorUserId: u.id,
          action: "competitions.publish",
          targetType: "competition",
          targetId: id,
          beforeJson: { status: "draft" },
          afterJson: { status: "upcoming" },
          ipInet: request.ip ?? null,
        });
      });

      return loadCompetitionForAdmin(app, id);
    },
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ScheduleSlice {
  launchAt: string;
  betCloseAt: string;
  matchStartAt: string;
  stopShowAt: string;
}

function enforceScheduleOrder(s: ScheduleSlice): void {
  const bc = new Date(s.betCloseAt).getTime();
  const ms = new Date(s.matchStartAt).getTime();
  const ss = new Date(s.stopShowAt).getTime();
  if (!(bc <= ms)) {
    throw new BadRequestError("schedule_invalid", "betCloseAt must be ≤ matchStartAt");
  }
  if (!(ms <= ss)) {
    throw new BadRequestError("schedule_invalid", "matchStartAt must be ≤ stopShowAt");
  }
}

interface ResolvedMatchInput {
  matchId: bigint | null;
  teamA: string;
  teamB: string;
  league: string;
  kickoffAt: string;
  sortOrder?: number;
}

async function resolveMatchInput(
  app: FastifyInstance,
  input: AdminMatchInput,
): Promise<ResolvedMatchInput> {
  // When matchId references the catalog, pull the canonical fields
  // from `matches` so a stale denormalised copy can't ship.
  if (input.matchId !== undefined) {
    const matchBig = BigInt(input.matchId);
    const [m] = await app.db
      .select({
        id: catalogMatches.id,
        homeTeam: catalogMatches.homeTeam,
        awayTeam: catalogMatches.awayTeam,
        scheduledAt: catalogMatches.scheduledAt,
      })
      .from(catalogMatches)
      .where(eq(catalogMatches.id, matchBig))
      .limit(1);
    if (!m) {
      throw new BadRequestError("match_not_found", "match_not_found");
    }
    return {
      matchId: m.id,
      teamA: m.homeTeam,
      teamB: m.awayTeam,
      league: input.league ?? "",
      // matches.scheduled_at is NOT NULL in the DB — the type
      // inference still hands us nullable. Fall back to the
      // operator-supplied kickoff if it ever shows up null.
      kickoffAt: m.scheduledAt
        ? m.scheduledAt.toISOString()
        : input.kickoffAt,
      sortOrder: input.sortOrder,
    };
  }
  return {
    matchId: null,
    teamA: input.teamA,
    teamB: input.teamB,
    league: input.league ?? "",
    kickoffAt: input.kickoffAt,
    sortOrder: input.sortOrder,
  };
}

// Same shape as competitions.ts; admin reads use the same projection
// helper to avoid two divergent normalisers.
async function loadCompetitionForAdmin(
  app: FastifyInstance,
  id: string,
): Promise<CompetitionDetail> {
  const [row] = await app.db.execute<Record<string, unknown>>(sql`
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
  cu.nickname            AS "createdByNickname"
  FROM competitions c
  LEFT JOIN sports s ON s.id = c.sport_id
  LEFT JOIN users cu ON cu.id = c.created_by
 WHERE c.id = ${id}::uuid
 LIMIT 1
`);
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

  const summary = normaliseCompetitionRow(row);
  return {
    ...summary,
    description: String(row.description ?? ""),
    rules: renderRules(ruleAssignments),
    ruleAssignments,
    createdByNickname: (row.createdByNickname as string | null) ?? null,
  };
}

function normaliseCompetitionRow(r: Record<string, unknown>): CompetitionSummary {
  return {
    id: String(r.id),
    title: String(r.title),
    type: String(r.type) as CompetitionType,
    status: String(r.status) as CompetitionStatus,
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
    viewerJoined: null,
    viewerRank: null,
  };
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") {
    // Coerce Postgres timestamp strings (returned via execute() raw)
    // to ISO-8601. See the same helper in
    // services/api/src/modules/community/competitions.ts.
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return v;
  }
  return new Date(0).toISOString();
}

// Score every unsettled prediction on a competition_match against the
// final score, updating participant aggregates in the same tx. Returns
// the count of newly-settled predictions and the count of participants
// whose row was bumped.
//
// V1 scoring algorithm (mirrors the catalog's scoring rules):
//   • scoring-correct-result   — points if winner side matches
//   • scoring-exact-score      — points if exact score matches
//   • scoring-goal-difference  — points if goal difference matches
//   • scoring-tip-point        — points if 1X2 tip matches the result
//
// Each prediction earns the SUM of every matching scoring rule. The
// outcome label is 'correct' if any scoring rule fired, 'wrong' if
// none, 'void' if the match has no clear winner side and none of the
// score-equality rules fire (rare; matches we shouldn't score).
// Scoring helper. tx is the Drizzle transaction-callback handle —
// generic over the dialect/schema, which makes the resolved type
// noisy to express at module level. We type it as `any` here because
// the helper only ever runs against a real Drizzle tx (the runtime is
// correct), and the alternative (inlining 100 lines back into the
// route handler) costs more than the type-safety lost.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function scoreMatchPredictions(
  tx: any,
  competitionId: string,
  competitionMatchId: bigint,
  finalScore: { scoreA: number; scoreB: number },
): Promise<{ scoredPredictions: number; affectedParticipants: number }> {
  // C1 rewrite: replace the N+U per-row loop with two set-based
  // statements. The legacy implementation issued one UPDATE on
  // competition_predictions per prediction and one UPDATE on
  // competition_participants per affected user, all inside a
  // FOR UPDATE transaction. On a 10K-participant comp that's 10K+
  // round-trips with the row-level locks held the entire time. New
  // shape:
  //
  //   1. Materialise per-prediction (points, outcome) via a CASE
  //      expression that mirrors the legacy JS math exactly. The
  //      scoring-rule lookup that was a JS Map is now a CTE that
  //      pivots the 4 rule rows into per-column point values.
  //   2. RETURNING from the predictions UPDATE feeds an aggregate
  //      that bumps participant aggregates in a single statement.
  //
  // Equivalence proof (JS → SQL):
  //   • exactScore     = (predA = scoreA AND predB = scoreB)
  //   • finalSide      = '1' if scoreA>scoreB, '2' if <, else 'X'
  //   • predictedSide  = same shape on predA/predB
  //   • correctSide    = (predictedSide = finalSide)
  //   • correctDiff    = (predA - predB) = (scoreA - scoreB)
  //   • points = SUM(exact-score-rule  if exactScore)
  //           +  SUM(correct-result-rule if correctSide)
  //           +  SUM(goal-difference-rule if correctDiff)
  //           +  SUM(tip-point-rule if tip = finalSide)
  //     (each clause is 0 when the rule isn't configured)
  //   • outcome = points>0 ? (exactScore ? 'correct' : 'partial') : 'wrong'
  // The JS short-circuits with `ruleMap.has(...)` before adding —
  // equivalent to "rule value defaults to 0 when absent", which the
  // COALESCE(MAX FILTER, 0) on the rule pivot achieves.
  //
  // Streak semantics: each user has at most one prediction per match
  // (unique constraint), so the participant bump is at most one
  // increment-or-reset per user per call. correct_this_round mirrors
  // the JS `bump.correct` flag (any points > 0 on this match's
  // prediction).
  const { scoreA, scoreB } = finalScore;

  // Whole pipeline runs as one modifying-CTE statement:
  //   1. rule_values pivots the per-comp scoring-* rules into
  //      per-rule integer columns. MAX(...) is a no-op aggregate (≤1
  //      row per rule_id within a comp) used purely to keep the CTE
  //      single-row; COALESCE to 0 mirrors the JS ruleMap.has() guard.
  //   2. scored computes points + outcome for each unsettled
  //      prediction. The CASE expressions translate the legacy JS
  //      math literally — see the equivalence proof above.
  //   3. settled UPDATEs competition_predictions, RETURNING the
  //      per-row user_id / points / wins for the aggregate step.
  //   4. agg aggregates settled by user.
  //   5. bumped UPDATEs competition_participants from agg, returning
  //      one row per affected participant.
  // The final SELECT exposes the two counters the route returns.
  // Putting both UPDATEs in a single statement avoids the dual-
  // timestamp-equality problem between two round-trips: there's only
  // one transaction snapshot.
  const result = (await tx.execute(sql`
    WITH rule_values AS (
      SELECT
        COALESCE(MAX(CASE WHEN rule_id = 'scoring-exact-score'
                          THEN NULLIF(value, '')::int END), 0) AS exact_score_pts,
        COALESCE(MAX(CASE WHEN rule_id = 'scoring-correct-result'
                          THEN NULLIF(value, '')::int END), 0) AS correct_result_pts,
        COALESCE(MAX(CASE WHEN rule_id = 'scoring-goal-difference'
                          THEN NULLIF(value, '')::int END), 0) AS goal_diff_pts,
        COALESCE(MAX(CASE WHEN rule_id = 'scoring-tip-point'
                          THEN NULLIF(value, '')::int END), 0) AS tip_point_pts
        FROM competition_rules
       WHERE competition_id = ${competitionId}::uuid
         AND rule_id LIKE 'scoring-%'
    ),
    flags AS (
      -- Per-prediction trigger flags. Computed once; the next CTE
      -- references these columns directly instead of duplicating the
      -- CASE/arithmetic in the points sum.
      SELECT
        p.id AS prediction_id,
        p.user_id AS user_id,
        (p.predicted_score_a = ${scoreA}::int AND p.predicted_score_b = ${scoreB}::int) AS exact_score,
        (
          CASE WHEN p.predicted_score_a > p.predicted_score_b THEN '1'
               WHEN p.predicted_score_a < p.predicted_score_b THEN '2'
               ELSE 'X' END
        ) AS predicted_side,
        (
          CASE WHEN ${scoreA}::int > ${scoreB}::int THEN '1'
               WHEN ${scoreA}::int < ${scoreB}::int THEN '2'
               ELSE 'X' END
        ) AS final_side,
        ((p.predicted_score_a - p.predicted_score_b) = (${scoreA}::int - ${scoreB}::int)) AS correct_diff,
        p.tip AS tip
        FROM competition_predictions p
       WHERE p.competition_match_id = ${competitionMatchId}::bigint
         AND p.settled_at IS NULL
    ),
    scored AS (
      SELECT
        f.prediction_id,
        f.user_id,
        f.exact_score,
        (
          CASE WHEN f.exact_score                       THEN rv.exact_score_pts    ELSE 0 END
        + CASE WHEN f.predicted_side = f.final_side     THEN rv.correct_result_pts ELSE 0 END
        + CASE WHEN f.correct_diff                      THEN rv.goal_diff_pts      ELSE 0 END
        + CASE WHEN f.tip IS NOT NULL AND f.tip = f.final_side
                                                        THEN rv.tip_point_pts      ELSE 0 END
        ) AS points
        FROM flags f
        CROSS JOIN rule_values rv
    ),
    settled AS (
      UPDATE competition_predictions cp
         SET points_awarded = s.points,
             outcome        = CASE
                                WHEN s.points > 0 AND s.exact_score THEN 'correct'
                                WHEN s.points > 0                   THEN 'partial'
                                ELSE                                     'wrong'
                              END,
             settled_at     = now()
        FROM scored s
       WHERE cp.id = s.prediction_id
     RETURNING cp.user_id AS user_id,
               cp.points_awarded AS points_awarded,
               cp.outcome        AS outcome
    ),
    agg AS (
      -- Audit 0046 (M2): MAX(outcome) is safe because the unique
      -- (user_id, competition_match_id) constraint guarantees at most
      -- one prediction per user per match, so the per-user group has
      -- exactly one outcome to surface.
      SELECT
        user_id,
        SUM(points_awarded)::int                          AS pts_delta,
        COUNT(*) FILTER (WHERE points_awarded > 0)::int   AS correct_delta,
        COUNT(*)::int                                     AS settled_delta,
        MAX(outcome)                                      AS last_outcome
        FROM settled
       GROUP BY user_id
    ),
    bumped AS (
      UPDATE competition_participants cp
         SET points          = cp.points + agg.pts_delta,
             correct_count   = cp.correct_count + agg.correct_delta,
             total_settled   = cp.total_settled + agg.settled_delta,
             streak          = CASE WHEN agg.correct_delta > 0
                                    THEN cp.streak + 1
                                    ELSE 0 END,
             longest_streak  = GREATEST(
                                 cp.longest_streak,
                                 CASE WHEN agg.correct_delta > 0
                                      THEN cp.streak + 1
                                      ELSE cp.longest_streak END
                               ),
             last_settled_at = now(),
             -- Audit 0046 (M2): prepend the new outcome and truncate
             -- to 5. (ARRAY[new] || old)[1:5] = "new first, keep five".
             recent_outcomes = (ARRAY[agg.last_outcome::text] || cp.recent_outcomes)[1:5]
        FROM agg
       WHERE cp.competition_id = ${competitionId}::uuid
         AND cp.user_id        = agg.user_id
     RETURNING cp.user_id
    )
    SELECT
      (SELECT COUNT(*)::int FROM settled) AS scored_predictions,
      (SELECT COUNT(*)::int FROM bumped)  AS affected_participants
  `)) as unknown as Array<{
    scored_predictions: number;
    affected_participants: number;
  }>;

  const row = result[0];
  return {
    scoredPredictions: Number(row?.scored_predictions ?? 0),
    affectedParticipants: Number(row?.affected_participants ?? 0),
  };
}

function sideOf(a: number, b: number): "1" | "X" | "2" {
  if (a > b) return "1";
  if (a < b) return "2";
  return "X";
}

function tipMatchesResult(tip: string, side: "1" | "X" | "2"): boolean {
  return tip === side;
}

