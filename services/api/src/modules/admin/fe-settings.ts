// /admin/fe-settings endpoints. Storefront-display knobs that don't fit
// into odds/cashout/bet-product config (which all carry money math).
//
// Currently: per-sport per-scope ordering of market types. Scopes:
//   match        — markets without a `map` specifier (the Match tab on
//                  /match/:id and the match-cards Match-tab inline odds).
//   top          — curated highlights tab. Empty by default. Rendered as a
//                  "Top" scope tab on /match/:id AND inline on match cards
//                  when the list is in Top mode.
//   map_<N>      — markets carrying `map=<N>`. One independently configurable
//                  list per map tab (Map 1 / Map 2 / Map 3 / …). Replaces the
//                  pre-0057 shared `map` scope; existing rows were backfilled
//                  to map_1..map_5 by the migration.
//   custom_<key> — admin-created curated tab (migration 0084). Content
//                  semantics identical to `top`; the tab label + position
//                  live in fe_market_groups.
//
// Group (tab) order: fe_market_groups rows carry display_order per
// (sport, scope). Tabs with a row render first (by display_order); tabs
// without one fall back to the default order (top, match, map_1..N).
// Writes keep this all-or-nothing per sport: creating the first custom
// group or saving a tab order seeds anchor rows for every built-in tab,
// so a freshly created group always lands at the end instead of jumping
// in front of unconfigured built-ins.
//
// Read by /catalog/matches/:id (match-detail page) and the catalog list
// endpoints when ?tab=top — no in-memory cache. The tables are small.

import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  feMarketDisplayOrder,
  feMarketGroups,
  adminAuditLog,
  sports,
  categories,
  tournaments,
  matches,
  markets,
  marketDescriptions,
  isMarketScope,
  isMapScope,
  isCustomScope,
  isCuratedScope,
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

// Tab title for custom groups. Length cap mirrors the DB CHECK.
const groupLabelSchema = z.string().trim().min(1).max(40);

const MAX_CUSTOM_GROUPS_PER_SPORT = 20;

// Sort weight a tab gets when it has NO fe_market_groups row. Mirrors the
// storefront default: Top renders first, then Match, then Map 1..N.
// Customs always have a row, so the fallthrough never applies to them.
function defaultTabOrder(scope: string): number {
  if (scope === "top") return -1;
  if (scope === "match") return 0;
  const n = mapScopeNumber(scope);
  return n ?? Number.MAX_SAFE_INTEGER;
}

type GroupRow = { scope: string; label: string | null; displayOrder: number };

// Effective tab list for a sport: built-ins (top / match / map_1..maxMap)
// unioned with every configured row, sorted the way the storefront sorts
// them — configured tabs first by display_order, unconfigured after by
// default order. `label` is null for built-ins (the UI localises those).
function effectiveTabs(
  rows: GroupRow[],
  maxMapNumber: number,
): Array<{ scope: string; label: string | null; custom: boolean }> {
  const byScope = new Map(rows.map((r) => [r.scope, r]));
  const scopes = new Set<string>(["top", "match"]);
  for (let n = 1; n <= maxMapNumber; n++) scopes.add(`map_${n}`);
  for (const r of rows) scopes.add(r.scope);

  return Array.from(scopes)
    .map((scope) => ({ scope, row: byScope.get(scope) }))
    .sort((a, b) => {
      const ba = a.row ? 0 : 1;
      const bb = b.row ? 0 : 1;
      if (ba !== bb) return ba - bb;
      const oa = a.row ? a.row.displayOrder : defaultTabOrder(a.scope);
      const ob = b.row ? b.row.displayOrder : defaultTabOrder(b.scope);
      if (oa !== ob) return oa - ob;
      return a.scope.localeCompare(b.scope);
    })
    .map(({ scope, row }) => ({
      scope,
      label: row?.label ?? null,
      custom: isCustomScope(scope),
    }));
}

