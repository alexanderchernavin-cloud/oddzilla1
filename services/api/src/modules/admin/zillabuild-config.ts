// /admin/zillabuild-config — singleton config admin for ZillaBuild
// (pre-built BetBuilder cards). Controls the master on/off, which Oddin
// provider markets to consider, card shape, the combined-odds floor, and
// the per-match response cache window. The catalog engine
// (services/api/src/modules/zillabuild/engine.ts) reads this row on every
// cold build, so admin tweaks take effect within one cache TTL (a disable
// takes effect immediately — the engine short-circuits before the cache).
//
// Every mutation writes to admin_audit_log under the singleton id.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { adminAuditLog, zillabuildConfig } from "@oddzilla/db";
import { BadRequestError } from "../../lib/errors.js";

const SINGLETON_ID = "default";

const putBody = z.object({
  enabled: z.boolean(),
  // Allowlist of Oddin provider_market_id values; empty = consider all
  // OBB-eligible per-map markets. Deduped + sorted before persist.
  eligibleProviderMarketIds: z.array(z.number().int().positive()).max(200),
  cardsPerMap: z.number().int().min(1).max(4),
  mapCount: z.number().int().min(1).max(5),
  minLegs: z.number().int().min(2).max(8),
  maxLegs: z.number().int().min(2).max(8),
  minCombinedOdds: z.number().min(1.01).max(1000),
  cacheTtlSeconds: z.number().int().min(5).max(600),
});

interface ConfigResponseShape {
  enabled: boolean;
  eligibleProviderMarketIds: number[];
  cardsPerMap: number;
  mapCount: number;
  minLegs: number;
  maxLegs: number;
  minCombinedOdds: number;
  cacheTtlSeconds: number;
  updatedAt: string;
  updatedBy: string | null;
}

function rowToResponse(
  row: typeof zillabuildConfig.$inferSelect,
): ConfigResponseShape {
  return {
    enabled: row.enabled,
    eligibleProviderMarketIds: row.eligibleProviderMarketIds ?? [],
    cardsPerMap: row.cardsPerMap,
    mapCount: row.mapCount,
    minLegs: row.minLegs,
    maxLegs: row.maxLegs,
    minCombinedOdds: Number(row.minCombinedOdds),
    cacheTtlSeconds: row.cacheTtlSeconds,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

async function loadOrSeed(
  app: FastifyInstance,
): Promise<typeof zillabuildConfig.$inferSelect> {
  const [row] = await app.db
    .select()
    .from(zillabuildConfig)
    .where(eq(zillabuildConfig.id, SINGLETON_ID))
    .limit(1);
  if (row) return row;
  // Migration 0082 seeds the row; INSERT defensively for fresh/test DBs.
  // The id CHECK guarantees we can never end up with two rows.
  const [inserted] = await app.db
    .insert(zillabuildConfig)
    .values({ id: SINGLETON_ID })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [refetched] = await app.db
    .select()
    .from(zillabuildConfig)
    .where(eq(zillabuildConfig.id, SINGLETON_ID))
    .limit(1);
  if (!refetched) throw new Error("zillabuild_config row missing after insert");
  return refetched;
}

export default async function zillabuildConfigRoutes(app: FastifyInstance) {
  app.get("/admin/zillabuild-config", async (request) => {
    request.requireRole("admin");
    const row = await loadOrSeed(app);
    return rowToResponse(row);
  });

  app.put("/admin/zillabuild-config", async (request) => {
    const admin = request.requireRole("admin");
    const body = putBody.parse(request.body);

    if (body.maxLegs < body.minLegs) {
      throw new BadRequestError("legs_range_inverted", "legs_range_inverted");
    }

    // Dedupe + sort the allowlist so the stored value is canonical (the
    // admin UI renders it as chips; order-independence keeps audit diffs
    // meaningful).
    const eligible = Array.from(new Set(body.eligibleProviderMarketIds)).sort(
      (a, b) => a - b,
    );

    const before = await loadOrSeed(app);

    const result = await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(zillabuildConfig)
        .set({
          enabled: body.enabled,
          eligibleProviderMarketIds: eligible,
          cardsPerMap: body.cardsPerMap,
          mapCount: body.mapCount,
          minLegs: body.minLegs,
          maxLegs: body.maxLegs,
          minCombinedOdds: body.minCombinedOdds.toFixed(3),
          cacheTtlSeconds: body.cacheTtlSeconds,
          updatedBy: admin.id,
          updatedAt: new Date(),
        })
        .where(eq(zillabuildConfig.id, SINGLETON_ID))
        .returning();
      if (!updated) throw new Error("zillabuild_config update returned no row");

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "zillabuild_config.update",
        targetType: "zillabuild_config",
        targetId: SINGLETON_ID,
        beforeJson: rowToResponse(before) as unknown as Record<string, unknown>,
        afterJson: rowToResponse(updated) as unknown as Record<string, unknown>,
        ipInet: request.ip ?? null,
      });

      return updated;
    });

    return rowToResponse(result);
  });
}
