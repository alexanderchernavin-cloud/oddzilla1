// /admin/fe-settings endpoints. Storefront-display knobs that don't fit
// into odds/cashout/bet-product config (which all carry money math).
//
// Currently: per-sport per-scope ordering of market types, plus the tab
// (group) set itself. A "scope" is one tab on /match/:id:
//   match        — the base event: no `map`, no sub-event.
//   map_<N>      — one tab per esports map (`map=<N>`), independently
//                  configurable.
//   fb_<kinds>   — a Fonbet sub-event: halves, periods, corners, cards and
//                  their nestings, plus `fb_players` for every per-player
//                  market. The tab id comes from the `variant` specifier,
//                  the title from the market description's prefix.
//   top          — curated highlights tab. Empty by default. Rendered as a
//                  "Top" tab on /match/:id AND inline on match cards when
//                  the list is in Top mode.
//   custom_<key> — admin-created curated tab (migration 0084). Content
//                  semantics identical to `top`; the tab label + position
//                  live in fe_market_groups.
//
// The tab set is NOT stored — the match-detail endpoint derives it per
// request from the markets it renders. So this module re-derives it over
// the sport's current offer (lib/fe-market-scopes.ts) rather than
// enumerating a fixed list. Until 2026-09-05 it did enumerate one, and
// every sport was offered the esports shape: Match plus Map 1..5, which no
// football fixture has ever had, while the tabs bettors were actually
// looking at (1st half, Corners, Yellow cards) could not be configured at
// all.
//
// Group (tab) order: fe_market_groups rows carry display_order per
// (sport, scope). Tabs with a row render first (by display_order); tabs
// without one fall back to the storefront default (top, match, map_1..N,
// then sub-events by Fonbet kind). Writes keep this all-or-nothing per
// sport: creating the first custom group or saving a tab order seeds
// anchor rows for every other tab, so a freshly created group always lands
// at the end instead of jumping in front of unconfigured built-ins.
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
  marketDescriptions,
  isMarketScope,
  isCustomScope,
  isCuratedScope,
  type FeMarketScope,
} from "@oddzilla/db";
import { defaultScopeOrder } from "@oddzilla/types/market-scope";
import {
  discoverScopes,
  discoverSportScopes,
  type DiscoveredScope,
  type ScopeMarket,
} from "../../lib/fe-market-scopes.js";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";

// match | top | map_<N> | fb_<kinds> | custom_<key>. Matches the DB CHECK
// and the storefront's MarketScope.id encoding.
const scopeSchema = z
  .string()
  .refine(isMarketScope, { message: "invalid_scope" })
  .transform((s) => s as FeMarketScope);

// One row of the editor: a market TYPE on a specific sub-event. The bare
// number is the pre-0109 shape — kept accepted because it is still the
// right thing to send for a feed tab, where the sub-event is the tab.
const orderEntrySchema = z.union([
  z.number().int().min(1).max(100000),
  z.object({
    providerMarketId: z.number().int().min(1).max(100000),
    variant: z.string().max(200).default(""),
  }),
]);

const reorderBody = z.object({
  // Ordered list — index 0 renders first. Each (market, sub-event) appears
  // at most once (validated in the handler).
  order: z.array(orderEntrySchema).max(2000),
});

function normaliseEntry(
  e: z.infer<typeof orderEntrySchema>,
): { providerMarketId: number; variant: string } {
  return typeof e === "number"
    ? { providerMarketId: e, variant: "" }
    : { providerMarketId: e.providerMarketId, variant: e.variant };
}

// A row in the editor's pool.
interface PoolEntry {
  providerMarketId: number;
  variant: string;
  label: string;
  /** Feed tab this market belongs to; null when only a config row knows it. */
  tab: string | null;
}

function poolKey(m: { providerMarketId: number; variant: string }): string {
  return `${m.providerMarketId}:${m.variant}`;
}

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

type GroupRow = { scope: string; label: string | null; displayOrder: number };

interface Tab {
  scope: string;
  /**
   * Feed-derived title for sub-event tabs and the operator's own for custom
   * groups. Null for match / map_N / top, which the UI labels itself.
   */
  label: string | null;
  custom: boolean;
}

