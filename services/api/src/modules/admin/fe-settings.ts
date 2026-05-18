// /admin/fe-settings endpoints. Storefront-display knobs that don't fit
// into odds/cashout/bet-product config (which all carry money math).
//
// Currently: per-sport per-scope ordering of market types. Scopes:
//   match     — markets without a `map` specifier (the Match tab on
//               /match/:id and the match-cards Match-tab inline odds).
//   top       — curated highlights tab. Empty by default. Rendered as a
//               "Top" scope tab on /match/:id AND inline on match cards
//               when the list is in Top mode.
//   map_<N>   — markets carrying `map=<N>`. One independently configurable
//               list per map tab (Map 1 / Map 2 / Map 3 / …). Replaces the
//               pre-0057 shared `map` scope; existing rows were backfilled
//               to map_1..map_5 by the migration.
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
  isMarketScope,
  isMapScope,
  mapScopeNumber,
  type FeMarketScope,
} from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";

// match | top | map_<N> where N is a positive integer (no leading zeros).
// Matches the DB CHECK and the storefront's MarketScope.id encoding.
const scopeSchema = z
  .string()
  .refine(isMarketScope, { message: "invalid_scope" })
  .transform((s) => s as FeMarketScope);

const reorderBody = z.object({
  // Ordered list — index 0 renders first. Each provider_market_id appears
  // at most once (validated in the handler).
  order: z
    .array(z.number().int().min(1).max(100000))
    .max(1000),
});

// Each PUT is a transactional DELETE+INSERT on fe_market_display_order
// (held lock = O(N) where N is the supplied order length). Spamming
// 1000-id PUTs from a stolen admin token would bloat the audit log
// and churn the table. 30/hour is plenty for legitimate operators
// (the storefront ordering changes once per launch, not continuously).
const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 hour" },
};

