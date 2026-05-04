// /admin/fe-settings endpoints. Storefront-display knobs that don't fit
// into odds/cashout/bet-product config (which all carry money math).
//
// Currently: per-sport per-scope ordering of market types. Three scopes:
//   match — markets without a `map` specifier (the Match tab on /match/:id
//           and the match-cards Match-tab inline odds).
//   map   — markets with a `map` specifier; one ordering shared across
//           every map_N tab.
//   top   — curated highlights tab. Empty by default. Rendered as a "Top"
//           scope tab on /match/:id AND inline on match cards when the
//           list is in Top mode.
//
// Read by /catalog/matches/:id (match-detail page) and the catalog list
// endpoints when ?tab=top — no in-memory cache. The table is small.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  feMarketDisplayOrder,
  adminAuditLog,
  sports,
  categories,
  tournaments,
  matches,
  markets,
  marketDescriptions,
  FE_MARKET_SCOPES,
  type FeMarketScope,
} from "@oddzilla/db";
import { NotFoundError } from "../../lib/errors.js";

const scopeEnum = z.enum(FE_MARKET_SCOPES as unknown as [FeMarketScope, ...FeMarketScope[]]);

const reorderBody = z.object({
  // Ordered list — index 0 renders first. Each provider_market_id appears
  // at most once (validated in the handler).
  order: z
    .array(z.number().int().min(1).max(100000))
    .max(1000),
});

