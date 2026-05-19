// /admin/users/:userId/promo-visibility — per-bettor cascade visibility
// editor for promotional features (ZillaFlash + CombiBoost).
//
// Cascade at catalog read / placement time (see migration 0071):
//   match > tournament > sport > global  (per user, per promo_kind)
// First explicit row wins. Without any row the bettor sees the standard
// behaviour (visible=true).
//
// Admin-only. Every mutation writes admin_audit_log. Both promo kinds
// share one table with a `promo_kind` discriminator; routes carry it as
// a path segment so two separate UI columns can address each kind
// independently.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  bettorPromoVisibilityConfig,
  adminAuditLog,
  sports,
  tournaments,
  categories,
  matches,
  users,
} from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";

type PromoKind = "zillaflash" | "combi_boost";
const PROMO_KINDS = ["zillaflash", "combi_boost"] as const;

interface OverrideDto {
  id: string;
  visible: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

type Source = "global" | "sport" | "tournament" | "match" | "none";

// One row per (entity, kind) — the tree response carries an override +
// effective for both promo kinds in the same payload so the client can
// render two toggle columns per row in a single round-trip.
interface PerKindRow {
  override: OverrideDto | null;
  effectiveVisible: boolean;
  effectiveSource: Source;
}

interface SportRowDto {
  id: number;
  slug: string;
  name: string;
  zillaflash: PerKindRow;
  combi_boost: PerKindRow;
}

interface TournamentRowDto {
  id: number;
  slug: string;
  name: string;
  startAt: string | null;
  endAt: string | null;
  riskTier: number | null;
  zillaflash: PerKindRow;
  combi_boost: PerKindRow;
}

interface MatchRowDto {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: string;
  zillaflash: PerKindRow;
  combi_boost: PerKindRow;
}

const visibleBody = z.object({ visible: z.boolean() });
const userIdParam = z.object({ userId: z.string().uuid() });
const kindParam = z.object({ kind: z.enum(PROMO_KINDS) });

function rowToOverrideDto(
  row: typeof bettorPromoVisibilityConfig.$inferSelect,
): OverrideDto {
  return {
    id: row.id.toString(),
    visible: row.visible,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

async function assertUserExists(db: FastifyInstance["db"], userId: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new NotFoundError("user_not_found", "user_not_found");
}

// Load the full set of override rows for this user, partitioned by
// (promo_kind, scope, ref). Keyed maps so the tree-build code can pull
// per-entity rows in O(1).
type LoadedRows = {
  globalByKind: Map<PromoKind, typeof bettorPromoVisibilityConfig.$inferSelect>;
  bySport: Map<PromoKind, Map<number, typeof bettorPromoVisibilityConfig.$inferSelect>>;
  byTournament: Map<
    PromoKind,
    Map<number, typeof bettorPromoVisibilityConfig.$inferSelect>
  >;
  byMatch: Map<
    PromoKind,
    Map<string, typeof bettorPromoVisibilityConfig.$inferSelect>
  >;
};

async function loadAll(
  db: FastifyInstance["db"],
  userId: string,
): Promise<LoadedRows> {
  const rows = await db
    .select()
    .from(bettorPromoVisibilityConfig)
    .where(eq(bettorPromoVisibilityConfig.userId, userId));
  const out: LoadedRows = {
    globalByKind: new Map(),
    bySport: new Map(PROMO_KINDS.map((k) => [k, new Map()])),
    byTournament: new Map(PROMO_KINDS.map((k) => [k, new Map()])),
    byMatch: new Map(PROMO_KINDS.map((k) => [k, new Map()])),
  };
  for (const r of rows) {
    const kind = r.promoKind as PromoKind;
    switch (r.scope) {
      case "global":
        out.globalByKind.set(kind, r);
        break;
      case "sport":
        if (r.sportId !== null) out.bySport.get(kind)!.set(r.sportId, r);
        break;
      case "tournament":
        if (r.tournamentId !== null)
          out.byTournament.get(kind)!.set(r.tournamentId, r);
        break;
      case "match":
        if (r.matchId !== null)
          out.byMatch.get(kind)!.set(r.matchId.toString(), r);
        break;
    }
  }
  return out;
}

// Resolve effective visibility for a (kind, sportId?, tournamentId?,
// matchId?) at the tree-build site. Mirrors the read-path resolver but
// works off the LoadedRows snapshot to keep the tree build pure.
function resolveEffective(
  loaded: LoadedRows,
  kind: PromoKind,
  ids: { sportId?: number | null; tournamentId?: number | null; matchId?: bigint | null },
): { effectiveVisible: boolean; effectiveSource: Source } {
  if (ids.matchId != null) {
    const hit = loaded.byMatch.get(kind)!.get(ids.matchId.toString());
    if (hit) return { effectiveVisible: hit.visible, effectiveSource: "match" };
  }
  if (ids.tournamentId != null) {
    const hit = loaded.byTournament.get(kind)!.get(ids.tournamentId);
    if (hit) return { effectiveVisible: hit.visible, effectiveSource: "tournament" };
  }
  if (ids.sportId != null) {
    const hit = loaded.bySport.get(kind)!.get(ids.sportId);
    if (hit) return { effectiveVisible: hit.visible, effectiveSource: "sport" };
  }
  const global = loaded.globalByKind.get(kind);
  if (global) return { effectiveVisible: global.visible, effectiveSource: "global" };
  return { effectiveVisible: true, effectiveSource: "none" };
}

function makePerKindRow(
  loaded: LoadedRows,
  kind: PromoKind,
  ids: { sportId?: number | null; tournamentId?: number | null; matchId?: bigint | null },
): PerKindRow {
  let own:
    | typeof bettorPromoVisibilityConfig.$inferSelect
    | undefined;
  if (ids.matchId != null) own = loaded.byMatch.get(kind)!.get(ids.matchId.toString());
  else if (ids.tournamentId != null)
    own = loaded.byTournament.get(kind)!.get(ids.tournamentId);
  else if (ids.sportId != null) own = loaded.bySport.get(kind)!.get(ids.sportId);
  else own = loaded.globalByKind.get(kind);

  if (own) {
    return {
      override: rowToOverrideDto(own),
      effectiveVisible: own.visible,
      effectiveSource:
        ids.matchId != null
          ? "match"
          : ids.tournamentId != null
            ? "tournament"
            : ids.sportId != null
              ? "sport"
              : "global",
    };
  }
  // No own row — fall through to the cascade above us.
  const fallback = resolveEffective(
    loaded,
    kind,
    ids.matchId != null
      ? { sportId: null, tournamentId: null, matchId: null } // match row falls back to parent
      : ids.tournamentId != null
        ? { sportId: null, tournamentId: null, matchId: null }
        : ids.sportId != null
          ? { sportId: null, tournamentId: null, matchId: null }
          : { sportId: null, tournamentId: null, matchId: null },
  );
  return { override: null, ...fallback };
}

export default async function adminPromoVisibilityRoutes(app: FastifyInstance) {
  // ── Summary ────────────────────────────────────────────────────────
  app.get("/admin/users/:userId/promo-visibility", async (request) => {
    request.requireRole("admin");
    const { userId } = userIdParam.parse(request.params);
    await assertUserExists(app.db, userId);
    const loaded = await loadAll(app.db, userId);

    const summary = Object.fromEntries(
      PROMO_KINDS.map((kind) => {
        const global = loaded.globalByKind.get(kind);
        const sportCount = loaded.bySport.get(kind)!.size;
        const tournamentCount = loaded.byTournament.get(kind)!.size;
        const matchCount = loaded.byMatch.get(kind)!.size;
        return [
          kind,
          {
            global: global ? rowToOverrideDto(global) : null,
            counts: { sport: sportCount, tournament: tournamentCount, match: matchCount },
          },
        ];
      }),
    ) as Record<PromoKind, { global: OverrideDto | null; counts: { sport: number; tournament: number; match: number } }>;

    return summary;
  });

  // ── Tree: sports level ─────────────────────────────────────────────
  app.get("/admin/users/:userId/promo-visibility/sports", async (request) => {
    request.requireRole("admin");
    const { userId } = userIdParam.parse(request.params);
    await assertUserExists(app.db, userId);
    const loaded = await loadAll(app.db, userId);

    const rows = await app.db
      .select({ id: sports.id, slug: sports.slug, name: sports.name })
      .from(sports)
      .where(eq(sports.active, true))
      .orderBy(sports.name);

    const entries: SportRowDto[] = rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      zillaflash: makePerKindRow(loaded, "zillaflash", { sportId: r.id }),
      combi_boost: makePerKindRow(loaded, "combi_boost", { sportId: r.id }),
    }));

    return {
      globalZillaflash: loaded.globalByKind.get("zillaflash")
        ? rowToOverrideDto(loaded.globalByKind.get("zillaflash")!)
        : null,
      globalCombiBoost: loaded.globalByKind.get("combi_boost")
        ? rowToOverrideDto(loaded.globalByKind.get("combi_boost")!)
        : null,
      entries,
    };
  });