export default async function feSettingsRoutes(app: FastifyInstance) {
  // ── Sport list with per-scope row counts ────────────────────────────
  // Used by the FE Settings landing screen as a sport picker. Counts are
  // per scope so the admin can see at a glance which sports + scopes have
  // overrides applied. Also exposes `maxMapNumber` per sport (the largest
  // `map` specifier observed on the sport's markets) so the picker can
  // render the right number of Map N columns dynamically — sports that
  // never go past Map 3 don't render Map 4/5 chips.
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

    // Largest map specifier value seen per sport. The cast filters out any
    // non-numeric `map` values (none today, but defensive against future
    // specifier shapes). LIMIT via MAX so the planner can index-only scan.
    const maxMapRows = await app.db
      .select({
        sportId: categories.sportId,
        maxMap: sql<string | null>`MAX((${markets.specifiersJson}->>'map')::int)`,
      })
      .from(markets)
      .innerJoin(matches, eq(matches.id, markets.matchId))
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .where(sql`(${markets.specifiersJson} ? 'map') AND (${markets.specifiersJson}->>'map') ~ '^[0-9]+$'`)
      .groupBy(categories.sportId);

    const maxMapBySport = new Map<number, number>();
    for (const r of maxMapRows) {
      const n = r.maxMap == null ? 0 : Number(r.maxMap);
      if (Number.isFinite(n) && n > 0) maxMapBySport.set(r.sportId, n);
    }

    // Counts come back as a flat scope -> count dict. Keys are exactly the
    // scope values stored in the DB (match | top | map_<N>) so the UI can
    // index in directly without re-deriving them.
    const countsBySport = new Map<number, Record<string, number>>();
    for (const c of counts) {
      const cur = countsBySport.get(c.sportId) ?? {};
      cur[c.scope] = Number(c.configured);
      countsBySport.set(c.sportId, cur);
    }

    return {
      sports: sportRows.map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        // BO5 is the deepest format on the supported sports; the migration
        // backfilled map_1..map_5 for every legacy `map` row, so admins
        // always see at least 5 map columns. Discovery can lift the
        // ceiling higher for any sport that actually carries map > 5.
        maxMapNumber: Math.max(5, maxMapBySport.get(s.id) ?? 0),
        configured: countsBySport.get(s.id) ?? {},
      })),
    };
  });

  // ── Detail: ordered + unranked markets for one (sport, scope) ───────
  // The "available" pool depends on the scope:
  //   match    — distinct provider_market_id values seen on this sport's
  //              markets WITHOUT a `map` specifier.
  //   map_<N>  — distinct provider_market_id seen WITH `map=<N>` exactly.
  //   top      — union of every market on this sport (admin can curate
  //              from any market type, regardless of scope).
  // Markets with no description fall back to "Market #N".
  app.get("/admin/fe-settings/markets-order/:sportId/:scope", async (request) => {
    request.requireRole("admin");
    const params = z
      .object({
        sportId: z.coerce.number().int().positive(),
        scope: scopeSchema,
      })
      .parse(request.params);

    const [sport] = await app.db
      .select({ id: sports.id, slug: sports.slug, name: sports.name })
      .from(sports)
      .where(eq(sports.id, params.sportId))
      .limit(1);
    if (!sport) throw new NotFoundError("sport_not_found", "sport_not_found");

    // Largest `map` specifier seen on this sport's markets. Drives the
    // nav strip in the editor page so the admin can hop between sibling
    // Map N tabs without going back to the sport picker. Floor of 5 mirrors
    // the migration's backfill ceiling.
    const [maxMapRow] = await app.db
      .select({
        maxMap: sql<string | null>`MAX((${markets.specifiersJson}->>'map')::int)`,
      })
      .from(markets)
      .innerJoin(matches, eq(matches.id, markets.matchId))
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .where(
        and(
          eq(categories.sportId, params.sportId),
          sql`(${markets.specifiersJson} ? 'map') AND (${markets.specifiersJson}->>'map') ~ '^[0-9]+$'`,
        ),
      );
    const observedMaxMap = maxMapRow?.maxMap ? Number(maxMapRow.maxMap) : 0;
    const maxMapNumber = Math.max(
      5,
      Number.isFinite(observedMaxMap) ? observedMaxMap : 0,
    );

    // jsonb `?` is the "key-exists" operator. Test against the raw column
    // because Drizzle's pgcore doesn't expose it directly. For map_<N>
    // we additionally pin the value with `->>'map' = '<N>'` (the cast
    // would also work but text compare avoids a parser hop).
    let scopeFilter = sql`NOT (${markets.specifiersJson} ? 'map')`;
    if (params.scope === "top") {
      scopeFilter = sql`TRUE`;
    } else if (isMapScope(params.scope)) {
      const n = mapScopeNumber(params.scope);
      // n is non-null because isMapScope already matched the regex.
      scopeFilter = sql`(${markets.specifiersJson}->>'map') = ${String(n)}`;
    }

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
          .where(
            and(
              inArray(marketDescriptions.providerMarketId, allIds),
              // Admin UI is backoffice-English; pinning to 'en' also
              // sidesteps the post-migration-0051 duplicate-row issue
              // where the same provider_market_id ships once per
              // language now.
              eq(marketDescriptions.language, "en"),
            ),
          )
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
      maxMapNumber,
      ordered,
      unranked,
    };
  });

  // ── Replace the order list for a (sport, scope) in one shot ────────
  app.put(
    "/admin/fe-settings/markets-order/:sportId/:scope",
    { config: writeRateLimit },
    async (request) => {
    const admin = request.requireRole("admin");
    const params = z
      .object({
        sportId: z.coerce.number().int().positive(),
        scope: scopeSchema,
      })
      .parse(request.params);
    const body = reorderBody.parse(request.body);

    const seen = new Set<number>();
    for (const id of body.order) {
      if (seen.has(id)) {
        throw new BadRequestError(
          `duplicate_provider_market_id_${id}`,
          `duplicate_provider_market_id_${id}_in_order`,
        );
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
  app.delete(
    "/admin/fe-settings/markets-order/:sportId/:scope",
    { config: writeRateLimit },
    async (request) => {
    const admin = request.requireRole("admin");
    const params = z
      .object({
        sportId: z.coerce.number().int().positive(),
        scope: scopeSchema,
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
