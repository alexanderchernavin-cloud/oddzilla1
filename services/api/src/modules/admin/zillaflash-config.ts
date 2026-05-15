// /admin/zillaflash-config — singleton config admin for the ZillaFlash
// rotation. Two values: prematch_ttl_seconds and live_ttl_seconds, plus
// a master enabled toggle. The engine in services/api/src/modules/zillaflash
// reads this row periodically (CONFIG_CACHE_MS) so admin tweaks apply
// to the next rotation tick without an api restart.
//
// Every mutation writes to admin_audit_log under the singleton id.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { adminAuditLog, zillaflashConfig } from "@oddzilla/db";

const SINGLETON_ID = "default";

const putBody = z.object({
  enabled: z.boolean(),
  prematchTtlSeconds: z.number().int().min(5).max(600),
  liveTtlSeconds: z.number().int().min(5).max(600),
});

interface ConfigResponseShape {
  enabled: boolean;
  prematchTtlSeconds: number;
  liveTtlSeconds: number;
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

    const before = await loadOrSeed(app);

    const result = await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(zillaflashConfig)
        .set({
          enabled: body.enabled,
          prematchTtlSeconds: body.prematchTtlSeconds,
          liveTtlSeconds: body.liveTtlSeconds,
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