  // ── Tree: tournaments under a sport ────────────────────────────────
  app.get(
    "/admin/users/:userId/promo-visibility/sports/:sportId/tournaments",
    async (request) => {
      request.requireRole("admin");
      const { userId } = userIdParam.parse(request.params);
      const { sportId } = z
        .object({ sportId: z.coerce.number().int().positive() })
        .parse(request.params);
      await assertUserExists(app.db, userId);
      const loaded = await loadAll(app.db, userId);

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
        })
        .from(tournaments)
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .where(and(eq(categories.sportId, sportId), eq(tournaments.active, true)))
        .orderBy(tournaments.name);

      const entries: TournamentRowDto[] = rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        startAt: r.startAt?.toISOString() ?? null,
        endAt: r.endAt?.toISOString() ?? null,
        riskTier: r.riskTier,
        zillaflash: tournamentPerKindRow(loaded, "zillaflash", r.id, sportId),
        combi_boost: tournamentPerKindRow(loaded, "combi_boost", r.id, sportId),
      }));

      return { sport: sportRow, entries };
    },
  );

  // ── Tree: matches under a tournament ───────────────────────────────
  app.get(
    "/admin/users/:userId/promo-visibility/tournaments/:tournamentId/matches",
    async (request) => {
      request.requireRole("admin");
      const { userId } = userIdParam.parse(request.params);
      const { tournamentId } = z
        .object({ tournamentId: z.coerce.number().int().positive() })
        .parse(request.params);
      await assertUserExists(app.db, userId);
      const loaded = await loadAll(app.db, userId);

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

      const rows = await app.db
        .select({
          id: matches.id,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          scheduledAt: matches.scheduledAt,
          status: matches.status,
        })
        .from(matches)
        .where(
          and(
            eq(matches.tournamentId, tournamentId),
            sql`${matches.status} IN ('not_started','live')`,
          ),
        )
        .orderBy(sql`${matches.scheduledAt} ASC NULLS LAST`)
        .limit(500);

      const entries: MatchRowDto[] = rows.map((r) => ({
        id: r.id.toString(),
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        scheduledAt: r.scheduledAt?.toISOString() ?? null,
        status: r.status,
        zillaflash: matchPerKindRow(
          loaded,
          "zillaflash",
          r.id,
          tournamentId,
          tnt.sportId,
        ),
        combi_boost: matchPerKindRow(
          loaded,
          "combi_boost",
          r.id,
          tournamentId,
          tnt.sportId,
        ),
      }));

      return {
        tournament: { ...tnt, sportId: tnt.sportId },
        entries,
      };
    },
  );

  // ── Mutations ──────────────────────────────────────────────────────

  // PUT /admin/users/:userId/promo-visibility/:kind/global — upsert.
  app.put(
    "/admin/users/:userId/promo-visibility/:kind/global",
    async (request) => {
      const admin = request.requireRole("admin");
      const { userId } = userIdParam.parse(request.params);
      const { kind } = kindParam.parse(request.params);
      await assertUserExists(app.db, userId);
      const body = visibleBody.parse(request.body);

      const [before] = await app.db
        .select()
        .from(bettorPromoVisibilityConfig)
        .where(
          and(
            eq(bettorPromoVisibilityConfig.userId, userId),
            eq(bettorPromoVisibilityConfig.promoKind, kind),
            eq(bettorPromoVisibilityConfig.scope, "global"),
          ),
        )
        .limit(1);

      const result = await app.db.transaction(async (tx) => {
        const [row] = before
          ? await tx
              .update(bettorPromoVisibilityConfig)
              .set({
                visible: body.visible,
                updatedBy: admin.id,
                updatedAt: new Date(),
              })
              .where(eq(bettorPromoVisibilityConfig.id, before.id))
              .returning()
          : await tx
              .insert(bettorPromoVisibilityConfig)
              .values({
                userId,
                promoKind: kind,
                scope: "global",
                visible: body.visible,
                updatedBy: admin.id,
              })
              .returning();
        if (!row) throw new Error("promo visibility upsert returned no row");
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: before
            ? `bettor_promo_visibility.${kind}.global_update`
            : `bettor_promo_visibility.${kind}.global_create`,
          targetType: "bettor_promo_visibility_config",
          targetId: `user:${userId}:${kind}:global`,
          beforeJson: before
            ? (rowToOverrideDto(before) as unknown as Record<string, unknown>)
            : null,
          afterJson: rowToOverrideDto(row) as unknown as Record<string, unknown>,
          ipInet: request.ip ?? null,
        });
        return row;
      });

      return rowToOverrideDto(result);
    },
  );

  // DELETE /admin/users/:userId/promo-visibility/:kind/global — clear.
  app.delete(
    "/admin/users/:userId/promo-visibility/:kind/global",
    async (request) => {
      const admin = request.requireRole("admin");
      const { userId } = userIdParam.parse(request.params);
      const { kind } = kindParam.parse(request.params);
      await assertUserExists(app.db, userId);

      const [before] = await app.db
        .select()
        .from(bettorPromoVisibilityConfig)
        .where(
          and(
            eq(bettorPromoVisibilityConfig.userId, userId),
            eq(bettorPromoVisibilityConfig.promoKind, kind),
            eq(bettorPromoVisibilityConfig.scope, "global"),
          ),
        )
        .limit(1);
      if (!before) {
        throw new NotFoundError("override_not_found", "override_not_found");
      }
      await app.db.transaction(async (tx) => {
        await tx
          .delete(bettorPromoVisibilityConfig)
          .where(eq(bettorPromoVisibilityConfig.id, before.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: `bettor_promo_visibility.${kind}.global_delete`,
          targetType: "bettor_promo_visibility_config",
          targetId: `user:${userId}:${kind}:global`,
          beforeJson: rowToOverrideDto(before) as unknown as Record<string, unknown>,
          afterJson: null,
          ipInet: request.ip ?? null,
        });
      });
      return { ok: true };
    },
  );

  // Generic scope upsert + delete for sport / tournament / match.
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
    const path = `/admin/users/:userId/promo-visibility/:kind/${opts.routePrefix}/:${opts.paramName}`;

    app.put(path, async (request) => {
      const admin = request.requireRole("admin");
      const { userId } = userIdParam.parse(request.params);
      const { kind } = kindParam.parse(request.params);
      await assertUserExists(app.db, userId);
      const params = z
        .object({ [opts.paramName]: opts.paramSchema })
        .parse(request.params) as Record<string, z.infer<TIdParam>>;
      const id = params[opts.paramName]!;
      const body = visibleBody.parse(request.body);

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
        .from(bettorPromoVisibilityConfig)
        .where(
          and(
            eq(bettorPromoVisibilityConfig.userId, userId),
            eq(bettorPromoVisibilityConfig.promoKind, kind),
            eq(bettorPromoVisibilityConfig.scope, opts.scope),
            "matchId" in refIdSet
              ? eq(bettorPromoVisibilityConfig.matchId, refIdSet.matchId)
              : "tournamentId" in refIdSet
                ? eq(bettorPromoVisibilityConfig.tournamentId, refIdSet.tournamentId)
                : eq(bettorPromoVisibilityConfig.sportId, refIdSet.sportId),
          ),
        )
        .limit(1);

      const result = await app.db.transaction(async (tx) => {
        const [row] = before
          ? await tx
              .update(bettorPromoVisibilityConfig)
              .set({
                visible: body.visible,
                updatedBy: admin.id,
                updatedAt: new Date(),
              })
              .where(eq(bettorPromoVisibilityConfig.id, before.id))
              .returning()
          : await tx
              .insert(bettorPromoVisibilityConfig)
              .values({
                userId,
                promoKind: kind,
                scope: opts.scope,
                ...refIdSet,
                visible: body.visible,
                updatedBy: admin.id,
              })
              .returning();
        if (!row) throw new Error("promo visibility scope upsert returned no row");
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: before
            ? `bettor_promo_visibility.${kind}.${opts.scope}_update`
            : `bettor_promo_visibility.${kind}.${opts.scope}_create`,
          targetType: "bettor_promo_visibility_config",
          targetId: `user:${userId}:${kind}:${opts.scope}:${refIdStr}`,
          beforeJson: before
            ? (rowToOverrideDto(before) as unknown as Record<string, unknown>)
            : null,
          afterJson: rowToOverrideDto(row) as unknown as Record<string, unknown>,
          ipInet: request.ip ?? null,
        });
        return row;
      });
      return rowToOverrideDto(result);
    });

    app.delete(path, async (request) => {
      const admin = request.requireRole("admin");
      const { userId } = userIdParam.parse(request.params);
      const { kind } = kindParam.parse(request.params);
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
        .from(bettorPromoVisibilityConfig)
        .where(
          and(
            eq(bettorPromoVisibilityConfig.userId, userId),
            eq(bettorPromoVisibilityConfig.promoKind, kind),
            eq(bettorPromoVisibilityConfig.scope, opts.scope),
            "matchId" in refIdSet
              ? eq(bettorPromoVisibilityConfig.matchId, refIdSet.matchId)
              : "tournamentId" in refIdSet
                ? eq(bettorPromoVisibilityConfig.tournamentId, refIdSet.tournamentId)
                : eq(bettorPromoVisibilityConfig.sportId, refIdSet.sportId),
          ),
        )
        .limit(1);
      if (!before) {
        throw new NotFoundError("override_not_found", "override_not_found");
      }
      await app.db.transaction(async (tx) => {
        await tx
          .delete(bettorPromoVisibilityConfig)
          .where(eq(bettorPromoVisibilityConfig.id, before.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: `bettor_promo_visibility.${kind}.${opts.scope}_delete`,
          targetType: "bettor_promo_visibility_config",
          targetId: `user:${userId}:${kind}:${opts.scope}:${refIdStr}`,
          beforeJson: rowToOverrideDto(before) as unknown as Record<string, unknown>,
          afterJson: null,
          ipInet: request.ip ?? null,
        });
      });
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

  app.put(
    "/admin/users/:userId/promo-visibility/:kind/scope/:_anything",
    async () => {
      throw new BadRequestError(
        "use_scope_specific_endpoint",
        "use_scope_specific_endpoint",
      );
    },
  );
}

// Tournament-level row builder. Falls back to sport-level if no own
// row, then global, then "no rule" (visible=true).
function tournamentPerKindRow(
  loaded: LoadedRows,
  kind: PromoKind,
  tournamentId: number,
  sportId: number,
): PerKindRow {
  const own = loaded.byTournament.get(kind)!.get(tournamentId);
  if (own) {
    return {
      override: rowToOverrideDto(own),
      effectiveVisible: own.visible,
      effectiveSource: "tournament",
    };
  }
  return {
    override: null,
    ...resolveEffective(loaded, kind, { sportId }),
  };
}

// Match-level row builder. Falls back to tournament, then sport, then
// global, then "no rule" (visible=true).
function matchPerKindRow(
  loaded: LoadedRows,
  kind: PromoKind,
  matchId: bigint,
  tournamentId: number,
  sportId: number,
): PerKindRow {
  const own = loaded.byMatch.get(kind)!.get(matchId.toString());
  if (own) {
    return {
      override: rowToOverrideDto(own),
      effectiveVisible: own.visible,
      effectiveSource: "match",
    };
  }
  return {
    override: null,
    ...resolveEffective(loaded, kind, { sportId, tournamentId }),
  };
}
