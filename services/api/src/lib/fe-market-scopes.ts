// Discovery of the market tabs a sport actually renders, and the markets
// inside each — the input the backoffice needs in order to configure them.
//
// The match-detail page derives its tabs per request from the markets it
// is about to render (packages/types/src/market-scope.ts). Nothing stores
// the tab set, so the backoffice cannot read it from a table: it has to
// re-derive it over the sport's current offer. Doing that is what turns
// "Match, Map 1..5, Top" — the esports shape the FE-settings screen used
// to offer every sport, football included — into the tabs a bettor sees
// (Match / 1st half / 2nd half / Corners / Yellow cards / Players).
//
// Two deliberate bounds on "the sport's markets":
//
//   * Only OPEN matches (not_started / live), and only markets in a status
//     the match page renders (active or suspended). The whole-table
//     alternative reads ~17M rows, takes ~9 s, and answers a different
//     question — it lists tabs from fixtures that finished months ago.
//     The current offer is what the operator is merchandising.
//
//   * Per-player Fonbet variants (`fb:<kinds>:<playerId>`) are collapsed in
//     SQL before the DISTINCT. Left alone they are one row per player per
//     market — thousands for a football weekend — and they all land on the
//     single `fb_players` tab anyway.
//
// Configured-but-unobserved scopes are added back by the caller from
// fe_market_display_order / fe_market_groups, so a tab an operator has
// already ordered never disappears from the backoffice just because
// nothing is live under it right now.

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  deriveMarketScope,
  isMapScope,
  MATCH_SCOPE,
} from "@oddzilla/types/market-scope";

export interface ScopeMarket {
  providerMarketId: number;
  /** Market-kind name with the sub-event prefix removed ("Total {threshold}"). */
  label: string;
}

export interface DiscoveredScope {
  /** The value stored in fe_market_display_order.scope. */
  scope: string;
  /**
   * Feed-derived tab title. Null for built-ins (match / map_N), which the
   * backoffice labels itself — a sub-event's title is Fonbet's own text.
   */
  label: string | null;
  /** Default storefront sort key for the tab. */
  order: number;
  markets: ScopeMarket[];
}

export interface SportScopes {
  scopes: DiscoveredScope[];
  /** Every market on the sport — the pool curated tabs (Top, customs) draw from. */
  allMarkets: ScopeMarket[];
}

interface ShapeRow extends Record<string, unknown> {
  sportId: number;
  providerMarketId: number;
  map: string | null;
  variant: string | null;
}

interface DescRow extends Record<string, unknown> {
  providerMarketId: number;
  variant: string;
  nameTemplate: string;
}

// The offer moves market by market, but the SET of market kinds a sport
// offers barely moves at all — so a short cache turns a 0.5-2 s scan into
// a free read for the several screens that need it, at the cost of a new
// market kind taking up to this long to appear in the picker. Operator
// configuration itself is always read fresh.
const CACHE_TTL_SECONDS = 120;
const CACHE_PREFIX = "fe:market-scopes:v1";

// Deepest map tab the backoffice offers a sport that plays maps at all.
// BO5 is the deepest format the supported esports play, and later maps
// exist as markets only once a series gets there — an operator has to be
// able to order Map 5 before anyone has played one.
const MIN_MAP_TABS = 5;

export async function discoverSportScopes(
  app: FastifyInstance,
  sportId: number,
): Promise<SportScopes> {
  const byId = await discoverScopes(app, sportId);
  return byId.get(sportId) ?? { scopes: [], allMarkets: [] };
}

export async function discoverScopes(
  app: FastifyInstance,
  sportId?: number,
): Promise<Map<number, SportScopes>> {
  const cacheKey = `${CACHE_PREFIX}:${sportId ?? "all"}`;
  try {
    const hit = await app.redis.get(cacheKey);
    if (hit) {
      return new Map(JSON.parse(hit) as Array<[number, SportScopes]>);
    }
  } catch {
    // The cache is an optimisation; a Redis blip just costs the scan.
  }

  const [shape, descs] = await Promise.all([
    loadShape(app, sportId),
    loadDescriptions(app),
  ]);
  const result = buildScopes(shape, descs);

  try {
    await app.redis.set(
      cacheKey,
      JSON.stringify(Array.from(result.entries())),
      "EX",
      CACHE_TTL_SECONDS,
    );
  } catch {
    // ignore
  }
  return result;
}

async function loadShape(
  app: FastifyInstance,
  sportId?: number,
): Promise<ShapeRow[]> {
  const sportFilter = sportId == null ? sql`TRUE` : sql`c.sport_id = ${sportId}`;
  const rows = await app.db.execute<ShapeRow>(sql`
    SELECT DISTINCT
      c.sport_id                AS "sportId",
      m.provider_market_id      AS "providerMarketId",
      m.specifiers_json->>'map' AS "map",
      CASE
        WHEN COALESCE(m.specifiers_json->>'variant', '') ~ '^fb:[0-9/]+:[0-9]+$'
          THEN regexp_replace(m.specifiers_json->>'variant', ':[0-9]+$', ':0')
        ELSE m.specifiers_json->>'variant'
      END                       AS "variant"
    FROM matches ma
    JOIN markets m     ON m.match_id = ma.id AND m.status IN (1, -1)
    JOIN tournaments t ON t.id = ma.tournament_id
    JOIN categories c  ON c.id = t.category_id
    WHERE ma.status IN ('not_started', 'live')
      AND ${sportFilter}
  `);
  return Array.from(rows);
}

