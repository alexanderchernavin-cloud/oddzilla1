// /admin/zillaflash-config — singleton config admin for the ZillaFlash
// rotation. Per-kind tunables (TTL, Netwinstable key delta, tournament
// risk-tier window) live here; the engine in services/api/src/modules/
// zillaflash reads this row periodically (CONFIG_CACHE_MS) so admin
// tweaks apply to the next rotation tick without an api restart.
//
// Every mutation writes to admin_audit_log under the singleton id.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { adminAuditLog, zillaflashConfig } from "@oddzilla/db";
import { BadRequestError } from "../../lib/errors.js";

const SINGLETON_ID = "default";

// 32 is the risk_tier upper bound used across riskzilla (see schema
// CHECK constraints). Keep this allowed range wide so an admin can
// experiment freely; the per-tier window is just a slice.
const TIER_MAX = 32;

const putBody = z.object({
  enabled: z.boolean(),
  prematchTtlSeconds: z.number().int().min(5).max(600),
  liveTtlSeconds: z.number().int().min(5).max(600),
  prematchKeyDeltaPct: z.number().min(0).max(50),
  liveKeyDeltaPct: z.number().min(0).max(50),
  prematchMinTier: z.number().int().min(1).max(TIER_MAX),
  prematchMaxTier: z.number().int().min(1).max(TIER_MAX),
  liveMinTier: z.number().int().min(1).max(TIER_MAX),
  liveMaxTier: z.number().int().min(1).max(TIER_MAX),
});

interface ConfigResponseShape {
  enabled: boolean;
  prematchTtlSeconds: number;
  liveTtlSeconds: number;
  prematchKeyDeltaPct: number;
  liveKeyDeltaPct: number;
  prematchMinTier: number;
  prematchMaxTier: number;
  liveMinTier: number;
  liveMaxTier: number;
  updatedAt: string;
  updatedBy: string | null;
}

function rowToResponse(
  row: typeof zillaflashConfig.$inferSelect,
): ConfigResponseShape {
  return {
    enabled: row.enabled,
    prematchTtlSeconds: row.prematchTtlSeconds,
    liveTtlSeconds: row.liveTtlSeconds,
    prematchKeyDeltaPct: Number(row.prematchKeyDeltaPct),
    liveKeyDeltaPct: Number(row.liveKeyDeltaPct),
    prematchMinTier: row.prematchMinTier,
    prematchMaxTier: row.prematchMaxTier,
    liveMinTier: row.liveMinTier,
    liveMaxTier: row.liveMaxTier,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

async function loadOrSeed(
  app: FastifyInstance,
): Promise<typeof zillaflashConfig.$inferSelect> {
  const [row] = await app.db
    .select()
    .from(zillaflashConfig)
    .where(eq(zillaflashConfig.id, SINGLETON_ID))
    .limit(1);
  if (row) return row;
  // Migration 0055 seeds the row, but on a freshly-restored DB or in
  // tests it may not exist yet — INSERT defensively. The id CHECK
  // guarantees we can never end up with two rows.
  const [inserted] = await app.db
    .insert(zillaflashConfig)
    .values({ id: SINGLETON_ID })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [refetched] = await app.db
    .select()
    .from(zillaflashConfig)
    .where(eq(zillaflashConfig.id, SINGLETON_ID))
    .limit(1);
  if (!refetched) {
    throw new Error("zillaflash_config row missing after insert");
  }
  return refetched;
}

export default async function zillaflashConfigRoutes(app: FastifyInstance) {
  app.get("/admin/zillaflash-config", async (request) => {
    request.requireRole("admin");
    const row = await loadOrSeed(app);
    return rowToResponse(row);
  });

  app.put("/admin/zillaflash-config", async (request) => {
    const admin = request.requireRole("admin");
    const body = putBody.parse(request.body);

    // Cross-field validation (zod's `.refine()` chains don't compose
    // well with our error envelope — surface typed BadRequestError so
    // the storefront's form maps to a recognisable code).
    if (body.prematchMinTier > body.prematchMaxTier) {
      throw new BadRequestError(
        "prematch_tier_range_inverted",
        "prematch_tier_range_inverted",
      );
    }
    if (body.liveMinTier > body.liveMaxTier) {
      throw new BadRequestError(
        "live_tier_range_inverted",
        "live_tier_range_inverted",
      );
    }

    const before = await loadOrSeed(app);

    const result = await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(zillaflashConfig)
        .set({
          enabled: body.enabled,
          prematchTtlSeconds: body.prematchTtlSeconds,
          liveTtlSeconds: body.liveTtlSeconds,
          prematchKeyDeltaPct: body.prematchKeyDeltaPct.toFixed(2),
          liveKeyDeltaPct: body.liveKeyDeltaPct.toFixed(2),
          prematchMinTier: body.prematchMinTier,
          prematchMaxTier: body.prematchMaxTier,
          liveMinTier: body.liveMinTier,
          liveMaxTier: body.liveMaxTier,
          updatedBy: admin.id,
          updatedAt: new Date(),
        })
        .where(eq(zillaflashConfig.id, SINGLETON_ID))
        .returning();
      if (!updated) throw new Error("zillaflash_config update returned no row");

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "zillaflash_config.update",
        targetType: "zillaflash_config",
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
