// /admin/combi-boost-config endpoints. Admin-only. Single-row config —
// PUT replaces all fields. Every mutation writes to admin_audit_log.
//
// The placement service (services/api/src/modules/bets/service.ts) and
// the storefront fetch this row each time they need fresh boost values
// — no in-memory cache, the row is tiny and read-rate is bounded.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { combiBoostConfig, adminAuditLog } from "@oddzilla/db";
import { BadRequestError } from "../../lib/errors.js";

const SINGLETON_ID = "default";

const tierSchema = z.object({
  minLegs: z.number().int().min(2).max(30),
  multiplier: z.number().min(1.0001).max(5.0),
});

const putBody = z.object({
  enabled: z.boolean(),
  minOdds: z.number().min(1.0001).max(10),
  tiers: z.array(tierSchema).length(4),
});

interface ConfigResponseShape {
  enabled: boolean;
  minOdds: number;
  tiers: Array<{ minLegs: number; multiplier: number; label: string }>;
  updatedAt: string;
  updatedBy: string | null;
}

function formatLabel(multiplier: number): string {
  return `x${multiplier.toFixed(2)}`;
}

function rowToResponse(
  row: typeof combiBoostConfig.$inferSelect,
): ConfigResponseShape {
  const tiers = [
    { minLegs: row.tier1MinLegs, multiplier: Number(row.tier1Multiplier) },
    { minLegs: row.tier2MinLegs, multiplier: Number(row.tier2Multiplier) },
    { minLegs: row.tier3MinLegs, multiplier: Number(row.tier3Multiplier) },
    { minLegs: row.tier4MinLegs, multiplier: Number(row.tier4Multiplier) },
  ].map((t) => ({ ...t, label: formatLabel(t.multiplier) }));
  return {
    enabled: row.enabled,
    minOdds: Number(row.minOdds),
    tiers,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

async function loadOrSeed(
  app: FastifyInstance,
): Promise<typeof combiBoostConfig.$inferSelect> {
  const [row] = await app.db
    .select()
    .from(combiBoostConfig)
    .where(eq(combiBoostConfig.id, SINGLETON_ID))
    .limit(1);
  if (row) return row;
  // The migration seeds this row, but on a freshly-restored DB or in
  // tests it may not exist yet — INSERT defensively. The singleton
  // CHECK guarantees we can never end up with two rows.
  const [inserted] = await app.db
    .insert(combiBoostConfig)
    .values({ id: SINGLETON_ID })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  // Race: another writer inserted concurrently — re-select.
  const [refetched] = await app.db
    .select()
    .from(combiBoostConfig)
    .where(eq(combiBoostConfig.id, SINGLETON_ID))
    .limit(1);
  if (!refetched) {
    throw new Error("combi_boost_config row missing after insert");
  }
  return refetched;
}

export default async function combiBoostConfigRoutes(app: FastifyInstance) {
  app.get("/admin/combi-boost-config", async (request) => {
    request.requireRole("admin");
    const row = await loadOrSeed(app);
    return rowToResponse(row);
  });

  app.put("/admin/combi-boost-config", async (request) => {
    const admin = request.requireRole("admin");
    const body = putBody.parse(request.body);

    // Validate ordering before touching the DB so we return a clean
    // error rather than relying on the table's CHECK constraint
    // (which would surface as a 500). Mirror the SQL invariants
    // exactly.
    for (let i = 1; i < body.tiers.length; i++) {
      if (body.tiers[i]!.minLegs <= body.tiers[i - 1]!.minLegs) {
        throw new BadRequestError(
          "tier_min_legs_not_increasing",
          "tier_min_legs_not_increasing",
        );
      }
      if (body.tiers[i]!.multiplier <= body.tiers[i - 1]!.multiplier) {
        throw new BadRequestError(
          "tier_multiplier_not_increasing",
          "tier_multiplier_not_increasing",
        );
      }
    }
    if (body.tiers[0]!.multiplier <= 1.0) {
      throw new BadRequestError(
        "tier_multiplier_must_exceed_one",
        "tier_multiplier_must_exceed_one",
      );
    }

    const before = await loadOrSeed(app);

    const result = await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(combiBoostConfig)
        .set({
          enabled: body.enabled,
          minOdds: body.minOdds.toFixed(4),
          tier1MinLegs: body.tiers[0]!.minLegs,
          tier1Multiplier: body.tiers[0]!.multiplier.toFixed(4),
          tier2MinLegs: body.tiers[1]!.minLegs,
          tier2Multiplier: body.tiers[1]!.multiplier.toFixed(4),
          tier3MinLegs: body.tiers[2]!.minLegs,
          tier3Multiplier: body.tiers[2]!.multiplier.toFixed(4),
          tier4MinLegs: body.tiers[3]!.minLegs,
          tier4Multiplier: body.tiers[3]!.multiplier.toFixed(4),
          updatedBy: admin.id,
          updatedAt: new Date(),
        })
        .where(eq(combiBoostConfig.id, SINGLETON_ID))
        .returning();
      if (!updated) throw new Error("combi_boost_config update returned no row");

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "combi_boost_config.update",
        targetType: "combi_boost_config",
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