async function loadGroupRows(
  app: FastifyInstance,
  sportId: number,
): Promise<GroupRow[]> {
  return app.db
    .select({
      scope: feMarketGroups.scope,
      label: feMarketGroups.label,
      displayOrder: feMarketGroups.displayOrder,
    })
    .from(feMarketGroups)
    .where(eq(feMarketGroups.sportId, sportId))
    .orderBy(asc(feMarketGroups.displayOrder));
}

// Largest `map` specifier seen on a sport's markets, floored at 5 (BO5 is
// the deepest format the supported sports play; the 0057 backfill seeded
// map_1..map_5 everywhere, so admins always see at least 5 map tabs).
async function sportMaxMapNumber(
  app: FastifyInstance,
  sportId: number,
): Promise<number> {
  const [row] = await app.db
    .select({
      maxMap: sql<string | null>`MAX((${markets.specifiersJson}->>'map')::int)`,
    })
    .from(markets)
    .innerJoin(matches, eq(matches.id, markets.matchId))
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .innerJoin(categories, eq(categories.id, tournaments.categoryId))
    .where(
      and(
        eq(categories.sportId, sportId),
        sql`(${markets.specifiersJson} ? 'map') AND (${markets.specifiersJson}->>'map') ~ '^[0-9]+$'`,
      ),
    );
  const observed = row?.maxMap ? Number(row.maxMap) : 0;
  return Math.max(5, Number.isFinite(observed) ? observed : 0);
}

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

    // Custom groups per sport, in tab order — the landing table renders
    // them as extra chips after the built-in scopes.
    const groupRowsAll = await app.db
      .select({
        sportId: feMarketGroups.sportId,
        scope: feMarketGroups.scope,
        label: feMarketGroups.label,
      })
      .from(feMarketGroups)
      .orderBy(asc(feMarketGroups.sportId), asc(feMarketGroups.displayOrder));
    const customGroupsBySport = new Map<
      number,
      Array<{ scope: string; label: string | null }>
    >();
    for (const g of groupRowsAll) {
      if (!isCustomScope(g.scope)) continue;
      const cur = customGroupsBySport.get(g.sportId) ?? [];
      cur.push({ scope: g.scope, label: g.label });
      customGroupsBySport.set(g.sportId, cur);
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
        customGroups: customGroupsBySport.get(s.id) ?? [],
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
    // Map N tabs without going back to the sport picker.
    const maxMapNumber = await sportMaxMapNumber(app, params.sportId);

    // Group config rows: the nav strip renders every tab (incl. custom
    // groups) in its effective storefront order, and a custom scope in
    // the URL must actually exist as a group for this sport.
    const groupRows = await loadGroupRows(app, params.sportId);
    if (
      isCustomScope(params.scope) &&
      !groupRows.some((g) => g.scope === params.scope)
    ) {
      throw new NotFoundError("group_not_found", "group_not_found");
    }

    // jsonb `?` is the "key-exists" operator. Test against the raw column
    // because Drizzle's pgcore doesn't expose it directly. For map_<N>
    // we additionally pin the value with `->>'map' = '<N>'` (the cast
    // would also work but text compare avoids a parser hop).
    // Curated scopes (top + custom groups) draw from every market on the
    // sport — the admin can feature any market type regardless of scope.
    let scopeFilter = sql`NOT (${markets.specifiersJson} ? 'map')`;
    if (isCuratedScope(params.scope)) {
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
      // Every tab in effective storefront order — the editor's nav strip
      // mirrors what bettors see, custom groups included.
      groups: effectiveTabs(groupRows, maxMapNumber),
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

    // A curated list under a custom scope only makes sense while its
    // group row exists — reject writes to deleted/never-created groups
    // so fe_market_display_order can't accumulate dangling scopes.
    if (isCustomScope(params.scope)) {
      const [group] = await app.db
        .select({ id: feMarketGroups.id })
        .from(feMarketGroups)
        .where(
          and(
            eq(feMarketGroups.sportId, params.sportId),
            eq(feMarketGroups.scope, params.scope),
          ),
        )
        .limit(1);
      if (!group) throw new NotFoundError("group_not_found", "group_not_found");
    }

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

  // ════════════════════════════════════════════════════════════════════
  // Market groups (tabs) — custom curated tabs + tab ordering.
  // ════════════════════════════════════════════════════════════════════

  const sportParamSchema = z.object({
    sportId: z.coerce.number().int().positive(),
  });

  async function requireSport(sportId: number) {
    const [sport] = await app.db
      .select({ id: sports.id, slug: sports.slug, name: sports.name })
      .from(sports)
      .where(eq(sports.id, sportId))
      .limit(1);
    if (!sport) throw new NotFoundError("sport_not_found", "sport_not_found");
    return sport;
  }

  // ── Full tab list for one sport (Manage groups screen) ─────────────
  app.get("/admin/fe-settings/market-groups/:sportId", async (request) => {
    request.requireRole("admin");
    const params = sportParamSchema.parse(request.params);
    const sport = await requireSport(params.sportId);

    const [maxMapNumber, groupRows, counts] = await Promise.all([
      sportMaxMapNumber(app, params.sportId),
      loadGroupRows(app, params.sportId),
      app.db
        .select({
          scope: feMarketDisplayOrder.scope,
          configured: sql<string>`COUNT(*)::text`,
        })
        .from(feMarketDisplayOrder)
        .where(eq(feMarketDisplayOrder.sportId, params.sportId))
        .groupBy(feMarketDisplayOrder.scope),
    ]);
    const countByScope = new Map<string, number>(
      counts.map((c) => [c.scope as string, Number(c.configured)]),
    );

    return {
      sport,
      maxMapNumber,
      // True once any row exists — i.e. the tab order is admin-managed
      // rather than the built-in default.
      ordered: groupRows.length > 0,
      groups: effectiveTabs(groupRows, maxMapNumber).map((g) => ({
        ...g,
        marketCount: countByScope.get(g.scope) ?? 0,
      })),
    };
  });

  // ── Create a custom group ───────────────────────────────────────────
  // Seeds built-in anchor rows on first configuration so the new group
  // lands at the END of the current tab order instead of jumping ahead
  // of unconfigured built-ins.
  app.post(
    "/admin/fe-settings/market-groups/:sportId",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const params = sportParamSchema.parse(request.params);
      const body = z.object({ label: groupLabelSchema }).parse(request.body);
      const sport = await requireSport(params.sportId);

      const [maxMapNumber, groupRows] = await Promise.all([
        sportMaxMapNumber(app, params.sportId),
        loadGroupRows(app, params.sportId),
      ]);

      const customCount = groupRows.filter((g) => isCustomScope(g.scope)).length;
      if (customCount >= MAX_CUSTOM_GROUPS_PER_SPORT) {
        throw new BadRequestError("too_many_groups", "too_many_groups");
      }

      // 12 hex chars — fits the ^custom_[a-z0-9]{4,32}$ CHECK and is
      // collision-proof at this scale (the unique constraint backstops).
      const scope = `custom_${randomBytes(6).toString("hex")}` as FeMarketScope;

      await app.db.transaction(async (tx) => {
        let nextOrder: number;
        if (groupRows.length === 0) {
          // First configuration for this sport: pin every built-in tab
          // at its current default position so the tab order stays
          // stable when the custom group appends after them.
          const seeds: FeMarketScope[] = ["top", "match"];
          for (let n = 1; n <= maxMapNumber; n++) {
            seeds.push(`map_${n}` as FeMarketScope);
          }
          await tx
            .insert(feMarketGroups)
            .values(
              seeds.map((s, idx) => ({
                sportId: params.sportId,
                scope: s,
                label: null,
                displayOrder: idx,
                updatedBy: admin.id,
              })),
            )
            .onConflictDoNothing();
          nextOrder = seeds.length;
        } else {
          nextOrder =
            Math.max(...groupRows.map((g) => g.displayOrder)) + 1;
        }

        await tx.insert(feMarketGroups).values({
          sportId: params.sportId,
          scope,
          label: body.label,
          displayOrder: nextOrder,
          updatedBy: admin.id,
        });

        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "fe_settings.market_groups.create",
          targetType: "fe_market_groups",
          targetId: `${params.sportId}:${scope}`,
          beforeJson: null,
          afterJson: { sportSlug: sport.slug, scope, label: body.label },
          ipInet: request.ip ?? null,
        });
      });

      return { ok: true, group: { scope, label: body.label } };
    },
  );

  // ── Rename a custom group ───────────────────────────────────────────
  app.patch(
    "/admin/fe-settings/market-groups/:sportId/:scope",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const params = z
        .object({
          sportId: z.coerce.number().int().positive(),
          scope: z.string().refine(isCustomScope, { message: "invalid_scope" }),
        })
        .parse(request.params);
      const body = z.object({ label: groupLabelSchema }).parse(request.body);
      const sport = await requireSport(params.sportId);

      const [group] = await app.db
        .select({
          id: feMarketGroups.id,
          label: feMarketGroups.label,
        })
        .from(feMarketGroups)
        .where(
          and(
            eq(feMarketGroups.sportId, params.sportId),
            eq(feMarketGroups.scope, params.scope as FeMarketScope),
          ),
        )
        .limit(1);
      if (!group) throw new NotFoundError("group_not_found", "group_not_found");

      await app.db.transaction(async (tx) => {
        await tx
          .update(feMarketGroups)
          .set({ label: body.label, updatedAt: new Date(), updatedBy: admin.id })
          .where(eq(feMarketGroups.id, group.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "fe_settings.market_groups.rename",
          targetType: "fe_market_groups",
          targetId: `${params.sportId}:${params.scope}`,
          beforeJson: { label: group.label },
          afterJson: { sportSlug: sport.slug, label: body.label },
          ipInet: request.ip ?? null,
        });
      });

      return { ok: true };
    },
  );

  // ── Delete a custom group (and its curated market list) ────────────
  app.delete(
    "/admin/fe-settings/market-groups/:sportId/:scope",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const params = z
        .object({
          sportId: z.coerce.number().int().positive(),
          scope: z.string().refine(isCustomScope, { message: "invalid_scope" }),
        })
        .parse(request.params);
      const sport = await requireSport(params.sportId);
      const scope = params.scope as FeMarketScope;

      const [group] = await app.db
        .select({ id: feMarketGroups.id, label: feMarketGroups.label })
        .from(feMarketGroups)
        .where(
          and(
            eq(feMarketGroups.sportId, params.sportId),
            eq(feMarketGroups.scope, scope),
          ),
        )
        .limit(1);
      if (!group) throw new NotFoundError("group_not_found", "group_not_found");

      const orderBefore = await app.db
        .select({
          providerMarketId: feMarketDisplayOrder.providerMarketId,
          displayOrder: feMarketDisplayOrder.displayOrder,
        })
        .from(feMarketDisplayOrder)
        .where(
          and(
            eq(feMarketDisplayOrder.sportId, params.sportId),
            eq(feMarketDisplayOrder.scope, scope),
          ),
        )
        .orderBy(asc(feMarketDisplayOrder.displayOrder));

      await app.db.transaction(async (tx) => {
        await tx
          .delete(feMarketDisplayOrder)
          .where(
            and(
              eq(feMarketDisplayOrder.sportId, params.sportId),
              eq(feMarketDisplayOrder.scope, scope),
            ),
          );
        await tx.delete(feMarketGroups).where(eq(feMarketGroups.id, group.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "fe_settings.market_groups.delete",
          targetType: "fe_market_groups",
          targetId: `${params.sportId}:${params.scope}`,
          beforeJson: {
            sportSlug: sport.slug,
            label: group.label,
            order: orderBefore,
          },
          afterJson: null,
          ipInet: request.ip ?? null,
        });
      });

      return { ok: true, deletedMarkets: orderBefore.length };
    },
  );

  // ── Replace the tab order for a sport in one shot ───────────────────
  // Body lists every tab scope in render order. Built-ins get anchor
  // rows (label NULL); custom scopes must already exist as groups and
  // must ALL be present (a custom group can't be dropped from the order
  // — delete it instead). Built-ins omitted from the list lose their
  // anchor row and fall back behind the configured tabs.
  app.put(
    "/admin/fe-settings/market-groups/:sportId/order",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const params = sportParamSchema.parse(request.params);
      const body = z
        .object({
          order: z
            .array(z.string().refine(isMarketScope, { message: "invalid_scope" }))
            .max(100),
        })
        .parse(request.body);
      const sport = await requireSport(params.sportId);

      const seen = new Set<string>();
      for (const s of body.order) {
        if (seen.has(s)) {
          throw new BadRequestError("duplicate_scope", `duplicate_scope_${s}`);
        }
        seen.add(s);
      }

      const groupRows = await loadGroupRows(app, params.sportId);
      const existingCustom = new Set(
        groupRows.filter((g) => isCustomScope(g.scope)).map((g) => g.scope),
      );
      // Custom groups carry a NOT NULL label (fe_market_groups_label_check);
      // built-ins require label IS NULL. The reorder only touches
      // display_order, but the INSERT below still supplies a label, and
      // Postgres evaluates CHECK constraints on the proposed row BEFORE
      // ON CONFLICT resolution — so inserting a custom scope with a null
      // label aborts the whole tx even though the conflict path would
      // never apply it. Carry each custom group's existing label through.
      const customLabelByScope = new Map(
        groupRows
          .filter((g) => isCustomScope(g.scope))
          .map((g) => [g.scope, g.label] as const),
      );
      for (const s of body.order) {
        if (isCustomScope(s) && !existingCustom.has(s)) {
          throw new BadRequestError("unknown_group", `unknown_group_${s}`);
        }
      }
      for (const s of existingCustom) {
        if (!seen.has(s)) {
          throw new BadRequestError(
            "missing_group",
            `missing_group_${s}_in_order`,
          );
        }
      }

      await app.db.transaction(async (tx) => {
        // Drop anchor rows for built-ins the new order omits; customs
        // are guaranteed present by the validation above. An empty order
        // (only possible with zero custom groups) reverts the sport to
        // the built-in default tab order.
        const builtInDropConds = [
          eq(feMarketGroups.sportId, params.sportId),
          sql`${feMarketGroups.scope} NOT LIKE 'custom\\_%'`,
        ];
        if (body.order.length > 0) {
          builtInDropConds.push(
            notInArray(feMarketGroups.scope, body.order as FeMarketScope[]),
          );
        }
        await tx.delete(feMarketGroups).where(and(...builtInDropConds));

        for (const [idx, scope] of body.order.entries()) {
          // Preserve the custom group's label so the CHECK constraint is
          // satisfied on the proposed row; built-ins stay label NULL. The
          // conflict path only bumps display_order regardless.
          const label = isCustomScope(scope)
            ? (customLabelByScope.get(scope) ?? null)
            : null;
          await tx
            .insert(feMarketGroups)
            .values({
              sportId: params.sportId,
              scope: scope as FeMarketScope,
              label,
              displayOrder: idx,
              updatedBy: admin.id,
            })
            .onConflictDoUpdate({
              target: [feMarketGroups.sportId, feMarketGroups.scope],
              set: {
                displayOrder: idx,
                updatedAt: new Date(),
                updatedBy: admin.id,
              },
            });
        }

        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "fe_settings.market_groups.reorder",
          targetType: "fe_market_groups",
          targetId: `${params.sportId}`,
          beforeJson: { groups: groupRows },
          afterJson: { sportSlug: sport.slug, order: body.order },
          ipInet: request.ip ?? null,
        });
      });

      return { ok: true, count: body.order.length };
    },
  );
}
