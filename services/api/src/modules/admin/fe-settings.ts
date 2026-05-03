// /admin/fe-settings endpoints. Storefront-display knobs that don't fit
// into odds/cashout/bet-product config (which all carry money math). For
// now: per-sport ordering of market types on the match-detail page.
//
// Read by /catalog/matches/:id — no in-memory cache. The route reads at
// most a few dozen rows per match, so a per-request query is fine.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  feMarketDisplayOrder,
  adminAuditLog,
  sports,
  categories,
  tournaments,
  matches,
  markets,
  marketDescriptions,
} from "@oddzilla/db";
import { NotFoundError } from "../../lib/errors.js";

const reorderBody = z.object({
  // Ordered list — index 0 renders first. Each provider_market_id
  // appears at most once (validated below).
  order: z
    .array(z.number().int().min(1).max(100000))
    .max(1000),
});

export default async function feSettingsRoutes(app: FastifyInstance) {
  // ── List sports with their current market-order config ─────────────
  // Used by the FE Settings landing screen as a sport picker.
  app.get("/admin/fe-settings/markets-order", async (request) => {
    request.requireRole("admin");

    const sportRows = await app.db
      .select({ id: sports.id, slug: sports.slug, name: sports.name })
      .from(sports)
      .where(eq(sports.active, true))
      .orderBy(sports.slug);

    const counts = await app.db
      .select({
        sportId: feMarketDisplayOrder.sportId,
        configured: sql<string>`COUNT(*)::text`,
      })
      .from(feMarketDisplayOrder)
      .groupBy(feMarketDisplayOrder.sportId);

    const configuredBySport = new Map<number, number>();
    for (const c of counts) configuredBySport.set(c.sportId, Number(c.configured));

    return {
      sports: sportRows.map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        configuredMarketCount: configuredBySport.get(s.id) ?? 0,
      })),
    };
  });

  // ── Detail: ordered markets for one sport + the available pool ─────
  // The "available" list is the union of provider_market_id values that
  // have ever appeared on a match under this sport, joined with the
  // market_descriptions catalogue so the admin sees a human label
  // (e.g. "Match winner", "Total kills - map {map}") next to the ID.
  // Markets with no description fall back to "Market #N" so a fresh
  // Oddin market type still shows up usable.
  app.get("/admin/fe-settings/markets-order/:sportId", async (request) => {
    request.requireRole("admin");
    const params = z
      .object({ sportId: z.coerce.number().int().positive() })
      .parse(request.params);

    const [sport] = await app.db
      .select({ id: sports.id, slug: sports.slug, name: sports.name })
      .from(sports)
      .where(eq(sports.id, params.sportId))
      .limit(1);
    if (!sport) throw new NotFoundError("sport_not_found", "sport_not_found");

    // Distinct provider_market_id values this sport has actually exposed
    // on the feed. Bounded by an inner-join chain through the catalog
    // tree — cheap because markets is indexed on match_id.
    const seenMarketRows = await app.db
      .selectDistinct({ providerMarketId: markets.providerMarketId })
      .from(markets)
      .innerJoin(matches, eq(matches.id, markets.matchId))
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .where(eq(categories.sportId, params.sportId));
    const seenIds = seenMarketRows.map((r) => r.providerMarketId);

    // Currently-configured order rows. Always include them in the pool
    // even if no current market under the sport carries that id — so a
    // saved order doesn't silently disappear when matches close.
    const orderRows = await app.db
      .select({
        providerMarketId: feMarketDisplayOrder.providerMarketId,
        displayOrder: feMarketDisplayOrder.displayOrder,
      })
      .from(feMarketDisplayOrder)
      .where(eq(feMarketDisplayOrder.sportId, params.sportId))
      .orderBy(asc(feMarketDisplayOrder.displayOrder));

    const configuredIds = new Set(orderRows.map((r) => r.providerMarketId));
    const allIds = Array.from(new Set([...seenIds, ...orderRows.map((r) => r.providerMarketId)]));

    // Pull a label per provider_market_id. Description templates live
    // per-(market,variant) — pick the variant='' default; if absent,
    // fall back to any variant for that market id.
    const descRows = allIds.length
      ? await app.db
          .select({
            providerMarketId: marketDescriptions.providerMarketId,
            variant: marketDescriptions.variant,
            nameTemplate: marketDescriptions.nameTemplate,
          })
          .from(marketDescriptions)
          .where(inArray(marketDescriptions.providerMarketId, allIds))
      : [];
    const labelByID = new Map<number, string>();
    for (const d of descRows) {
      const existing = labelByID.get(d.providerMarketId);
      if (!existing || d.variant === "") {
        labelByID.set(d.providerMarketId, d.nameTemplate);
      }
    }

    function entry(providerMarketId: number) {
      return {
        providerMarketId,
        label: labelByID.get(providerMarketId) ?? `Market #${providerMarketId}`,
      };
    }

    const ordered = orderRows.map((r) => ({
      ...entry(r.providerMarketId),
      displayOrder: r.displayOrder,
    }));

    const unranked = allIds
      .filter((id) => !configuredIds.has(id))
      .sort((a, b) => a - b)
      .map(entry);

    return {
      sport,
      ordered,
      unranked,
    };
  });

  // ── Replace the order list for a sport in one shot ─────────────────
  // The body is an explicit array of provider_market_ids; index 0 wins.
  // Anything not in the array is removed, becoming "unranked" (and so
  // sorted by provider_market_id ascending at render time). A single
  // transaction wipes + re-inserts so the table never observes a
  // half-applied state.
  app.put("/admin/fe-settings/markets-order/:sportId", async (request) => {
    const admin = request.requireRole("admin");
    const params = z
      .object({ sportId: z.coerce.number().int().positive() })
      .parse(request.params);
    const body = reorderBody.parse(request.body);

    const seen = new Set<number>();
    for (const id of body.order) {
      if (seen.has(id)) {
        throw new Error(`duplicate provider_market_id ${id} in order`);
      }
      seen.add(id);
    }

    const [sport] = await app.db
      .select({ id: sports.id, slug: sports.slug, name: sports.name })
      .from(sports)
      .where(eq(sports.id, params.sportId))
      .limit(1);
    if (!sport) throw new NotFoundError("sport_not_found", "sport_not_found");

    const before = await app.db
      .select({
        providerMarketId: feMarketDisplayOrder.providerMarketId,
        displayOrder: feMarketDisplayOrder.displayOrder,
      })
      .from(feMarketDisplayOrder)
      .where(eq(feMarketDisplayOrder.sportId, params.sportId))
      .orderBy(asc(feMarketDisplayOrder.displayOrder));

    await app.db.transaction(async (tx) => {
      await tx
        .delete(feMarketDisplayOrder)
        .where(eq(feMarketDisplayOrder.sportId, params.sportId));

      if (body.order.length > 0) {
        await tx.insert(feMarketDisplayOrder).values(
          body.order.map((providerMarketId, idx) => ({
            sportId: params.sportId,
            providerMarketId,
            displayOrder: idx,
            updatedBy: admin.id,
          })),
        );
      }

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "fe_settings.markets_order.set",
        targetType: "fe_market_display_order",
        targetId: params.sportId.toString(),
        beforeJson: { order: before },
        afterJson: { sportSlug: sport.slug, order: body.order },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, sportId: params.sportId, count: body.order.length };
  });

  // ── Delete the per-sport override (revert to default order) ───────
  app.delete("/admin/fe-settings/markets-order/:sportId", async (request) => {
    const admin = request.requireRole("admin");
    const params = z
      .object({ sportId: z.coerce.number().int().positive() })
      .parse(request.params);

    const before = await app.db
      .select({
        providerMarketId: feMarketDisplayOrder.providerMarketId,
        displayOrder: feMarketDisplayOrder.displayOrder,
      })
      .from(feMarketDisplayOrder)
      .where(eq(feMarketDisplayOrder.sportId, params.sportId))
      .orderBy(asc(feMarketDisplayOrder.displayOrder));

    if (before.length === 0) {
      return { ok: true, deleted: 0 };
    }

    await app.db.transaction(async (tx) => {
      await tx
        .delete(feMarketDisplayOrder)
        .where(eq(feMarketDisplayOrder.sportId, params.sportId));
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "fe_settings.markets_order.clear",
        targetType: "fe_market_display_order",
        targetId: params.sportId.toString(),
        beforeJson: { order: before },
        afterJson: null,
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, deleted: before.length };
  });
}