// The sport's tab strip as the storefront renders it: every tab its current
// offer produces, plus `top`, plus anything an operator has already
// configured (a tab whose markets are between fixtures must not vanish from
// the screen that configures it). Configured tabs sort first by their
// stored display_order, the rest by the storefront default.
function effectiveTabs(
  discovered: DiscoveredScope[],
  rows: GroupRow[],
  configuredScopes: Iterable<string>,
): Tab[] {
  const byScope = new Map(rows.map((r) => [r.scope, r]));
  const labels = new Map<string, string | null>();
  // `top` and `match` are always offered: Top is curated (it has no feed
  // side to discover) and Match is where the storefront falls back, so a
  // sport whose offer is empty right now still opens on a real tab.
  const scopes = new Set<string>(["top", "match"]);
  for (const d of discovered) {
    scopes.add(d.scope);
    labels.set(d.scope, d.label);
  }
  for (const s of configuredScopes) scopes.add(s);
  for (const r of rows) {
    scopes.add(r.scope);
    if (r.label != null) labels.set(r.scope, r.label);
  }

  return Array.from(scopes)
    .map((scope) => ({ scope, row: byScope.get(scope) }))
    .sort((a, b) => {
      const ba = a.row ? 0 : 1;
      const bb = b.row ? 0 : 1;
      if (ba !== bb) return ba - bb;
      const oa = a.row ? a.row.displayOrder : defaultScopeOrder(a.scope);
      const ob = b.row ? b.row.displayOrder : defaultScopeOrder(b.scope);
      if (oa !== ob) return oa - ob;
      return a.scope.localeCompare(b.scope);
    })
    .map(({ scope }) => ({
      scope,
      label: labels.get(scope) ?? null,
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

// provider_market_id -> configured position, per scope, for one sport.
async function loadOrderRows(app: FastifyInstance, sportId: number) {
  return app.db
    .select({
      scope: feMarketDisplayOrder.scope,
      providerMarketId: feMarketDisplayOrder.providerMarketId,
      variant: feMarketDisplayOrder.variant,
      displayOrder: feMarketDisplayOrder.displayOrder,
    })
    .from(feMarketDisplayOrder)
    .where(eq(feMarketDisplayOrder.sportId, sportId))
    .orderBy(asc(feMarketDisplayOrder.displayOrder));
}

export default async function feSettingsRoutes(app: FastifyInstance) {
  // ── Sport list with its real tab set ───────────────────────────────
  // The FE Settings landing screen. Each sport carries the tabs its own
  // offer produces — a football row lists Match / 1st half / Corners /
  // Players, an esports row Match / Map 1..5 — each with the number of
  // markets the operator has explicitly ordered on it.
  app.get("/admin/fe-settings/markets-order", async (request) => {
    request.requireRole("admin");

    const [sportRows, discovered, counts, groupRowsAll] = await Promise.all([
      app.db
        .select({ id: sports.id, slug: sports.slug, name: sports.name })
        .from(sports)
        .where(eq(sports.active, true))
        .orderBy(sports.slug),
      discoverScopes(app),
      app.db
        .select({
          sportId: feMarketDisplayOrder.sportId,
          scope: feMarketDisplayOrder.scope,
          configured: sql<string>`COUNT(*)::text`,
        })
        .from(feMarketDisplayOrder)
        .groupBy(feMarketDisplayOrder.sportId, feMarketDisplayOrder.scope),
      app.db
        .select({
          sportId: feMarketGroups.sportId,
          scope: feMarketGroups.scope,
          label: feMarketGroups.label,
          displayOrder: feMarketGroups.displayOrder,
        })
        .from(feMarketGroups)
        .orderBy(asc(feMarketGroups.sportId), asc(feMarketGroups.displayOrder)),
    ]);

    const countsBySport = new Map<number, Map<string, number>>();
    for (const c of counts) {
      const cur = countsBySport.get(c.sportId) ?? new Map<string, number>();
      cur.set(c.scope as string, Number(c.configured));
      countsBySport.set(c.sportId, cur);
    }
    const groupsBySport = new Map<number, GroupRow[]>();
    for (const g of groupRowsAll) {
      const cur = groupsBySport.get(g.sportId) ?? [];
      cur.push({ scope: g.scope, label: g.label, displayOrder: g.displayOrder });
      groupsBySport.set(g.sportId, cur);
    }

    return {
      sports: sportRows.map((s) => {
        const configured = countsBySport.get(s.id) ?? new Map<string, number>();
        const tabs = effectiveTabs(
          discovered.get(s.id)?.scopes ?? [],
          groupsBySport.get(s.id) ?? [],
          configured.keys(),
        );
        return {
          id: s.id,
          slug: s.slug,
          name: s.name,
          tabs: tabs.map((t) => ({
            ...t,
            configured: configured.get(t.scope) ?? 0,
          })),
        };
      }),
    };
  });

  // ── Detail: ordered + unranked markets for one (sport, scope) ───────
  // The "available" pool is whatever the sport's current offer puts on
  // that tab — the same derivation the match page runs, so what an
  // operator orders here is what a bettor sees. Curated tabs (`top` and
  // custom groups) have no implicit pool and draw from every market on the
  // sport instead. Markets an operator already ordered are always listed,
  // even if nothing is live under them right now.
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

    const [discovered, groupRows, orderRowsAll] = await Promise.all([
      discoverSportScopes(app, params.sportId),
      loadGroupRows(app, params.sportId),
      loadOrderRows(app, params.sportId),
    ]);

    const tabs = effectiveTabs(
      discovered.scopes,
      groupRows,
      orderRowsAll.map((r) => r.scope as string),
    );
    const tab = tabs.find((t) => t.scope === params.scope);
    if (!tab) {
      // A custom scope with no group row is a deleted group; anything else
      // is a tab this sport does not have (a Map 3 URL on football).
      throw isCustomScope(params.scope)
        ? new NotFoundError("group_not_found", "group_not_found")
        : new NotFoundError("scope_not_found", "scope_not_found");
    }

    // Two different jobs behind one screen, and they need different pools.
    //
    // A FEED tab (Match / Map N / a sub-event) already contains its markets
    // — membership is the feed's call, not the operator's — so the pool is
    // that tab's own market types and the only thing being configured is
    // their order. A CURATED tab (Top, custom groups) is opt-in membership,
    // so its pool is every market on the sport, one entry per (type,
    // sub-event): "Total" exists on Match, on Corners and on 1st half, and
    // picking which of those to feature is the whole point.
    const curated = isCuratedScope(params.scope);
    const pool: PoolEntry[] = curated
      ? discovered.allMarkets.map((m) => ({
          providerMarketId: m.providerMarketId,
          variant: m.variant,
          label: m.label,
          tab: m.scope,
        }))
      : (
          discovered.scopes.find((s) => s.scope === params.scope)?.markets ?? []
        ).map((m) => ({
          providerMarketId: m.providerMarketId,
          // Feed-tab rows carry no variant: the tab IS the sub-event.
          variant: "",
          label: m.label,
          tab: params.scope as string,
        }));

    const orderRows = orderRowsAll.filter((r) => r.scope === params.scope);
    const byKey = new Map<string, PoolEntry>(pool.map((m) => [poolKey(m), m]));

    // A configured row the current offer doesn't carry still needs a name —
    // it stays listed so an operator can see and remove it. The description
    // table is small, so one targeted read covers them.
    const missing = orderRows.filter(
      (r) => !byKey.has(`${r.providerMarketId}:${r.variant}`),
    );
    if (missing.length > 0) {
      const descRows = await app.db
        .select({
          providerMarketId: marketDescriptions.providerMarketId,
          variant: marketDescriptions.variant,
          nameTemplate: marketDescriptions.nameTemplate,
        })
        .from(marketDescriptions)
        .where(
          and(
            inArray(
              marketDescriptions.providerMarketId,
              missing.map((r) => r.providerMarketId),
            ),
            // Backoffice is English; pinning the language also sidesteps
            // the one-row-per-language duplication market descriptions
            // have carried since the Fonbet line landed.
            eq(marketDescriptions.language, "en"),
          ),
        );
      const templates = new Map<string, string>();
      for (const d of descRows) {
        templates.set(`${d.providerMarketId}:${d.variant}`, d.nameTemplate);
      }
      for (const r of missing) {
        const label =
          templates.get(`${r.providerMarketId}:${r.variant}`) ??
          templates.get(`${r.providerMarketId}:`) ??
          `Market #${r.providerMarketId}`;
        byKey.set(`${r.providerMarketId}:${r.variant}`, {
          providerMarketId: r.providerMarketId,
          variant: r.variant,
          label,
          tab: null,
        });
      }
    }

    const configured = new Set(
      orderRows.map((r) => `${r.providerMarketId}:${r.variant}`),
    );
    const ordered = orderRows.map((r) => {
      const key = `${r.providerMarketId}:${r.variant}`;
      const hit = byKey.get(key);
      return {
        providerMarketId: r.providerMarketId,
        variant: r.variant,
        label: hit?.label ?? `Market #${r.providerMarketId}`,
        tab: hit?.tab ?? null,
        displayOrder: r.displayOrder,
      };
    });
    const unranked = pool.filter((m) => !configured.has(poolKey(m)));

    return {
      sport,
      scope: params.scope,
      label: tab.label,
      // Curated tabs are opt-in membership; feed tabs are order-only. The
      // editor renders one column or two off this flag.
      curated,
      // Every tab in effective storefront order — the editor's nav strip
      // mirrors what bettors see, custom groups included.
      groups: tabs,
      ordered,
      unranked,
    };
  });

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

    // A feed tab is one sub-event already, so its rows carry no variant —
    // writing one there would fragment the list into "Match result way:two"
    // beside "Match result way:three".
    const entries = body.order
      .map(normaliseEntry)
      .map((e) =>
        isCuratedScope(params.scope) ? e : { ...e, variant: "" },
      );

    const seen = new Set<string>();
    for (const e of entries) {
      const key = poolKey(e);
      if (seen.has(key)) {
        throw new BadRequestError(
          `duplicate_provider_market_id_${e.providerMarketId}`,
          `duplicate_provider_market_id_${e.providerMarketId}_in_order`,
        );
      }
      seen.add(key);
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
        variant: feMarketDisplayOrder.variant,
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

      if (entries.length > 0) {
        await tx.insert(feMarketDisplayOrder).values(
          entries.map((e, idx) => ({
            sportId: params.sportId,
            scope: params.scope,
            providerMarketId: e.providerMarketId,
            variant: e.variant,
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
          order: entries,
        },
        ipInet: request.ip ?? null,
      });
    });

    return {
      ok: true,
      sportId: params.sportId,
      scope: params.scope,
      count: entries.length,
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

    const [discovered, groupRows, orderRowsAll] = await Promise.all([
      discoverSportScopes(app, params.sportId),
      loadGroupRows(app, params.sportId),
      loadOrderRows(app, params.sportId),
    ]);
    const countByScope = new Map<string, number>();
    for (const r of orderRowsAll) {
      const scope = r.scope as string;
      countByScope.set(scope, (countByScope.get(scope) ?? 0) + 1);
    }

    return {
      sport,
      // True once any row exists — i.e. the tab order is admin-managed
      // rather than the built-in default.
      ordered: groupRows.length > 0,
      groups: effectiveTabs(
        discovered.scopes,
        groupRows,
        countByScope.keys(),
      ).map((g) => ({
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

      const [discovered, groupRows] = await Promise.all([
        discoverSportScopes(app, params.sportId),
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
          // First configuration for this sport: pin every existing tab at
          // its current default position so the tab order stays stable
          // when the custom group appends after it. Which tabs those are
          // is the sport's own business — Map 1..5 for an esport, halves
          // and corners for football.
          const seeds = effectiveTabs(discovered.scopes, [], [])
            .filter((t) => !t.custom)
            .map((t) => t.scope as FeMarketScope);
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
