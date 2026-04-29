// /admin/cashout-config endpoints. Mirrors odds-config in shape but
// carries more knobs (enable flag, prematch full-payback window,
// deduction ladder, minimum offer floor, significant-change threshold).
//
// The cashout service reads these on every quote — there's no in-memory
// cache. Quote rate is far below odds_change rate so a per-quote SELECT
// is fine.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc, isNull } from "drizzle-orm";
import {
  cashoutConfig,
  adminAuditLog,
  sports,
  tournaments,
} from "@oddzilla/db";
import { NotFoundError } from "../../lib/errors.js";

const scopeEnum = z.enum(["global", "sport", "tournament", "market_type"]);

const ladderStep = z.object({
  factor: z.number().positive(),
  deduction: z.number().min(1),
});

const upsertBody = z.object({
  scope: scopeEnum,
  scopeRefId: z.string().min(1).max(64).nullable().optional(),
  enabled: z.boolean(),
  prematchFullPaybackSeconds: z.number().int().min(0).max(86400),
  deductionLadder: z.array(ladderStep).max(50).nullable().optional(),
  minOfferMicro: z
    .string()
    .regex(/^\d+$/, "minOfferMicro must be a non-negative integer string"),
  minValueChangeBp: z.number().int().min(0).max(10000),
  acceptanceDelaySeconds: z.number().int().min(0).max(60),
});