async function loadDescriptions(app: FastifyInstance): Promise<DescRow[]> {
  // A few thousand rows in total. Pinned to English: the backoffice is
  // English, and all the derivation needs from the template is whether it
  // carries a sub-event prefix and what that prefix says.
  const rows = await app.db.execute<DescRow>(sql`
    SELECT provider_market_id AS "providerMarketId",
           variant            AS "variant",
           name_template      AS "nameTemplate"
    FROM market_descriptions
    WHERE language = 'en'
  `);
  return Array.from(rows);
}

interface ScopeAcc {
  label: string | null;
  order: number;
  markets: Map<number, string>;
}

// Pure half of the discovery, so the grouping rules are unit-testable
// without a database.
export function buildScopes(
  shape: ShapeRow[],
  descs: DescRow[],
): Map<number, SportScopes> {
  const templates = new Map<string, string>();
  for (const d of descs) {
    templates.set(`${d.providerMarketId}:${d.variant}`, d.nameTemplate);
  }
  const templateFor = (providerMarketId: number, variant: string): string =>
    templates.get(`${providerMarketId}:${variant}`) ??
    templates.get(`${providerMarketId}:`) ??
    `Market #${providerMarketId}`;

  const bySport = new Map<
    number,
    { scopes: Map<string, ScopeAcc>; all: Map<number, string> }
  >();

  for (const row of shape) {
    const variant = row.variant ?? "";
    const specifiers: Record<string, string> = {};
    if (row.map != null) specifiers.map = row.map;
    if (variant) specifiers.variant = variant;

    const derived = deriveMarketScope({
      specifiers,
      template: templateFor(row.providerMarketId, variant),
    });
    // The tab says "1st half"; the row inside it says "Total". Same split
    // the storefront makes between market.name (which keeps the prefix,
    // because a bet-slip leg carries no tab with it) and the market-kind
    // tag it renders in the card header.
    const label = derived.baseTemplate;

    let sportAcc = bySport.get(row.sportId);
    if (!sportAcc) {
      sportAcc = { scopes: new Map(), all: new Map() };
      bySport.set(row.sportId, sportAcc);
    }
    let acc = sportAcc.scopes.get(derived.scope.id);
    if (!acc) {
      acc = {
        // Built-in tabs keep a null label so the UI can localise them; a
        // sub-event tab's title is the feed's own words.
        label:
          derived.scope.id === MATCH_SCOPE || isMapScope(derived.scope.id)
            ? null
            : derived.scope.label,
        order: derived.scope.order,
        markets: new Map(),
      };
      sportAcc.scopes.set(derived.scope.id, acc);
    }
    if (!acc.markets.has(row.providerMarketId)) {
      acc.markets.set(row.providerMarketId, label);
    }
    if (!sportAcc.all.has(row.providerMarketId)) {
      sportAcc.all.set(row.providerMarketId, label);
    }
  }

  const out = new Map<number, SportScopes>();
  for (const [sid, sportAcc] of bySport) {
    applyMapTabs(sportAcc.scopes);

    // Every sport keeps a Match tab even when the whole current offer is
    // sub-events — it is the tab the storefront falls back to.
    if (!sportAcc.scopes.has(MATCH_SCOPE)) {
      sportAcc.scopes.set(MATCH_SCOPE, { label: null, order: 0, markets: new Map() });
    }

    const scopes = Array.from(sportAcc.scopes.entries())
      .map(([scope, acc]) => ({
        scope,
        label: acc.label,
        order: acc.order,
        markets: toMarketList(acc.markets),
      }))
      .sort((a, b) => a.order - b.order || a.scope.localeCompare(b.scope));

    out.set(sid, { scopes, allMarkets: toMarketList(sportAcc.all) });
  }
  return out;
}

// Map tabs share one market pool, and a sport that plays maps gets at
// least MIN_MAP_TABS of them. Which kinds happen to be quoted on map 4
// right now is an accident of what is live rather than a real difference —
// the same kinds come back when a series reaches that map — and an
// operator ordering the Map 4 tab needs the list either way.
function applyMapTabs(scopes: Map<string, ScopeAcc>) {
  const pool = new Map<number, string>();
  for (const [scope, acc] of scopes) {
    if (!isMapScope(scope)) continue;
    for (const [id, label] of acc.markets) pool.set(id, label);
  }
  if (pool.size === 0) return;

  for (let n = 1; n <= MIN_MAP_TABS; n++) {
    const scope = `map_${n}`;
    if (!scopes.has(scope)) {
      scopes.set(scope, { label: null, order: n, markets: new Map() });
    }
  }
  for (const [scope, acc] of scopes) {
    if (isMapScope(scope)) acc.markets = new Map(pool);
  }
}

function toMarketList(m: Map<number, string>): ScopeMarket[] {
  return Array.from(m.entries())
    .map(([providerMarketId, label]) => ({ providerMarketId, label }))
    .sort((a, b) => a.providerMarketId - b.providerMarketId);
}
