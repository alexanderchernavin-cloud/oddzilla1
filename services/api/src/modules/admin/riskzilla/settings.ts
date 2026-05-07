// /admin/riskzilla/settings + /admin/riskzilla/market-factors.
// Admin-only. Per-tier defaults govern the placement-time gates;
// per-market factors are down-only multipliers on per-tier match
// liability. Every mutation writes admin_audit_log.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import {
  riskzillaSettings,
  riskzillaMarketFactors,
  adminAuditLog,
} from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../../lib/errors.js";

interface SettingsRowDto {
  tier: number;
  matchLiabilityMicro: string;
  minBetMicro: string;
  maxPayoutMicro: string;
  betFactor: string;
  updatedAt: string;
  updatedBy: string | null;
}

interface MarketFactorRowDto {
  providerMarketId: number;
  factor: string;
  label: string;
  notes: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

const settingsPutBody = z.object({
  matchLiabilityMicro: z.string().regex(/^\d+$/),
  minBetMicro: z.string().regex(/^\d+$/),
  maxPayoutMicro: z.string().regex(/^\d+$/),
  // Stored at NUMERIC(5,4) — pass as a decimal string "0.1000".
  betFactor: z.string().regex(/^\d+(?:\.\d{1,4})?$/),
});

const factorPutBody = z.object({
  factor: z.string().regex(/^\d+(?:\.\d{1,3})?$/),
  label: z.string().min(1).max(120),
  notes: z.string().max(500).optional().nullable(),
});

function settingsRowToDto(
  row: typeof riskzillaSettings.$inferSelect,
): SettingsRowDto {
  return {
    tier: row.tier,
    matchLiabilityMicro: row.matchLiabilityMicro.toString(),
    minBetMicro: row.minBetMicro.toString(),
    maxPayoutMicro: row.maxPayoutMicro.toString(),
    betFactor: row.betFactor,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

function factorRowToDto(
  row: typeof riskzillaMarketFactors.$inferSelect,
): MarketFactorRowDto {
  return {
    providerMarketId: row.providerMarketId,
    factor: row.factor,
    label: row.label,
    notes: row.notes,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

export default async function riskzillaSettingsRoutes(app: FastifyInstance) {
  // ── Tier-keyed default settings ───────────────────────────────────
  app.get("/admin/riskzilla/settings", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select()
      .from(riskzillaSettings)
      .orderBy(riskzillaSettings.tier);
    return { entries: rows.map(settingsRowToDto) };
  });

  app.put("/admin/riskzilla/settings/:tier", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ tier: z.coerce.number().int().min(0).max(32) }).parse(
      request.params,
    );
    const body = settingsPutBody.parse(request.body);

    // Pre-validate the float-shaped fields before hitting the DB so
    // callers get a clean error instead of a 500 from the CHECK
    // constraints.
    const matchLiability = BigInt(body.matchLiabilityMicro);
    const minBet = BigInt(body.minBetMicro);
    const maxPayout = BigInt(body.maxPayoutMicro);
    const betFactor = Number(body.betFactor);
    if (matchLiability <= 0n) {
      throw new BadRequestError("match_liability_must_be_positive", "match_liability_must_be_positive");
    }
    if (minBet <= 0n) {
      throw new BadRequestError("min_bet_must_be_positive", "min_bet_must_be_positive");
    }
    if (maxPayout <= 0n) {
      throw new BadRequestError("max_payout_must_be_positive", "max_payout_must_be_positive");
    }
    if (!(betFactor > 0 && betFactor <= 1)) {
      throw new BadRequestError("bet_factor_out_of_range", "bet_factor_out_of_range");
    }

    const [before] = await app.db
      .select()
      .from(riskzillaSettings)
      .where(eq(riskzillaSettings.tier, params.tier))
      .limit(1);

    const result = await app.db.transaction(async (tx) => {
      const [updated] = before
        ? await tx
            .update(riskzillaSettings)
            .set({
              matchLiabilityMicro: matchLiability,
              minBetMicro: minBet,
              maxPayoutMicro: maxPayout,
              betFactor: betFactor.toFixed(4),
              updatedBy: admin.id,
              updatedAt: new Date(),
            })
            .where(eq(riskzillaSettings.tier, params.tier))
            .returning()
        : await tx
            .insert(riskzillaSettings)
            .values({
              tier: params.tier,
              matchLiabilityMicro: matchLiability,
              minBetMicro: minBet,
              maxPayoutMicro: maxPayout,
              betFactor: betFactor.toFixed(4),
              updatedBy: admin.id,
            })
            .returning();
      if (!updated) throw new Error("riskzilla_settings upsert returned no row");

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: before ? "riskzilla.settings.update" : "riskzilla.settings.create",
        targetType: "riskzilla_settings",
        targetId: String(params.tier),
        beforeJson: before
          ? (settingsRowToDto(before) as unknown as Record<string, unknown>)
          : null,
        afterJson: settingsRowToDto(updated) as unknown as Record<string, unknown>,
        ipInet: request.ip ?? null,
      });
      return updated;
    });

    return settingsRowToDto(result);
  });

  // ── Per-market factor table ──────────────────────────────────────
  // GET serves a "configured + suggested" payload: every row currently
  // in riskzilla_market_factors PLUS the union of provider_market_ids
  // we have a description for. This lets the admin UI render the full
  // catalog of market types, with factor=1.000 as the implicit default
  // for unconfigured ones.
  app.get("/admin/riskzilla/market-factors", async (request) => {
    request.requireRole("admin");
    const configured = await app.db
      .select()
      .from(riskzillaMarketFactors)
      .orderBy(riskzillaMarketFactors.providerMarketId);
    const known = (await app.db.execute(sql`
      SELECT
        md.provider_market_id,
        -- Use the variant='' template when present, otherwise the
        -- first available template; falls back to a synthetic label.
        COALESCE(
          (
            SELECT name_template
              FROM market_descriptions inner_md
             WHERE inner_md.provider_market_id = md.provider_market_id
             ORDER BY (inner_md.variant = '') DESC, inner_md.variant
             LIMIT 1
          ),
          'Market #' || md.provider_market_id
        ) AS label
        FROM market_descriptions md
       GROUP BY md.provider_market_id
       ORDER BY md.provider_market_id
    `)) as unknown as Array<{ provider_market_id: number; label: string }>;
    const known_by_id = new Map<number, string>();
    for (const r of known) known_by_id.set(Number(r.provider_market_id), r.label);
    const configured_set = new Set(
      configured.map((r) => Number(r.providerMarketId)),
    );
    const entries: MarketFactorRowDto[] = configured.map(factorRowToDto);
    for (const id of known_by_id.keys()) {
      if (!configured_set.has(id)) {
        entries.push({
          providerMarketId: id,
          factor: "1.000",
          label: known_by_id.get(id)!,
          notes: null,
          updatedAt: new Date(0).toISOString(),
          updatedBy: null,
        });
      }
    }
    entries.sort((a, b) => a.providerMarketId - b.providerMarketId);
    return { entries };
  });

  app.put("/admin/riskzilla/market-factors/:providerMarketId", async (request) => {
    const admin = request.requireRole("admin");
    const params = z
      .object({ providerMarketId: z.coerce.number().int().min(0).max(100000) })
      .parse(request.params);
    const body = factorPutBody.parse(request.body);

    const factor = Number(body.factor);
    if (!(factor >= 0 && factor <= 1)) {
      throw new BadRequestError("factor_out_of_range", "factor_out_of_range");
    }

    const [before] = await app.db
      .select()
      .from(riskzillaMarketFactors)
      .where(eq(riskzillaMarketFactors.providerMarketId, params.providerMarketId))
      .limit(1);

    const result = await app.db.transaction(async (tx) => {
      const [updated] = before
        ? await tx
            .update(riskzillaMarketFactors)
            .set({
              factor: factor.toFixed(3),
              label: body.label,
              notes: body.notes ?? null,
              updatedBy: admin.id,
              updatedAt: new Date(),
            })
            .where(eq(riskzillaMarketFactors.providerMarketId, params.providerMarketId))
            .returning()
        : await tx
            .insert(riskzillaMarketFactors)
            .values({
              providerMarketId: params.providerMarketId,
              factor: factor.toFixed(3),
              label: body.label,
              notes: body.notes ?? null,
              updatedBy: admin.id,
            })
            .returning();
      if (!updated) throw new Error("riskzilla_market_factors upsert returned no row");

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: before
          ? "riskzilla.market_factor.update"
          : "riskzilla.market_factor.create",
        targetType: "riskzilla_market_factor",
        targetId: String(params.providerMarketId),
        beforeJson: before
          ? (factorRowToDto(before) as unknown as Record<string, unknown>)
          : null,
        afterJson: factorRowToDto(updated) as unknown as Record<string, unknown>,
        ipInet: request.ip ?? null,
      });
      return updated;
    });

    return factorRowToDto(result);
  });

  app.delete("/admin/riskzilla/market-factors/:providerMarketId", async (request) => {
    const admin = request.requireRole("admin");
    const params = z
      .object({ providerMarketId: z.coerce.number().int().min(0).max(100000) })
      .parse(request.params);

    const [before] = await app.db
      .select()
      .from(riskzillaMarketFactors)
      .where(eq(riskzillaMarketFactors.providerMarketId, params.providerMarketId))
      .limit(1);
    if (!before) {
      throw new NotFoundError("market_factor_not_found", "market_factor_not_found");
    }
    await app.db.transaction(async (tx) => {
      await tx
        .delete(riskzillaMarketFactors)
        .where(eq(riskzillaMarketFactors.providerMarketId, params.providerMarketId));
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "riskzilla.market_factor.delete",
        targetType: "riskzilla_market_factor",
        targetId: String(params.providerMarketId),
        beforeJson: factorRowToDto(before) as unknown as Record<string, unknown>,
        afterJson: null,
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true };
  });
}
