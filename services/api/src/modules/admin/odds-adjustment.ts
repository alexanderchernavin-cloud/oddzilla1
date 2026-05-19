// /admin/users/:userId/odds-adjustment — per-bettor odds adjustment
// editor.
//
// Cascade at catalog read / placement time (see migration 0070):
//   match > tournament > sport > global (per user)
// First non-NULL override wins. Without any row the bettor sees the
// standard published_odds.
//
// Admin-only. Every mutation writes admin_audit_log. There is no
// implicit seed row — an unconfigured bettor has zero rows; the global
// row only exists once an admin sets it (and DELETE on global is
// supported, unlike the live-delay floor).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  bettorOddsAdjustmentConfig,
  adminAuditLog,
  sports,
  tournaments,
  categories,
  matches,
  users,
} from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";

// Pub/sub channel ws-gateway subscribes to. Every PUT/DELETE here
// publishes the affected userId; the gateway drops that user's cached
// cascade so the next live odds tick re-loads from PG. Single channel
// (not per-user) keeps ws-gateway's Redis subscriber set small.
const ADJUSTMENT_INVALIDATE_CHANNEL = "bettor_adjustment_invalidated";

async function publishInvalidate(
  app: FastifyInstance,
  userId: string,
): Promise<void> {
  try {
    await app.redis.publish(ADJUSTMENT_INVALIDATE_CHANNEL, userId);
  } catch (err) {
    // Best-effort — a publish failure leaves the ws-gateway with a
    // slightly stale cascade until the next connection or process
    // restart. The placement / bet-delay paths still re-derive on
    // every tx, so wagers remain correct.
    app.log.warn(
      { err: (err as Error).message, userId },
      "bettor adjustment invalidate publish failed",
    );
  }
}

interface OverrideDto {
  id: string;
  adjustmentBp: number;
  updatedAt: string;
  updatedBy: string | null;
}

// Tree-row DTOs mirror the live-delay editor so the storefront tree
// component can stay one piece of code. `override` is the row directly
// on this entity (if any). `effective` is what the cascade resolves to
// when no deeper override exists; `effectiveSource` names the level the
// effective value came from so the UI can render an "Inherits sport"
// hint when the row carries no override of its own.
type Source = "global" | "sport" | "tournament" | "match" | "none";

interface SportRowDto {
  id: number;
  slug: string;
  name: string;
  override: OverrideDto | null;
  effectiveAdjustmentBp: number; // 0 = no rule
  effectiveSource: Source;
}

interface TournamentRowDto {
  id: number;
  slug: string;
  name: string;
  startAt: string | null;
  endAt: string | null;
  riskTier: number | null;
  override: OverrideDto | null;
  effectiveAdjustmentBp: number;
  effectiveSource: Source;
}

interface MatchRowDto {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: string;
  override: OverrideDto | null;
  effectiveAdjustmentBp: number;
  effectiveSource: Source;
}

const bpBody = z.object({
  adjustmentBp: z.number().int().min(-9000).max(9000),
});

const userIdParam = z.object({ userId: z.string().uuid() });