export default async function feSettingsRoutes(app: FastifyInstance) {
  // ── Sport list with per-scope row counts ────────────────────────────
  // Used by the FE Settings landing screen as a sport picker. Counts are
  // per scope so the admin can see at a glance which sports + scopes have
  // overrides applied.
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
        scope: feMarketDisplayOrder.scope,
        configured: sql<string>`COUNT(*)::text`,
      })
      .from(feMarketDisplayOrder)
      .groupBy(feMarketDisplayOrder.sportId, feMarketDisplayOrder.scope);

    type ScopeCounts = Record<FeMarketScope, number>;
    const empty = (): ScopeCounts => ({ match: 0, map: 0, top: 0 });
    const bySport = new Map<number, ScopeCounts>();
    for (const c of counts) {
      const cur = bySport.get(c.sportId) ?? empty();
      cur[c.scope as FeMarketScope] = Number(c.configured);
      bySport.set(c.sportId, cur);
    }

    return {
      sports: sportRows.map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        configured: bySport.get(s.id) ?? empty(),
      })),
    };
  });

  // ── Detail: ordered + unranked markets for one (sport, scope) ───────
  // The "available" pool depends on the scope:
  //   match — distinct provider_market_id values seen on this sport's
  //           markets WITHOUT a `map` specifier.
  //   map   — distinct provider_market_id seen WITH a `map` specifier.
  //   top   — union of both pools (admin can curate from any market type).
  // Markets with no description fall back to "Market #N".
  app.get("/admin/fe-settings/markets-order/:sportId/:scope", async (request) => {
    request.requireRole("admin");
    const params = z
      .object({
        sportId: z.coerce.number().int().positive(),
        scope: scopeEnum,
      })
      .parse(request.params);

    const [sport] = await app.db
      .select({ id: sports.id, slug: sports.slug, name: sports.name })
      .from(sports)
      .where(eq(sports.id, params.sportId))
      .limit(1);
    if (!sport) throw new NotFoundError("sport_not_found", "sport_not_found");

    // jsonb `?` is the "key-exists" operator. Test against the raw column
    // because Drizzle's pgcore doesn't expose it directly.
    const matchScopeFilter = sql`NOT (${markets.specifiersJson} ? 'map')`;
    const mapScopeFilter = sql`(${markets.specifiersJson} ? 'map')`;

    let scopeFilter = matchScopeFilter;
    if (params.scope === "map") scopeFilter = mapScopeFilter;
    else if (params.scope === "top") scopeFilter = sql`TRUE`;

    const seenMarketRows = await app.db
      .selectDistinct({ providerMarketId: markets.providerMarketId })
      .from(markets)
      .innerJoin(matches, eq(matches.id, markets.matchId))
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .where(and(eq(categories.sportId, params.sportId), scopeFilter));
    const seenIds = seenMarketRows.map((r) => r.providerMarketId);

    const orderRows = await app.db
      .select({
        providerMarketId: feMarketDisplayOrder.providerMarketId,
        displayOrder: feMarketDisplayOrder.displayOrder,
      })
      .from(feMarketDisplayOrder)
      .where(
        and(
          eq(feMarketDisplayOrder.sportId, params.sportId),
          eq(feMarketDisplayOrder.scope, params.scope),
        ),
      )
      .orderBy(asc(feMarketDisplayOrder.displayOrder));

    const configuredIds = new Set(orderRows.map((r) => r.providerMarketId));
    const allIds = Array.from(
      new Set([...seenIds, ...orderRows.map((r) => r.providerMarketId)]),
    );

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
      scope: params.scope,
      ordered,
      unranked,
    };
  });

  // ── Replace the order list for a (sport, scope) in one shot ────────
  app.put("/admin/fe-settings/markets-order/:sportId/:scope", async (request) => {
    const admin = request.requireRole("admin");
    const params = z
      .object({
        sportId: z.coerce.number().int().positive(),
        scope: scopeEnum,
      })
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
      .where(
        and(
          eq(feMarketDisplayOrder.sportId, params.sportId),
          eq(feMarketDisplayOrder.scope, params.scope),
        ),
      )
      .orderBy(asc(feMarketDisplayOrder.displayOrder));

    await app.db.transaction(async (tx) => {
      await tx
        .delete(feMarketDisplayOrder)
        .where(
          and(
            eq(feMarketDisplayOrder.sportId, params.sportId),
            eq(feMarketDisplayOrder.scope, params.scope),
          ),
        );

      if (body.order.length > 0) {
        await tx.insert(feMarketDisplayOrder).values(
          body.order.map((providerMarketId, idx) => ({
            sportId: params.sportId,
            scope: params.scope,
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
        targetId: `${params.sportId}:${params.scope}`,
        beforeJson: { order: before },
        afterJson: {
          sportSlug: sport.slug,
          scope: params.scope,
          order: body.order,
        },
        ipInet: request.ip ?? null,
      });
    });

    return {
      ok: true,
      sportId: params.sportId,
      scope: params.scope,
      count: body.order.length,
    };
  });

  // ── Delete the per-(sport, scope) override (revert to default) ─────
  app.delete("/admin/fe-settings/markets-order/:sportId/:scope", async (request) => {
    const admin = request.requireRole("admin");
    const params = z
      .object({
        sportId: z.coerce.number().int().positive(),
        scope: scopeEnum,
      })
      .parse(request.params);

    const before = await app.db
      .select({
        providerMarketId: feMarketDisplayOrder.providerMarketId,
        displayOrder: feMarketDisplayOrder.displayOrder,
      })
      .from(feMarketDisplayOrder)
      .where(
        and(
          eq(feMarketDisplayOrder.sportId, params.sportId),
          eq(feMarketDisplayOrder.scope, params.scope),
        ),
      )
      .orderBy(asc(feMarketDisplayOrder.displayOrder));

    if (before.length === 0) {
      return { ok: true, deleted: 0 };
    }

    await app.db.transaction(async (tx) => {
      await tx
        .delete(feMarketDisplayOrder)
        .where(
          and(
            eq(feMarketDisplayOrder.sportId, params.sportId),
            eq(feMarketDisplayOrder.scope, params.scope),
          ),
        );
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "fe_settings.markets_order.clear",
        targetType: "fe_market_display_order",
        targetId: `${params.sportId}:${params.scope}`,
        beforeJson: { order: before, scope: params.scope },
        afterJson: null,
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, deleted: before.length };
  });
}