export default async function cashoutConfigRoutes(app: FastifyInstance) {
  app.get("/admin/cashout-config", async (request) => {
    request.requireRole("admin");

    const rows = await app.db
      .select()
      .from(cashoutConfig)
      .orderBy(cashoutConfig.scope, cashoutConfig.scopeRefId);

    const sportIds = rows
      .filter((r) => r.scope === "sport" && r.scopeRefId)
      .map((r) => Number(r.scopeRefId))
      .filter((n) => Number.isInteger(n));
    const tournamentIds = rows
      .filter((r) => r.scope === "tournament" && r.scopeRefId)
      .map((r) => Number(r.scopeRefId))
      .filter((n) => Number.isInteger(n));

    const [sportLabels, tournamentLabels] = await Promise.all([
      sportIds.length > 0
        ? app.db.select({ id: sports.id, name: sports.name, slug: sports.slug }).from(sports)
        : Promise.resolve([] as Array<{ id: number; name: string; slug: string }>),
      tournamentIds.length > 0
        ? app.db.select({ id: tournaments.id, name: tournaments.name }).from(tournaments)
        : Promise.resolve([] as Array<{ id: number; name: string }>),
    ]);

    const sportByID = new Map(sportLabels.map((s) => [s.id, s]));
    const tournamentByID = new Map(tournamentLabels.map((t) => [t.id, t]));

    return {
      entries: rows.map((r) => {
        let label = "Global (default)";
        if (r.scope === "sport" && r.scopeRefId) {
          const s = sportByID.get(Number(r.scopeRefId));
          label = s ? `Sport: ${s.name}` : `Sport #${r.scopeRefId}`;
        } else if (r.scope === "tournament" && r.scopeRefId) {
          const t = tournamentByID.get(Number(r.scopeRefId));
          label = t ? `Tournament: ${t.name}` : `Tournament #${r.scopeRefId}`;
        } else if (r.scope === "market_type" && r.scopeRefId) {
          label = `Market type: ${r.scopeRefId}`;
        }
        return {
          id: r.id,
          scope: r.scope,
          scopeRefId: r.scopeRefId,
          enabled: r.enabled,
          prematchFullPaybackSeconds: r.prematchFullPaybackSeconds,
          deductionLadderJson: r.deductionLadderJson,
          minOfferMicro: r.minOfferMicro.toString(),
          minValueChangeBp: r.minValueChangeBp,
          acceptanceDelaySeconds: r.acceptanceDelaySeconds,
          updatedAt: r.updatedAt.toISOString(),
          updatedBy: r.updatedBy,
          label,
        };
      }),
    };
  });

  app.put("/admin/cashout-config", async (request) => {
    const admin = request.requireRole("admin");
    const body = upsertBody.parse(request.body);

    if (body.scope === "global") {
      if (body.scopeRefId) {
        throw new Error("scopeRefId must be null for global scope");
      }
    } else if (!body.scopeRefId) {
      throw new Error(`scopeRefId is required for scope=${body.scope}`);
    }

    const refId = body.scope === "global" ? null : (body.scopeRefId ?? null);

    const whereClause = and(
      eq(cashoutConfig.scope, body.scope),
      refId === null ? isNull(cashoutConfig.scopeRefId) : eq(cashoutConfig.scopeRefId, refId),
    );
    const existing = await app.db.select().from(cashoutConfig).where(whereClause).limit(1);
    const before = existing[0] ?? null;

    const ladder =
      body.deductionLadder === null || body.deductionLadder === undefined
        ? null
        : body.deductionLadder.length === 0
          ? null
          : body.deductionLadder;

    const result = await app.db.transaction(async (tx) => {
      let row: typeof cashoutConfig.$inferSelect | undefined;
      if (before) {
        const [updated] = await tx
          .update(cashoutConfig)
          .set({
            enabled: body.enabled,
            prematchFullPaybackSeconds: body.prematchFullPaybackSeconds,
            deductionLadderJson: ladder,
            minOfferMicro: BigInt(body.minOfferMicro),
            minValueChangeBp: body.minValueChangeBp,
            acceptanceDelaySeconds: body.acceptanceDelaySeconds,
            updatedBy: admin.id,
            updatedAt: new Date(),
          })
          .where(eq(cashoutConfig.id, before.id))
          .returning();
        row = updated;
      } else {
        const [inserted] = await tx
          .insert(cashoutConfig)
          .values({
            scope: body.scope,
            scopeRefId: refId,
            enabled: body.enabled,
            prematchFullPaybackSeconds: body.prematchFullPaybackSeconds,
            deductionLadderJson: ladder,
            minOfferMicro: BigInt(body.minOfferMicro),
            minValueChangeBp: body.minValueChangeBp,
            acceptanceDelaySeconds: body.acceptanceDelaySeconds,
            updatedBy: admin.id,
          })
          .returning();
        row = inserted;
      }
      if (!row) throw new Error("upsert returned no row");

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: before ? "cashout_config.update" : "cashout_config.create",
        targetType: "cashout_config",
        targetId: row.id.toString(),
        beforeJson: before
          ? {
              enabled: before.enabled,
              prematchFullPaybackSeconds: before.prematchFullPaybackSeconds,
              deductionLadderJson: before.deductionLadderJson,
              minOfferMicro: before.minOfferMicro.toString(),
              minValueChangeBp: before.minValueChangeBp,
              acceptanceDelaySeconds: before.acceptanceDelaySeconds,
            }
          : null,
        afterJson: {
          scope: body.scope,
          scopeRefId: refId,
          enabled: body.enabled,
          prematchFullPaybackSeconds: body.prematchFullPaybackSeconds,
          deductionLadderJson: ladder,
          minOfferMicro: body.minOfferMicro,
          minValueChangeBp: body.minValueChangeBp,
          acceptanceDelaySeconds: body.acceptanceDelaySeconds,
        },
        ipInet: request.ip ?? null,
      });

      return row;
    });

    return {
      entry: {
        id: result.id,
        scope: result.scope,
        scopeRefId: result.scopeRefId,
        enabled: result.enabled,
        prematchFullPaybackSeconds: result.prematchFullPaybackSeconds,
        deductionLadderJson: result.deductionLadderJson,
        minOfferMicro: result.minOfferMicro.toString(),
        minValueChangeBp: result.minValueChangeBp,
        acceptanceDelaySeconds: result.acceptanceDelaySeconds,
        updatedAt: result.updatedAt.toISOString(),
      },
    };
  });

  app.delete("/admin/cashout-config/:id", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.coerce.number().int() }).parse(request.params);

    const [existing] = await app.db
      .select()
      .from(cashoutConfig)
      .where(eq(cashoutConfig.id, params.id))
      .limit(1);
    if (!existing) {
      throw new NotFoundError("cashout_config_not_found", "cashout_config_not_found");
    }
    if (existing.scope === "global") {
      throw new Error("global scope cannot be deleted");
    }

    await app.db.transaction(async (tx) => {
      await tx.delete(cashoutConfig).where(eq(cashoutConfig.id, params.id));
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "cashout_config.delete",
        targetType: "cashout_config",
        targetId: params.id.toString(),
        beforeJson: {
          scope: existing.scope,
          scopeRefId: existing.scopeRefId,
          enabled: existing.enabled,
          prematchFullPaybackSeconds: existing.prematchFullPaybackSeconds,
          deductionLadderJson: existing.deductionLadderJson,
          minOfferMicro: existing.minOfferMicro.toString(),
          minValueChangeBp: existing.minValueChangeBp,
          acceptanceDelaySeconds: existing.acceptanceDelaySeconds,
        },
        afterJson: null,
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true };
  });

  app.get("/admin/cashout-config/options", async (request) => {
    request.requireRole("admin");
    const [sportRows, tournamentRows] = await Promise.all([
      app.db
        .select({ id: sports.id, slug: sports.slug, name: sports.name })
        .from(sports)
        .orderBy(sports.slug),
      app.db
        .select({ id: tournaments.id, name: tournaments.name })
        .from(tournaments)
        .orderBy(desc(tournaments.createdAt))
        .limit(200),
    ]);
    return { sports: sportRows, tournaments: tournamentRows };
  });
}
