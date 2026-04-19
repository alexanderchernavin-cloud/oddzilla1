// /admin/odds-config endpoints. Admin-only; every mutation writes to
// admin_audit_log. Publisher refreshes its in-memory cache every 5s, so
// edits made here take effect within that window.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc, isNull } from "drizzle-orm";
import {
  oddsConfig,
  adminAuditLog,
  sports,
  tournaments,
} from "@oddzilla/db";
import { NotFoundError } from "../../lib/errors.js";

const scopeEnum = z.enum(["global", "sport", "tournament", "market_type"]);

const upsertBody = z.object({
  scope: scopeEnum,
  scopeRefId: z.string().min(1).max(64).nullable().optional(),
  paybackMarginBp: z.number().int().min(0).max(5000),
});

export default async function oddsConfigRoutes(app: FastifyInstance) {
  app.get("/admin/odds-config", async (request) => {
    request.requireRole("admin");

    // Return all configs with resolved label (sport name, tournament
    // name, etc.) so the admin UI can render a useful table without
    // extra round trips.
    const rows = await app.db
      .select()
      .from(oddsConfig)
      .orderBy(oddsConfig.scope, oddsConfig.scopeRefId);

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
          paybackMarginBp: r.paybackMarginBp,
          updatedAt: r.updatedAt.toISOString(),
          updatedBy: r.updatedBy,
          label,
        };
      }),
    };
  });

  app.put("/admin/odds-config", async (request) => {
    const admin = request.requireRole("admin");
    const body = upsertBody.parse(request.body);

    // Global is the only scope with nullable scopeRefId; all others
    // require an id. Keep the validation strict.
    if (body.scope === "global") {
      if (body.scopeRefId) {
        throw new Error("scopeRefId must be null for global scope");
      }
    } else if (!body.scopeRefId) {
      throw new Error(`scopeRefId is required for scope=${body.scope}`);
    }

    const refId = body.scope === "global" ? null : (body.scopeRefId ?? null);

    // Select existing for audit diff. `col = NULL` is always FALSE in
    // SQL, so lookups for scope='global' (refId null) must use IS NULL.
    // Prior code used eq(col, null) which silently missed the existing
    // row and made every save insert a duplicate.
    const whereClause = and(
      eq(oddsConfig.scope, body.scope),
      refId === null ? isNull(oddsConfig.scopeRefId) : eq(oddsConfig.scopeRefId, refId),
    );
    const existing = await app.db.select().from(oddsConfig).where(whereClause).limit(1);
    const before = existing[0] ?? null;

    // Use upsert since (scope, scope_ref_id) is unique.
    const result = await app.db.transaction(async (tx) => {
      let row: typeof oddsConfig.$inferSelect | undefined;
      if (before) {
        const [updated] = await tx
          .update(oddsConfig)
          .set({
            paybackMarginBp: body.paybackMarginBp,
            updatedBy: admin.id,
            updatedAt: new Date(),
          })
          .where(eq(oddsConfig.id, before.id))
          .returning();
        row = updated;
      } else {
        const [inserted] = await tx
          .insert(oddsConfig)
          .values({
            scope: body.scope,
            scopeRefId: refId,
            paybackMarginBp: body.paybackMarginBp,
            updatedBy: admin.id,
          })
          .returning();
        row = inserted;
      }
      if (!row) throw new Error("upsert returned no row");

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: before ? "odds_config.update" : "odds_config.create",
        targetType: "odds_config",
        targetId: row.id.toString(),
        beforeJson: before
          ? { paybackMarginBp: before.paybackMarginBp }
          : null,
        afterJson: {
          scope: body.scope,
          scopeRefId: refId,
          paybackMarginBp: body.paybackMarginBp,
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
        paybackMarginBp: result.paybackMarginBp,
        updatedAt: result.updatedAt.toISOString(),
      },
    };
  });

  app.delete("/admin/odds-config/:id", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.coerce.number().int() }).parse(request.params);

    const [existing] = await app.db
      .select()
      .from(oddsConfig)
      .where(eq(oddsConfig.id, params.id))
      .limit(1);
    if (!existing) throw new NotFoundError("odds_config_not_found", "odds_config_not_found");

    // Global cannot be deleted — it's the last-resort fallback.
    if (existing.scope === "global") {
      throw new Error("global scope cannot be deleted");
    }

    await app.db.transaction(async (tx) => {
      await tx.delete(oddsConfig).where(eq(oddsConfig.id, params.id));
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "odds_config.delete",
        targetType: "odds_config",
        targetId: params.id.toString(),
        beforeJson: {
          scope: existing.scope,
          scopeRefId: existing.scopeRefId,
          paybackMarginBp: existing.paybackMarginBp,
        },
        afterJson: null,
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true };
  });

  // Convenience: list sports and tournaments so the admin UI can populate
  // the scope-ref dropdown without separate fetches.
  app.get("/admin/odds-config/options", async (request) => {
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
