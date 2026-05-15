// /admin/riskzilla/live-delay — sport / tournament / match cascade
// override of the live bet acceptance delay.
//
// Cascade at placement (services/api/src/modules/bets/service.ts):
//   per-leg:   match > tournament > sport > global (first non-NULL)
//   per-bet:   MAX across all live legs, then MAX with users.bet_delay_seconds
//   pure prematch: cascade contributes 0 (per-user delay still applies)
//
// Admin-only. Every mutation writes admin_audit_log. The global row is
// seeded by migration 0052 at 5s and cannot be deleted — it's the floor
// of the cascade. PUT on a non-global scope is an upsert; DELETE clears
// the override and the parent scope is used.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  riskzillaLiveDelayConfig,
  adminAuditLog,
  sports,
  tournaments,
  categories,
  matches,
} from "@oddzilla/db";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../lib/errors.js";

interface OverrideDto {
  id: string;
  delaySeconds: number;
  updatedAt: string;
  updatedBy: string | null;
}

// Resolved row in a tree drill-down. `override` is the row directly on
// this entity (if any). `effectiveDelaySeconds` is what would actually
// apply at placement, given the full cascade. `effectiveSource` names
// the level the effective value came from so the UI can render an
// "inherited from sport" / "overridden here" hint.
interface SportRowDto {
  id: number;
  slug: string;
  name: string;
  override: OverrideDto | null;
  effectiveDelaySeconds: number;
  effectiveSource: "global" | "sport";
}

interface TournamentRowDto {
  id: number;
  slug: string;
  name: string;
  startAt: string | null;
  endAt: string | null;
  riskTier: number | null;
  override: OverrideDto | null;
  effectiveDelaySeconds: number;
  effectiveSource: "global" | "sport" | "tournament";
}

interface MatchRowDto {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: string;
  override: OverrideDto | null;
  effectiveDelaySeconds: number;
  effectiveSource: "global" | "sport" | "tournament" | "match";
}

const delayBody = z.object({
  delaySeconds: z.number().int().min(0).max(300),
});