function rowToOverrideDto(
  row: typeof bettorOddsAdjustmentConfig.$inferSelect,
): OverrideDto {
  return {
    id: row.id.toString(),
    adjustmentBp: row.adjustmentBp,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

async function loadGlobal(
  db: FastifyInstance["db"],
  userId: string,
): Promise<typeof bettorOddsAdjustmentConfig.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(bettorOddsAdjustmentConfig)
    .where(
      and(
        eq(bettorOddsAdjustmentConfig.userId, userId),
        eq(bettorOddsAdjustmentConfig.scope, "global"),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function assertUserExists(db: FastifyInstance["db"], userId: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new NotFoundError("user_not_found", "user_not_found");
}

export default async function adminOddsAdjustmentRoutes(app: FastifyInstance) {
  // ── Summary ────────────────────────────────────────────────────────
  // Lightweight payload for the "Odds adjustment" card on the user
  // detail page: just the global override (if any) + counts of
  // per-scope overrides. The full tree loads on demand from the sub-page.
  app.get("/admin/users/:userId/odds-adjustment", async (request) => {
    request.requireRole("admin");
    const { userId } = userIdParam.parse(request.params);
    await assertUserExists(app.db, userId);

    const rows = await app.db
      .select()
      .from(bettorOddsAdjustmentConfig)
      .where(eq(bettorOddsAdjustmentConfig.userId, userId));

    const global = rows.find((r) => r.scope === "global") ?? null;
    let sportCount = 0;
    let tournamentCount = 0;
    let matchCount = 0;
    for (const r of rows) {
      if (r.scope === "sport") sportCount += 1;
      else if (r.scope === "tournament") tournamentCount += 1;
      else if (r.scope === "match") matchCount += 1;
    }

    return {
      global: global ? rowToOverrideDto(global) : null,
      counts: {
        sport: sportCount,
        tournament: tournamentCount,
        match: matchCount,
      },
    };
  });

  // ── Tree: sports level ─────────────────────────────────────────────
  app.get("/admin/users/:userId/odds-adjustment/sports", async (request) => {
    request.requireRole("admin");
    const { userId } = userIdParam.parse(request.params);
    await assertUserExists(app.db, userId);

    const global = await loadGlobal(app.db, userId);
    const globalBp = global?.adjustmentBp ?? 0;

    const rows = await app.db
      .select({
        id: sports.id,
        slug: sports.slug,
        name: sports.name,
        overrideId: bettorOddsAdjustmentConfig.id,
        overrideBp: bettorOddsAdjustmentConfig.adjustmentBp,
        overrideUpdatedAt: bettorOddsAdjustmentConfig.updatedAt,
        overrideUpdatedBy: bettorOddsAdjustmentConfig.updatedBy,
      })
      .from(sports)
      .leftJoin(
        bettorOddsAdjustmentConfig,
        and(
          eq(bettorOddsAdjustmentConfig.scope, "sport"),
          eq(bettorOddsAdjustmentConfig.userId, userId),
          eq(bettorOddsAdjustmentConfig.sportId, sports.id),
        ),
      )
      .where(eq(sports.active, true))
      .orderBy(sports.name);

    const entries: SportRowDto[] = rows.map((r) => {
      const override =
        r.overrideId !== null
          ? {
              id: r.overrideId.toString(),
              adjustmentBp: r.overrideBp!,
              updatedAt: r.overrideUpdatedAt!.toISOString(),
              updatedBy: r.overrideUpdatedBy,
            }
          : null;
      if (override) {
        return {
          id: r.id,
          slug: r.slug,
          name: r.name,
          override,
          effectiveAdjustmentBp: override.adjustmentBp,
          effectiveSource: "sport",
        };
      }
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        override: null,
        effectiveAdjustmentBp: globalBp,
        effectiveSource: global ? "global" : "none",
      };
    });

    return {
      global: global ? rowToOverrideDto(global) : null,
      entries,
    };
  });

  // ── Tree: tournaments under a sport ─────────────────────────────────
  app.get(
    "/admin/users/:userId/odds-adjustment/sports/:sportId/tournaments",
    async (request) => {
      request.requireRole("admin");
      const { userId } = userIdParam.parse(request.params);
      const { sportId } = z
        .object({ sportId: z.coerce.number().int().positive() })
        .parse(request.params);
      await assertUserExists(app.db, userId);

      const global = await loadGlobal(app.db, userId);
      const [sportOverride] = await app.db
        .select()
        .from(bettorOddsAdjustmentConfig)
        .where(
          and(
            eq(bettorOddsAdjustmentConfig.userId, userId),
            eq(bettorOddsAdjustmentConfig.scope, "sport"),
            eq(bettorOddsAdjustmentConfig.sportId, sportId),
          ),
        )
        .limit(1);

      const [sportRow] = await app.db
        .select({ id: sports.id, name: sports.name, slug: sports.slug })
        .from(sports)
        .where(eq(sports.id, sportId))
        .limit(1);
      if (!sportRow) throw new NotFoundError("sport_not_found", "sport_not_found");

      const rows = await app.db
        .select({
          id: tournaments.id,
          slug: tournaments.slug,
          name: tournaments.name,
          startAt: tournaments.startAt,
          endAt: tournaments.endAt,
          riskTier: tournaments.riskTier,
          overrideId: bettorOddsAdjustmentConfig.id,
          overrideBp: bettorOddsAdjustmentConfig.adjustmentBp,
          overrideUpdatedAt: bettorOddsAdjustmentConfig.updatedAt,
          overrideUpdatedBy: bettorOddsAdjustmentConfig.updatedBy,
        })
        .from(tournaments)
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .leftJoin(
          bettorOddsAdjustmentConfig,
          and(
            eq(bettorOddsAdjustmentConfig.scope, "tournament"),
            eq(bettorOddsAdjustmentConfig.userId, userId),
            eq(bettorOddsAdjustmentConfig.tournamentId, tournaments.id),
          ),
        )
        .where(and(eq(categories.sportId, sportId), eq(tournaments.active, true)))
        .orderBy(tournaments.name);

      // Effective bp + source for any tournament without its own
      // override — falls back to sport, then global, then 0.
      const inheritedFromSport = sportOverride?.adjustmentBp ?? null;
      const parentBp =
        inheritedFromSport !== null
          ? inheritedFromSport
          : (global?.adjustmentBp ?? 0);
      const parentSource: Source =
        inheritedFromSport !== null ? "sport" : global ? "global" : "none";

      const entries: TournamentRowDto[] = rows.map((r) => {
        const override =
          r.overrideId !== null
            ? {
                id: r.overrideId.toString(),
                adjustmentBp: r.overrideBp!,
                updatedAt: r.overrideUpdatedAt!.toISOString(),
                updatedBy: r.overrideUpdatedBy,
              }
            : null;
        return {
          id: r.id,
          slug: r.slug,
          name: r.name,
          startAt: r.startAt?.toISOString() ?? null,
          endAt: r.endAt?.toISOString() ?? null,
          riskTier: r.riskTier,
          override,
          effectiveAdjustmentBp: override?.adjustmentBp ?? parentBp,
          effectiveSource: override ? "tournament" : parentSource,
        };
      });

      return {
        sport: sportRow,
        global: global ? rowToOverrideDto(global) : null,
        inheritedFromSport,
        entries,
      };
    },
  );

  // ── Tree: matches under a tournament ────────────────────────────────
  app.get(
    "/admin/users/:userId/odds-adjustment/tournaments/:tournamentId/matches",
    async (request) => {
      request.requireRole("admin");
      const { userId } = userIdParam.parse(request.params);
      const { tournamentId } = z
        .object({ tournamentId: z.coerce.number().int().positive() })
        .parse(request.params);
      await assertUserExists(app.db, userId);

      const global = await loadGlobal(app.db, userId);

      const [tnt] = await app.db
        .select({
          id: tournaments.id,
          name: tournaments.name,
          slug: tournaments.slug,
          riskTier: tournaments.riskTier,
          sportId: categories.sportId,
        })
        .from(tournaments)
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .where(eq(tournaments.id, tournamentId))
        .limit(1);
      if (!tnt)
        throw new NotFoundError("tournament_not_found", "tournament_not_found");

      const [tournamentOverride] = await app.db
        .select()
        .from(bettorOddsAdjustmentConfig)
        .where(
          and(
            eq(bettorOddsAdjustmentConfig.userId, userId),
            eq(bettorOddsAdjustmentConfig.scope, "tournament"),
            eq(bettorOddsAdjustmentConfig.tournamentId, tournamentId),
          ),
        )
        .limit(1);
      const [sportOverride] = await app.db
        .select()
        .from(bettorOddsAdjustmentConfig)
        .where(
          and(
            eq(bettorOddsAdjustmentConfig.userId, userId),
            eq(bettorOddsAdjustmentConfig.scope, "sport"),
            eq(bettorOddsAdjustmentConfig.sportId, tnt.sportId),
          ),
        )
        .limit(1);
      const inheritedFromTournament = tournamentOverride?.adjustmentBp ?? null;
      const inheritedFromSport = sportOverride?.adjustmentBp ?? null;

      const parentBp =
        inheritedFromTournament !== null
          ? inheritedFromTournament
          : inheritedFromSport !== null
            ? inheritedFromSport
            : (global?.adjustmentBp ?? 0);
      const parentSource: Source =
        inheritedFromTournament !== null
          ? "tournament"
          : inheritedFromSport !== null
            ? "sport"
            : global
              ? "global"
              : "none";

      const rows = await app.db
        .select({
          id: matches.id,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          scheduledAt: matches.scheduledAt,
          status: matches.status,
          overrideId: bettorOddsAdjustmentConfig.id,
          overrideBp: bettorOddsAdjustmentConfig.adjustmentBp,
          overrideUpdatedAt: bettorOddsAdjustmentConfig.updatedAt,
          overrideUpdatedBy: bettorOddsAdjustmentConfig.updatedBy,
        })
        .from(matches)
        .leftJoin(
          bettorOddsAdjustmentConfig,
          and(
            eq(bettorOddsAdjustmentConfig.scope, "match"),
            eq(bettorOddsAdjustmentConfig.userId, userId),
            eq(bettorOddsAdjustmentConfig.matchId, matches.id),
          ),
        )
        .where(
          and(
            eq(matches.tournamentId, tournamentId),
            sql`${matches.status} IN ('not_started','live')`,
          ),
        )
        .orderBy(sql`${matches.scheduledAt} ASC NULLS LAST`)
        .limit(500);

      const entries: MatchRowDto[] = rows.map((r) => {
        const override =
          r.overrideId !== null
            ? {
                id: r.overrideId.toString(),
                adjustmentBp: r.overrideBp!,
                updatedAt: r.overrideUpdatedAt!.toISOString(),
                updatedBy: r.overrideUpdatedBy,
              }
            : null;
        return {
          id: r.id.toString(),
          homeTeam: r.homeTeam,
          awayTeam: r.awayTeam,
          scheduledAt: r.scheduledAt?.toISOString() ?? null,
          status: r.status,
          override,
          effectiveAdjustmentBp: override?.adjustmentBp ?? parentBp,
          effectiveSource: override ? "match" : parentSource,
        };
      });

      return {
        tournament: {
          id: tnt.id,
          name: tnt.name,
          slug: tnt.slug,
          riskTier: tnt.riskTier,
          sportId: tnt.sportId,
        },
        global: global ? rowToOverrideDto(global) : null,
        inheritedFromSport,
        inheritedFromTournament,
        entries,
      };
    },
  );

  // ── Mutations ──────────────────────────────────────────────────────

  // PUT /admin/users/:userId/odds-adjustment/global — upsert.
  app.put(
    "/admin/users/:userId/odds-adjustment/global",
    async (request) => {
      const admin = request.requireRole("admin");
      const { userId } = userIdParam.parse(request.params);
      await assertUserExists(app.db, userId);
      const body = bpBody.parse(request.body);

      const before = await loadGlobal(app.db, userId);
      const result = await app.db.transaction(async (tx) => {
        const [row] = before
          ? await tx
              .update(bettorOddsAdjustmentConfig)
              .set({
                adjustmentBp: body.adjustmentBp,
                updatedBy: admin.id,
                updatedAt: new Date(),
              })
              .where(eq(bettorOddsAdjustmentConfig.id, before.id))
              .returning()
          : await tx
              .insert(bettorOddsAdjustmentConfig)
              .values({
                userId,
                scope: "global",
                adjustmentBp: body.adjustmentBp,
                updatedBy: admin.id,
              })
              .returning();
        if (!row) throw new Error("global upsert returned no row");
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: before
            ? "bettor_odds_adjustment.global_update"
            : "bettor_odds_adjustment.global_create",
          targetType: "bettor_odds_adjustment_config",
          targetId: `user:${userId}:global`,
          beforeJson: before
            ? (rowToOverrideDto(before) as unknown as Record<string, unknown>)
            : null,
          afterJson: rowToOverrideDto(row) as unknown as Record<string, unknown>,
          ipInet: request.ip ?? null,
        });
        return row;
      });

      await publishInvalidate(app, userId);
      return rowToOverrideDto(result);
    },
  );

  // DELETE /admin/users/:userId/odds-adjustment/global — clear.
  app.delete(
    "/admin/users/:userId/odds-adjustment/global",
    async (request) => {
      const admin = request.requireRole("admin");
      const { userId } = userIdParam.parse(request.params);
      await assertUserExists(app.db, userId);

      const before = await loadGlobal(app.db, userId);
      if (!before) {
        throw new NotFoundError("override_not_found", "override_not_found");
      }
      await app.db.transaction(async (tx) => {
        await tx
          .delete(bettorOddsAdjustmentConfig)
          .where(eq(bettorOddsAdjustmentConfig.id, before.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "bettor_odds_adjustment.global_delete",
          targetType: "bettor_odds_adjustment_config",
          targetId: `user:${userId}:global`,
          beforeJson: rowToOverrideDto(before) as unknown as Record<string, unknown>,
          afterJson: null,
          ipInet: request.ip ?? null,
        });
      });
      await publishInvalidate(app, userId);
      return { ok: true };
    },
  );

  // Generic scope upsert + delete for sport / tournament / match. Same
  // shape as live-delay.ts but the row is keyed by (user, scope, ref)
  // instead of (scope, ref).
  function registerScopeRoutes<TIdParam extends z.ZodTypeAny>(opts: {
    scope: "sport" | "tournament" | "match";
    paramName: string;
    paramSchema: TIdParam;
    setRefId: (
      id: z.infer<TIdParam>,
    ) =>
      | { sportId: number }
      | { tournamentId: number }
      | { matchId: bigint };
    parentNotFound: (id: z.infer<TIdParam>) => Promise<boolean>;
    routePrefix: string;
  }) {
    const path = `/admin/users/:userId/odds-adjustment/${opts.routePrefix}/:${opts.paramName}`;

    app.put(path, async (request) => {
      const admin = request.requireRole("admin");
      const { userId } = userIdParam.parse(request.params);
      await assertUserExists(app.db, userId);
      const params = z
        .object({ [opts.paramName]: opts.paramSchema })
        .parse(request.params) as Record<string, z.infer<TIdParam>>;
      const id = params[opts.paramName]!;
      const body = bpBody.parse(request.body);

      if (await opts.parentNotFound(id)) {
        throw new NotFoundError(`${opts.scope}_not_found`, `${opts.scope}_not_found`);
      }

      const refIdSet = opts.setRefId(id);
      const refIdStr =
        "matchId" in refIdSet
          ? refIdSet.matchId.toString()
          : "tournamentId" in refIdSet
            ? refIdSet.tournamentId.toString()
            : refIdSet.sportId.toString();

      const [before] = await app.db
        .select()
        .from(bettorOddsAdjustmentConfig)
        .where(
          and(
            eq(bettorOddsAdjustmentConfig.userId, userId),
            eq(bettorOddsAdjustmentConfig.scope, opts.scope),
            "matchId" in refIdSet
              ? eq(bettorOddsAdjustmentConfig.matchId, refIdSet.matchId)
              : "tournamentId" in refIdSet
                ? eq(bettorOddsAdjustmentConfig.tournamentId, refIdSet.tournamentId)
                : eq(bettorOddsAdjustmentConfig.sportId, refIdSet.sportId),
          ),
        )
        .limit(1);

      const result = await app.db.transaction(async (tx) => {
        const [row] = before
          ? await tx
              .update(bettorOddsAdjustmentConfig)
              .set({
                adjustmentBp: body.adjustmentBp,
                updatedBy: admin.id,
                updatedAt: new Date(),
              })
              .where(eq(bettorOddsAdjustmentConfig.id, before.id))
              .returning()
          : await tx
              .insert(bettorOddsAdjustmentConfig)
              .values({
                userId,
                scope: opts.scope,
                ...refIdSet,
                adjustmentBp: body.adjustmentBp,
                updatedBy: admin.id,
              })
              .returning();
        if (!row) throw new Error("scope upsert returned no row");
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: before
            ? `bettor_odds_adjustment.${opts.scope}_update`
            : `bettor_odds_adjustment.${opts.scope}_create`,
          targetType: "bettor_odds_adjustment_config",
          targetId: `user:${userId}:${opts.scope}:${refIdStr}`,
          beforeJson: before
            ? (rowToOverrideDto(before) as unknown as Record<string, unknown>)
            : null,
          afterJson: rowToOverrideDto(row) as unknown as Record<string, unknown>,
          ipInet: request.ip ?? null,
        });
        return row;
      });
      await publishInvalidate(app, userId);
      return rowToOverrideDto(result);
    });

    app.delete(path, async (request) => {
      const admin = request.requireRole("admin");
      const { userId } = userIdParam.parse(request.params);
      await assertUserExists(app.db, userId);
      const params = z
        .object({ [opts.paramName]: opts.paramSchema })
        .parse(request.params) as Record<string, z.infer<TIdParam>>;
      const id = params[opts.paramName]!;

      const refIdSet = opts.setRefId(id);
      const refIdStr =
        "matchId" in refIdSet
          ? refIdSet.matchId.toString()
          : "tournamentId" in refIdSet
            ? refIdSet.tournamentId.toString()
            : refIdSet.sportId.toString();

      const [before] = await app.db
        .select()
        .from(bettorOddsAdjustmentConfig)
        .where(
          and(
            eq(bettorOddsAdjustmentConfig.userId, userId),
            eq(bettorOddsAdjustmentConfig.scope, opts.scope),
            "matchId" in refIdSet
              ? eq(bettorOddsAdjustmentConfig.matchId, refIdSet.matchId)
              : "tournamentId" in refIdSet
                ? eq(bettorOddsAdjustmentConfig.tournamentId, refIdSet.tournamentId)
                : eq(bettorOddsAdjustmentConfig.sportId, refIdSet.sportId),
          ),
        )
        .limit(1);
      if (!before) {
        throw new NotFoundError("override_not_found", "override_not_found");
      }
      await app.db.transaction(async (tx) => {
        await tx
          .delete(bettorOddsAdjustmentConfig)
          .where(eq(bettorOddsAdjustmentConfig.id, before.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: `bettor_odds_adjustment.${opts.scope}_delete`,
          targetType: "bettor_odds_adjustment_config",
          targetId: `user:${userId}:${opts.scope}:${refIdStr}`,
          beforeJson: rowToOverrideDto(before) as unknown as Record<string, unknown>,
          afterJson: null,
          ipInet: request.ip ?? null,
        });
      });
      await publishInvalidate(app, userId);
      return { ok: true };
    });
  }

  registerScopeRoutes({
    scope: "sport",
    paramName: "sportId",
    paramSchema: z.coerce.number().int().positive(),
    setRefId: (id: number) => ({ sportId: id }),
    parentNotFound: async (id: number) => {
      const [row] = await app.db
        .select({ id: sports.id })
        .from(sports)
        .where(eq(sports.id, id))
        .limit(1);
      return !row;
    },
    routePrefix: "sport",
  });

  registerScopeRoutes({
    scope: "tournament",
    paramName: "tournamentId",
    paramSchema: z.coerce.number().int().positive(),
    setRefId: (id: number) => ({ tournamentId: id }),
    parentNotFound: async (id: number) => {
      const [row] = await app.db
        .select({ id: tournaments.id })
        .from(tournaments)
        .where(eq(tournaments.id, id))
        .limit(1);
      return !row;
    },
    routePrefix: "tournament",
  });

  registerScopeRoutes({
    scope: "match",
    paramName: "matchId",
    paramSchema: z
      .string()
      .regex(/^\d+$/, "matchId must be a positive integer")
      .transform((s) => BigInt(s)),
    setRefId: (id: bigint) => ({ matchId: id }),
    parentNotFound: async (id: bigint) => {
      const [row] = await app.db
        .select({ id: matches.id })
        .from(matches)
        .where(eq(matches.id, id))
        .limit(1);
      return !row;
    },
    routePrefix: "match",
  });

  // Block accidental `PUT /scope/something` URLs — there's no flat
  // /odds-adjustment/scope/:x endpoint, every scope has its own path.
  app.put(
    "/admin/users/:userId/odds-adjustment/scope/:_anything",
    async () => {
      throw new BadRequestError(
        "use_scope_specific_endpoint",
        "use_scope_specific_endpoint",
      );
    },
  );
}
