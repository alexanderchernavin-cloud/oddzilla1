// /admin/bet-products endpoints. Admin-only; every mutation writes to
// admin_audit_log. Read by services/api/src/modules/bets/service.ts on
// every placement (no cache — at most 2 rows total).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { betProductConfig, adminAuditLog } from "@oddzilla/db";
import { NotFoundError } from "../../lib/errors.js";

const productEnum = z.enum(["tiple", "tippot"]);

const updateBody = z.object({
  marginBp: z.number().int().min(0).max(5000),
  marginBpPerLeg: z.number().int().min(0).max(5000),
  minLegs: z.number().int().min(2).max(30),
  maxLegs: z.number().int().min(2).max(30),
  enabled: z.boolean(),
});

export default async function betProductsRoutes(app: FastifyInstance) {
  app.get("/admin/bet-products", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select()
      .from(betProductConfig)
      .orderBy(betProductConfig.productName);
    return {
      products: rows.map((r) => ({
        productName: r.productName,
        marginBp: r.marginBp,
        marginBpPerLeg: r.marginBpPerLeg,
        minLegs: r.minLegs,
        maxLegs: r.maxLegs,
        enabled: r.enabled,
        updatedAt: r.updatedAt.toISOString(),
        updatedBy: r.updatedBy,
      })),
    };
  });

  app.put("/admin/bet-products/:product", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ product: productEnum }).parse(request.params);
    const body = updateBody.parse(request.body);
    if (body.minLegs > body.maxLegs) {
      throw new Error("min_legs must be ≤ max_legs");
    }

    const [before] = await app.db
      .select()
      .from(betProductConfig)
      .where(eq(betProductConfig.productName, params.product))
      .limit(1);
    if (!before) {
      throw new NotFoundError("bet_product_not_found", "bet_product_not_found");
    }

    const result = await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(betProductConfig)
        .set({
          marginBp: body.marginBp,
          marginBpPerLeg: body.marginBpPerLeg,
          minLegs: body.minLegs,
          maxLegs: body.maxLegs,
          enabled: body.enabled,
          updatedBy: admin.id,
          updatedAt: new Date(),
        })
        .where(eq(betProductConfig.productName, params.product))
        .returning();
      if (!updated) throw new Error("bet_product_config update returned no row");

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "bet_product_config.update",
        targetType: "bet_product_config",
        targetId: params.product,
        beforeJson: {
          marginBp: before.marginBp,
          marginBpPerLeg: before.marginBpPerLeg,
          minLegs: before.minLegs,
          maxLegs: before.maxLegs,
          enabled: before.enabled,
        },
        afterJson: {
          marginBp: body.marginBp,
          marginBpPerLeg: body.marginBpPerLeg,
          minLegs: body.minLegs,
          maxLegs: body.maxLegs,
          enabled: body.enabled,
        },
        ipInet: request.ip ?? null,
      });

      return updated;
    });

    return {
      product: {
        productName: result.productName,
        marginBp: result.marginBp,
        marginBpPerLeg: result.marginBpPerLeg,
        minLegs: result.minLegs,
        maxLegs: result.maxLegs,
        enabled: result.enabled,
        updatedAt: result.updatedAt.toISOString(),
      },
    };
  });
}