function rowToOverrideDto(row: typeof riskzillaLiveDelayConfig.$inferSelect): OverrideDto {
  return {
    id: row.id.toString(),
    delaySeconds: row.delaySeconds,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

// Load the global default. Migration seeds it; we treat its absence as
// a hard 500 because every cascade lookup depends on it.
async function loadGlobal(
  db: FastifyInstance["db"],
): Promise<typeof riskzillaLiveDelayConfig.$inferSelect> {
  const [row] = await db
    .select()
    .from(riskzillaLiveDelayConfig)
    .where(eq(riskzillaLiveDelayConfig.scope, "global"))
    .limit(1);
  if (!row) {
    throw new Error("riskzilla_live_delay_config global row missing");
  }
  return row;
}

export default async function riskzillaLiveDelayRoutes(app: FastifyInstance) {
  // ── Summary: global + every override flat ──────────────────────────
  app.get("/admin/riskzilla/live-delay", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select()
      .from(riskzillaLiveDelayConfig)
      .orderBy(riskzillaLiveDelayConfig.scope, riskzillaLiveDelayConfig.id);

    const global = rows.find((r) => r.scope === "global");
    if (!global) throw new Error("riskzilla_live_delay_config global row missing");

    // Group overrides by scope so the summary table is easy to render.
    return {
      global: rowToOverrideDto(global),
      sportOverrides: rows
        .filter((r) => r.scope === "sport")
        .map((r) => ({
          override: rowToOverrideDto(r),
          sportId: r.sportId!,
        })),
      tournamentOverrides: rows
        .filter((r) => r.scope === "tournament")
        .map((r) => ({
          override: rowToOverrideDto(r),
          tournamentId: r.tournamentId!,
        })),
      matchOverrides: rows
        .filter((r) => r.scope === "match")
        .map((r) => ({
          override: rowToOverrideDto(r),
          matchId: r.matchId!.toString(),
        })),
    };
  });

  // ── Tree: list of sports with effective delay ──────────────────────
  app.get("/admin/riskzilla/live-delay/sports", async (request) => {
    request.requireRole("admin");
    const global = await loadGlobal(app.db);

    // Join sports against any per-sport override, scoped to active
    // sports so the admin doesn't drown in the dummy `unclassified` and
    // the bot-only sports we've blocked.
    const rows = await app.db
      .select({
        id: sports.id,
        slug: sports.slug,
        name: sports.name,
        overrideId: riskzillaLiveDelayConfig.id,
        overrideDelay: riskzillaLiveDelayConfig.delaySeconds,
        overrideUpdatedAt: riskzillaLiveDelayConfig.updatedAt,
        overrideUpdatedBy: riskzillaLiveDelayConfig.updatedBy,
      })
      .from(sports)
      .leftJoin(
        riskzillaLiveDelayConfig,
        and(
          eq(riskzillaLiveDelayConfig.scope, "sport"),
          eq(riskzillaLiveDelayConfig.sportId, sports.id),
        ),
      )
      .where(eq(sports.active, true))
      .orderBy(sports.name);

    const entries: SportRowDto[] = rows.map((r) => {
      const override =
        r.overrideId !== null
          ? {
              id: r.overrideId.toString(),
              delaySeconds: r.overrideDelay!,
              updatedAt: r.overrideUpdatedAt!.toISOString(),
              updatedBy: r.overrideUpdatedBy,
            }
          : null;
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        override,
        effectiveDelaySeconds: override?.delaySeconds ?? global.delaySeconds,
        effectiveSource: override ? "sport" : "global",
      };
    });
    return {
      global: rowToOverrideDto(global),
      entries,
    };
  });

  // ── Tree: tournaments under a sport with effective delay ───────────
  app.get(
    "/admin/riskzilla/live-delay/sports/:sportId/tournaments",
    async (request) => {
      request.requireRole("admin");
      const params = z
        .object({ sportId: z.coerce.number().int().positive() })
        .parse(request.params);

      const global = await loadGlobal(app.db);

      // Sport-level override drives the inherited value for tournaments
      // without their own. One row at most.
      const [sportOverride] = await app.db
        .select()
        .from(riskzillaLiveDelayConfig)
        .where(
          and(
            eq(riskzillaLiveDelayConfig.scope, "sport"),
            eq(riskzillaLiveDelayConfig.sportId, params.sportId),
          ),
        )
        .limit(1);
      const inheritedFromSport = sportOverride?.delaySeconds ?? null;

      const [sportRow] = await app.db
        .select({ id: sports.id, name: sports.name, slug: sports.slug })
        .from(sports)
        .where(eq(sports.id, params.sportId))
        .limit(1);
      if (!sportRow) throw new NotFoundError();

      const rows = await app.db
        .select({
          id: tournaments.id,
          slug: tournaments.slug,
          name: tournaments.name,
          startAt: tournaments.startAt,
          endAt: tournaments.endAt,
          riskTier: tournaments.riskTier,
          overrideId: riskzillaLiveDelayConfig.id,
          overrideDelay: riskzillaLiveDelayConfig.delaySeconds,
          overrideUpdatedAt: riskzillaLiveDelayConfig.updatedAt,
          overrideUpdatedBy: riskzillaLiveDelayConfig.updatedBy,
        })
        .from(tournaments)
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .leftJoin(
          riskzillaLiveDelayConfig,
          and(
            eq(riskzillaLiveDelayConfig.scope, "tournament"),
            eq(riskzillaLiveDelayConfig.tournamentId, tournaments.id),
          ),
        )
        .where(
          and(eq(categories.sportId, params.sportId), eq(tournaments.active, true)),
        )
        .orderBy(tournaments.name);

      const entries: TournamentRowDto[] = rows.map((r) => {
        const override =
          r.overrideId !== null
            ? {
                id: r.overrideId.toString(),
                delaySeconds: r.overrideDelay!,
                updatedAt: r.overrideUpdatedAt!.toISOString(),
                updatedBy: r.overrideUpdatedBy,
              }
            : null;
        let effective: number;
        let source: TournamentRowDto["effectiveSource"];
        if (override) {
          effective = override.delaySeconds;
          source = "tournament";
        } else if (inheritedFromSport !== null) {
          effective = inheritedFromSport;
          source = "sport";
        } else {
          effective = global.delaySeconds;
          source = "global";
        }
        return {
          id: r.id,
          slug: r.slug,
          name: r.name,
          startAt: r.startAt?.toISOString() ?? null,
          endAt: r.endAt?.toISOString() ?? null,
          riskTier: r.riskTier,
          override,
          effectiveDelaySeconds: effective,
          effectiveSource: source,
        };
      });

      return {
        sport: sportRow,
        global: rowToOverrideDto(global),
        inheritedFromSport,
        entries,
      };
    },
  );

  // ── Tree: matches under a tournament with effective delay ──────────
  // Limited to active matches (not_started + live). Already-closed
  // matches don't take new bets and clutter the editor.
  app.get(
    "/admin/riskzilla/live-delay/tournaments/:tournamentId/matches",
    async (request) => {
      request.requireRole("admin");
      const params = z
        .object({ tournamentId: z.coerce.number().int().positive() })
        .parse(request.params);

      const global = await loadGlobal(app.db);

      // We need the tournament's sport so the cascade can fall back
      // through sport → global. One round-trip rather than two.
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
        .where(eq(tournaments.id, params.tournamentId))
        .limit(1);
      if (!tnt) throw new NotFoundError();

      const [tournamentOverride] = await app.db
        .select()
        .from(riskzillaLiveDelayConfig)
        .where(
          and(
            eq(riskzillaLiveDelayConfig.scope, "tournament"),
            eq(riskzillaLiveDelayConfig.tournamentId, params.tournamentId),
          ),
        )
        .limit(1);
      const [sportOverride] = await app.db
        .select()
        .from(riskzillaLiveDelayConfig)
        .where(
          and(
            eq(riskzillaLiveDelayConfig.scope, "sport"),
            eq(riskzillaLiveDelayConfig.sportId, tnt.sportId),
          ),
        )
        .limit(1);
      const inheritedFromTournament = tournamentOverride?.delaySeconds ?? null;
      const inheritedFromSport = sportOverride?.delaySeconds ?? null;
      const inheritedFromParent =
        inheritedFromTournament ?? inheritedFromSport ?? global.delaySeconds;
      const inheritedFromParentSource: MatchRowDto["effectiveSource"] =
        inheritedFromTournament !== null
          ? "tournament"
          : inheritedFromSport !== null
            ? "sport"
            : "global";

      const rows = await app.db
        .select({
          id: matches.id,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          scheduledAt: matches.scheduledAt,
          status: matches.status,
          overrideId: riskzillaLiveDelayConfig.id,
          overrideDelay: riskzillaLiveDelayConfig.delaySeconds,
          overrideUpdatedAt: riskzillaLiveDelayConfig.updatedAt,
          overrideUpdatedBy: riskzillaLiveDelayConfig.updatedBy,
        })
        .from(matches)
        .leftJoin(
          riskzillaLiveDelayConfig,
          and(
            eq(riskzillaLiveDelayConfig.scope, "match"),
            eq(riskzillaLiveDelayConfig.matchId, matches.id),
          ),
        )
        .where(
          and(
            eq(matches.tournamentId, params.tournamentId),
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
                delaySeconds: r.overrideDelay!,
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
          effectiveDelaySeconds: override?.delaySeconds ?? inheritedFromParent,
          effectiveSource: override ? "match" : inheritedFromParentSource,
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
        global: rowToOverrideDto(global),
        inheritedFromSport,
        inheritedFromTournament,
        entries,
      };
    },
  );

  // ── Mutations ──────────────────────────────────────────────────────

  // PUT /admin/riskzilla/live-delay/global — upsert the global row.
  app.put("/admin/riskzilla/live-delay/global", async (request) => {
    const admin = request.requireRole("admin");
    const body = delayBody.parse(request.body);

    const [before] = await app.db
      .select()
      .from(riskzillaLiveDelayConfig)
      .where(eq(riskzillaLiveDelayConfig.scope, "global"))
      .limit(1);
    if (!before) throw new Error("riskzilla_live_delay_config global row missing");

    const result = await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(riskzillaLiveDelayConfig)
        .set({
          delaySeconds: body.delaySeconds,
          updatedBy: admin.id,
          updatedAt: new Date(),
        })
        .where(eq(riskzillaLiveDelayConfig.id, before.id))
        .returning();
      if (!updated) throw new Error("global upsert returned no row");
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "riskzilla.live_delay.global_update",
        targetType: "riskzilla_live_delay_config",
        targetId: "global",
        beforeJson: rowToOverrideDto(before) as unknown as Record<string, unknown>,
        afterJson: rowToOverrideDto(updated) as unknown as Record<string, unknown>,
        ipInet: request.ip ?? null,
      });
      return updated;
    });

    return rowToOverrideDto(result);
  });

  // Generic upsert + delete for sport / tournament / match scopes. Each
  // handler reads the parent entity for the audit-log target_id label
  // and to reject IDs that don't exist (otherwise the FK would error
  // 500-style; better to surface a clean 404).
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
    const upsertPath = `/admin/riskzilla/live-delay/${opts.routePrefix}/:${opts.paramName}`;
    const deletePath = upsertPath;

    app.put(upsertPath, async (request) => {
      const admin = request.requireRole("admin");
      const params = z
        .object({ [opts.paramName]: opts.paramSchema })
        .parse(request.params) as Record<string, z.infer<TIdParam>>;
      const id = params[opts.paramName]!;
      const body = delayBody.parse(request.body);

      if (await opts.parentNotFound(id)) {
        throw new NotFoundError(`${opts.scope}_not_found`, `${opts.scope}_not_found`);
      }

      const refIdSet = opts.setRefId(id);
      // ref-id key for the audit target_id and lookup.
      const refIdStr =
        "matchId" in refIdSet
          ? refIdSet.matchId.toString()
          : "tournamentId" in refIdSet
            ? refIdSet.tournamentId.toString()
            : refIdSet.sportId.toString();

      const [before] = await app.db
        .select()
        .from(riskzillaLiveDelayConfig)
        .where(
          and(
            eq(riskzillaLiveDelayConfig.scope, opts.scope),
            "matchId" in refIdSet
              ? eq(riskzillaLiveDelayConfig.matchId, refIdSet.matchId)
              : "tournamentId" in refIdSet
                ? eq(riskzillaLiveDelayConfig.tournamentId, refIdSet.tournamentId)
                : eq(riskzillaLiveDelayConfig.sportId, refIdSet.sportId),
          ),
        )
        .limit(1);

      const result = await app.db.transaction(async (tx) => {
        const [updated] = before
          ? await tx
              .update(riskzillaLiveDelayConfig)
              .set({
                delaySeconds: body.delaySeconds,
                updatedBy: admin.id,
                updatedAt: new Date(),
              })
              .where(eq(riskzillaLiveDelayConfig.id, before.id))
              .returning()
          : await tx
              .insert(riskzillaLiveDelayConfig)
              .values({
                scope: opts.scope,
                ...refIdSet,
                delaySeconds: body.delaySeconds,
                updatedBy: admin.id,
              })
              .returning();
        if (!updated) throw new Error("scope upsert returned no row");
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: before
            ? `riskzilla.live_delay.${opts.scope}_update`
            : `riskzilla.live_delay.${opts.scope}_create`,
          targetType: "riskzilla_live_delay_config",
          targetId: `${opts.scope}:${refIdStr}`,
          beforeJson: before
            ? (rowToOverrideDto(before) as unknown as Record<string, unknown>)
            : null,
          afterJson: rowToOverrideDto(updated) as unknown as Record<string, unknown>,
          ipInet: request.ip ?? null,
        });
        return updated;
      });
      return rowToOverrideDto(result);
    });

    app.delete(deletePath, async (request) => {
      const admin = request.requireRole("admin");
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
        .from(riskzillaLiveDelayConfig)
        .where(
          and(
            eq(riskzillaLiveDelayConfig.scope, opts.scope),
            "matchId" in refIdSet
              ? eq(riskzillaLiveDelayConfig.matchId, refIdSet.matchId)
              : "tournamentId" in refIdSet
                ? eq(riskzillaLiveDelayConfig.tournamentId, refIdSet.tournamentId)
                : eq(riskzillaLiveDelayConfig.sportId, refIdSet.sportId),
          ),
        )
        .limit(1);
      if (!before) {
        throw new NotFoundError("override_not_found", "override_not_found");
      }
      await app.db.transaction(async (tx) => {
        await tx
          .delete(riskzillaLiveDelayConfig)
          .where(eq(riskzillaLiveDelayConfig.id, before.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: `riskzilla.live_delay.${opts.scope}_delete`,
          targetType: "riskzilla_live_delay_config",
          targetId: `${opts.scope}:${refIdStr}`,
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

  // Reject DELETE on the global scope explicitly — the URL is reachable
  // and an admin operating from `curl` might try it. The cascade has no
  // floor without it.
  app.delete("/admin/riskzilla/live-delay/global", async (request) => {
    request.requireRole("admin");
    throw new ForbiddenError(
      "global_override_cannot_be_deleted",
      "global_override_cannot_be_deleted",
    );
  });

  // Reject explicit "what if I PUT a global scope-keyed override" attempts.
  app.put("/admin/riskzilla/live-delay/scope/:_anything", async () => {
    throw new BadRequestError("use_scope_specific_endpoint", "use_scope_specific_endpoint");
  });
}
