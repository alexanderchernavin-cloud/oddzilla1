// ZillaBuild engine — assembles up to (cards_per_map × map_count)
// pre-built BetBuilder cards for a PREMATCH match. Each card is a random
// 2-4 leg single-map OBB combo. A card's leg set is chosen ONCE and
// persisted in zillabuild_cards (kept while its legs stay valid); the
// combined + per-leg odds are re-quoted from Oddin OBB on every read and
// never stored, so a card never serves stale prices.
//
// The two OBB primitives this leans on (services/api/src/lib/obb-client.ts):
//   * availableMarkets(eventUrn) → OBB-eligible markets (each carries a
//     map=N specifier), reverse-mapped to internal market ids.
//   * sessionCreate(selectionIds) → validates a candidate combo AND
//     returns its fresh combined odds (×10 000). Used for BOTH generation
//     (does this random combo price?) and re-pricing kept cards.
//
// Graceful-idle: when OBB is disabled (ODDIN_OBB_HOST unset) or down, the
// engine returns an empty payload and the storefront hides the section —
// same contract as the BetBuilder toggle.

import type { FastifyInstance } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  matches,
  markets,
  marketOutcomes,
  marketDescriptions,
  outcomeDescriptions,
  zillabuildConfig,
  zillabuildCards,
} from "@oddzilla/db";
import { canonical, parse as parseSpecifiers } from "@oddzilla/types/specifiers";
import {
  ZILLABUILD_DEFAULT_CONFIG,
  type ZillaBuildCard,
  type ZillaBuildConfigLive,
  type ZillaBuildLeg,
  type ZillaBuildResponse,
} from "@oddzilla/types/zillabuild";
import { getSharedObbClient, ObbError } from "../../lib/obb-client.js";
import { buildSelectionId } from "../betbuilder/selection-id.js";
import {
  deriveScope,
  renderOutcomeLabel,
  substituteTemplate,
} from "../../lib/market-naming.js";

const EMPTY: ZillaBuildResponse = { enabled: true, eligibleMarketIds: [], cards: [] };
const DISABLED: ZillaBuildResponse = { enabled: false, eligibleMarketIds: [], cards: [] };

// Bounded retry budget per slot when generating a fresh card. Most combos
// price on the first try; the cap stops a pathological match (many
// mutually-exclusive OBB markets) from fanning out unbounded SessionCreate
// calls.
const MAX_GEN_ATTEMPTS = 6;
// Gen lock TTL — long enough to cover the OBB round-trips for one match,
// short enough to self-heal if the holder dies mid-generation.
const GEN_LOCK_TTL_SECONDS = 15;

// ── Persisted leg shape (zillabuild_cards.legs jsonb) ─────────────────
export interface StoredLeg {
  marketId: string;
  outcomeId: string;
}

// ── Pure helpers (exported for unit tests) ────────────────────────────

/** Stable key for a leg set so two slots on the same map can't be identical. */
export function legSetKey(legs: ReadonlyArray<StoredLeg>): string {
  return [...legs]
    .map((l) => `${l.marketId}:${l.outcomeId}`)
    .sort()
    .join("|");
}

/** Inclusive random integer in [lo, hi]. */
export function randInt(lo: number, hi: number, rng: () => number = Math.random): number {
  if (hi <= lo) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Fisher-Yates copy; does not mutate the input. */
export function shuffled<T>(items: ReadonlyArray<T>, rng: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Pick a random candidate leg set from a single map's eligible markets:
 * a random count L in [minLegs, min(maxLegs, #markets)], L distinct
 * markets, one random active outcome each. Returns null when the map
 * can't satisfy minLegs (the "show-what's-buildable" path leaves the slot
 * empty). Dedup against already-used leg sets is the caller's job.
 */
export function pickCandidateLegs(
  marketsForMap: ReadonlyArray<EligibleMarket>,
  cfg: Pick<ZillaBuildConfigLive, "minLegs" | "maxLegs">,
  rng: () => number = Math.random,
): StoredLeg[] | null {
  const maxL = Math.min(cfg.maxLegs, marketsForMap.length);
  if (maxL < cfg.minLegs) return null;
  const count = randInt(cfg.minLegs, maxL, rng);
  const chosen = shuffled(marketsForMap, rng).slice(0, count);
  const legs: StoredLeg[] = [];
  for (const m of chosen) {
    if (m.outcomes.length === 0) return null;
    const oc = m.outcomes[Math.floor(rng() * m.outcomes.length)]!;
    legs.push({ marketId: m.id, outcomeId: oc.outcomeId });
  }
  return legs;
}

// ── Internal working types ────────────────────────────────────────────

export interface EligibleOutcome {
  outcomeId: string;
  /** Current published odds, display-formatted. */
  odds: string;
  /** Resolved display label (set during hydrateLabels). */
  label?: string;
}

export interface EligibleMarket {
  id: string;
  providerMarketId: number;
  specifiers: Record<string, string>;
  variant: string;
  mapNumber: number;
  marketLabel: string;
  outcomes: EligibleOutcome[];
}

interface CardDraft {
  id: string;
  mapNumber: number;
  slot: number;
  legs: StoredLeg[];
  combinedOddsX10000: number;
}

// ── Config load ───────────────────────────────────────────────────────

async function loadConfig(app: FastifyInstance): Promise<ZillaBuildConfigLive> {
  const [row] = await app.db.select().from(zillabuildConfig).limit(1);
  if (!row) return ZILLABUILD_DEFAULT_CONFIG;
  return {
    enabled: row.enabled,
    eligibleProviderMarketIds: row.eligibleProviderMarketIds ?? [],
    cardsPerMap: row.cardsPerMap,
    mapCount: row.mapCount,
    minLegs: row.minLegs,
    maxLegs: row.maxLegs,
    minCombinedOdds: Number(row.minCombinedOdds),
    cacheTtlSeconds: row.cacheTtlSeconds,
  };
}

// ── Odds formatting (mirror the catalog's ≥2dp / trim-to-4dp convention) ─
function fmtOdds(v: string | null): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "0.00";
  let s = n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  if (!s.includes(".")) return `${s}.00`;
  const [int, dec] = s.split(".");
  return dec!.length < 2 ? `${int}.${dec!.padEnd(2, "0")}` : s;
}

// ── Public entry: shared, user-agnostic, Redis-cached ─────────────────

/**
 * Build (or read from cache) the ZillaBuild card set for a prematch match.
 * User-agnostic — per-bettor visibility is applied by the route on top of
 * this shared payload. Returns `enabled:false` immediately (no cache) when
 * the feature is off so an admin disable takes effect at once.
 */
export async function getZillaBuildForMatch(
  app: FastifyInstance,
  matchId: bigint,
): Promise<ZillaBuildResponse> {
  const cfg = await loadConfig(app);
  if (!cfg.enabled) return DISABLED;

  const [match] = await app.db
    .select({
      id: matches.id,
      providerUrn: matches.providerUrn,
      status: matches.status,
      homeTeam: matches.homeTeam,
      awayTeam: matches.awayTeam,
    })
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1);
  // Prematch-only. A live/closed match (or one with no Oddin URN) shows
  // nothing — OBB for the supported sports is prematch-only anyway.
  if (!match || !match.providerUrn || match.status !== "not_started") return EMPTY;

  const key = `zillabuild:v1:${matchId.toString()}`;
  const cachedRaw = await app.redis.get(key).catch(() => null);
  if (cachedRaw !== null) {
    try {
      return JSON.parse(cachedRaw) as ZillaBuildResponse;
    } catch {
      // fall through to a cold build on a corrupt entry
    }
  }

  const built = await buildForMatch(app, {
    id: match.id,
    eventUrn: match.providerUrn,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    cfg,
  });
  await app.redis
    .set(key, JSON.stringify(built), "EX", cfg.cacheTtlSeconds)
    .catch(() => null);
  return built;
}

interface BuildArgs {
  id: bigint;
  eventUrn: string;
  homeTeam: string;
  awayTeam: string;
  cfg: ZillaBuildConfigLive;
}

async function buildForMatch(
  app: FastifyInstance,
  args: BuildArgs,
): Promise<ZillaBuildResponse> {
  const obb = getSharedObbClient();
  if (!obb) return EMPTY;

  // 1. OBB-eligible markets for this match.
  let rawMarkets: Array<{ marketId: number; specifiers: string }>;
  try {
    const res = await obb.availableMarkets(args.eventUrn);
    rawMarkets = res.markets;
  } catch (err) {
    if (err instanceof ObbError) {
      app.log.warn(
        { component: "zillabuild", matchId: args.id.toString(), err: err.message },
        "obb availableMarkets failed — serving empty ZillaBuild",
      );
      return EMPTY;
    }
    throw err;
  }
  if (rawMarkets.length === 0) return EMPTY;

  // 2. Reverse-map (provider_market_id, canonical specifiers) → internal id.
  const providerIds = Array.from(new Set(rawMarkets.map((m) => m.marketId)));
  const internalRows = await app.db
    .select({
      id: markets.id,
      providerMarketId: markets.providerMarketId,
      specifiersJson: markets.specifiersJson,
      status: markets.status,
    })
    .from(markets)
    .where(and(eq(markets.matchId, args.id), inArray(markets.providerMarketId, providerIds)));

  const internalByKey = new Map<
    string,
    { id: string; providerMarketId: number; specifiers: Record<string, string>; status: number }
  >();
  for (const r of internalRows) {
    const specs = (r.specifiersJson ?? {}) as Record<string, string>;
    internalByKey.set(`${r.providerMarketId}|${canonical(specs)}`, {
      id: r.id.toString(),
      providerMarketId: r.providerMarketId,
      specifiers: specs,
      status: r.status,
    });
  }

  // Every OBB-eligible internal market id (status=1) — drives the slip's
  // BetBuilder eligibility list when a card is loaded.
  const eligibleMarketIds: string[] = [];
  // Map-scoped, allowlisted, status=1 markets grouped by map number.
  const allow = new Set(args.cfg.eligibleProviderMarketIds);
  const byMap = new Map<number, EligibleMarket[]>();
  const seenInternal = new Set<string>();

  for (const raw of rawMarkets) {
    const specs = parseSpecifiers(raw.specifiers);
    const hit = internalByKey.get(`${raw.marketId}|${canonical(specs)}`);
    if (!hit || hit.status !== 1) continue;
    if (seenInternal.has(hit.id)) continue;
    seenInternal.add(hit.id);
    eligibleMarketIds.push(hit.id);

    if (allow.size > 0 && !allow.has(hit.providerMarketId)) continue;
    const scope = deriveScope(hit.specifiers);
    const mapNo = scope.id.startsWith("map_") ? scope.order : 0;
    if (mapNo < 1 || mapNo > args.cfg.mapCount) continue;

    const list = byMap.get(mapNo) ?? [];
    list.push({
      id: hit.id,
      providerMarketId: hit.providerMarketId,
      specifiers: hit.specifiers,
      variant: String(hit.specifiers.variant ?? ""),
      mapNumber: mapNo,
      marketLabel: "",
      outcomes: [],
    });
    byMap.set(mapNo, list);
  }

  if (byMap.size === 0) {
    return { enabled: true, eligibleMarketIds, cards: [] };
  }

  // 3. Active outcomes (with a published price) for the eligible markets.
  const eligibleIds = [...byMap.values()].flat().map((m) => BigInt(m.id));
  const ocRows = await app.db
    .select({
      marketId: marketOutcomes.marketId,
      outcomeId: marketOutcomes.outcomeId,
      publishedOdds: marketOutcomes.publishedOdds,
    })
    .from(marketOutcomes)
    .where(
      and(
        inArray(marketOutcomes.marketId, eligibleIds),
        eq(marketOutcomes.active, true),
        sql`${marketOutcomes.publishedOdds} IS NOT NULL`,
      ),
    );
  const outcomesByMarket = new Map<string, EligibleOutcome[]>();
  for (const o of ocRows) {
    const mid = o.marketId.toString();
    const list = outcomesByMarket.get(mid) ?? [];
    list.push({ outcomeId: o.outcomeId, odds: fmtOdds(o.publishedOdds) });
    outcomesByMarket.set(mid, list);
  }

  // 4. Labels. One pair of description lookups keyed by (pmi, variant) +
  //    (pmi, variant, outcomeId) in English. profiles are skipped — the
  //    curated per-map market set (winners / totals / handicaps) uses
  //    positional / over-under outcome ids, not player/competitor URNs.
  await hydrateLabels(app, byMap, outcomesByMarket, args.homeTeam, args.awayTeam);

  // Attach each market's priced outcomes, then drop markets with none and
  // maps left empty (the "show-what's-buildable" path — a sparse map just
  // yields fewer cards).
  for (const [mapNo, list] of byMap) {
    const usable: EligibleMarket[] = [];
    for (const m of list) {
      m.outcomes = outcomesByMarket.get(m.id) ?? [];
      if (m.outcomes.length > 0) usable.push(m);
    }
    if (usable.length === 0) byMap.delete(mapNo);
    else byMap.set(mapNo, usable);
  }
  if (byMap.size === 0) {
    return { enabled: true, eligibleMarketIds, cards: [] };
  }

  // 5. Persisted cards for this match.
  const persistedRows = await app.db
    .select({
      id: zillabuildCards.id,
      mapNumber: zillabuildCards.mapNumber,
      slot: zillabuildCards.slot,
      legs: zillabuildCards.legs,
    })
    .from(zillabuildCards)
    .where(eq(zillabuildCards.matchId, args.id));
  const persistedBySlot = new Map<string, { id: string; legs: StoredLeg[] }>();
  for (const r of persistedRows) {
    persistedBySlot.set(`${r.mapNumber}:${r.slot}`, {
      id: r.id.toString(),
      legs: (r.legs as StoredLeg[]) ?? [],
    });
  }

  // 6. Gen lock — only the holder generates new compositions; others
  //    serve whatever's persisted + re-quotes it (so we never double-gen).
  const lockKey = `zillabuild:gen:${args.id.toString()}`;
  const canGenerate =
    (await app.redis
      .set(lockKey, "1", "EX", GEN_LOCK_TTL_SECONDS, "NX")
      .catch(() => null)) === "OK";

  try {
    // 7. Resolve each map's slots. Maps run concurrently; slots WITHIN a
    //    map run sequentially so the per-map used-leg-set dedup is race-free.
    const mapNumbers = [...byMap.keys()].sort((a, b) => a - b);
    const perMap = await Promise.all(
      mapNumbers.map((mapNo) =>
        resolveMapSlots(app, obb, {
          mapNo,
          marketsForMap: byMap.get(mapNo)!,
          persistedBySlot,
          canGenerate,
          args,
        }),
      ),
    );

    const drafts = perMap.flat();
    const cards = draftsToCards(drafts, byMap, outcomesByMarket);
    return { enabled: true, eligibleMarketIds, cards };
  } finally {
    if (canGenerate) await app.redis.del(lockKey).catch(() => null);
  }
}

interface ResolveMapArgs {
  mapNo: number;
  marketsForMap: EligibleMarket[];
  persistedBySlot: Map<string, { id: string; legs: StoredLeg[] }>;
  canGenerate: boolean;
  args: BuildArgs;
}

async function resolveMapSlots(
  app: FastifyInstance,
  obb: NonNullable<ReturnType<typeof getSharedObbClient>>,
  ctx: ResolveMapArgs,
): Promise<CardDraft[]> {
  const { mapNo, marketsForMap, persistedBySlot, canGenerate, args } = ctx;
  const byId = new Map(marketsForMap.map((m) => [m.id, m]));
  const usedLegSets = new Set<string>();
  const drafts: CardDraft[] = [];

  const selectionIdsFor = (legs: StoredLeg[]): string[] | null => {
    const ids: string[] = [];
    for (const leg of legs) {
      const m = byId.get(leg.marketId);
      if (!m) return null;
      ids.push(buildSelectionId(args.eventUrn, m.providerMarketId, leg.outcomeId, m.specifiers));
    }
    return ids;
  };

  // A kept card's legs must all still be eligible markets on this map with
  // their chosen outcome still priced/active.
  const legsStillValid = (legs: StoredLeg[]): boolean =>
    legs.length > 0 &&
    legs.every((leg) => {
      const m = byId.get(leg.marketId);
      return !!m && m.outcomes.some((o) => o.outcomeId === leg.outcomeId);
    });

  for (let slot = 0; slot < args.cfg.cardsPerMap; slot++) {
    const existing = persistedBySlot.get(`${mapNo}:${slot}`);

    // Keep path: re-quote the persisted composition for fresh odds.
    if (existing && legsStillValid(existing.legs)) {
      const ids = selectionIdsFor(existing.legs);
      const oddsX = ids ? await quoteOdds(app, obb, ids) : null;
      if (oddsX !== null) {
        usedLegSets.add(legSetKey(existing.legs));
        drafts.push({ id: existing.id, mapNumber: mapNo, slot, legs: existing.legs, combinedOddsX10000: oddsX });
        continue;
      }
      // OBB no longer prices it → fall through to regenerate (if allowed).
    }

    if (!canGenerate) continue;

    // Generate path: random combos until one prices above the floor.
    let made: CardDraft | null = null;
    for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
      const legs = pickCandidateLegs(marketsForMap, args.cfg);
      if (!legs) break; // map can't satisfy minLegs — leave slot empty
      const key = legSetKey(legs);
      if (usedLegSets.has(key)) continue;
      const ids = selectionIdsFor(legs);
      if (!ids) continue;
      const oddsX = await quoteOdds(app, obb, ids);
      if (oddsX === null) continue;
      if (oddsX / 10_000 < args.cfg.minCombinedOdds) continue;
      const id = await upsertCard(app, args.id, mapNo, slot, legs);
      usedLegSets.add(key);
      made = { id, mapNumber: mapNo, slot, legs, combinedOddsX10000: oddsX };
      break;
    }
    if (made) drafts.push(made);
  }

  return drafts;
}

/**
 * SessionCreate a leg set; return combined odds ×10 000 when Oddin prices
 * it, or null on rejection / transient OBB error (caller treats null as
 * "this combo isn't available right now").
 */
async function quoteOdds(
  app: FastifyInstance,
  obb: NonNullable<ReturnType<typeof getSharedObbClient>>,
  selectionIds: string[],
): Promise<number | null> {
  try {
    const res = await obb.sessionCreate(selectionIds);
    if (res.status !== "created" || !res.created) return null;
    const x = Number(res.created.odds);
    return Number.isFinite(x) && x > 0 ? x : null;
  } catch (err) {
    if (err instanceof ObbError) {
      app.log.warn(
        { component: "zillabuild", err: err.message },
        "obb sessionCreate failed during ZillaBuild assembly",
      );
      return null;
    }
    throw err;
  }
}

async function upsertCard(
  app: FastifyInstance,
  matchId: bigint,
  mapNumber: number,
  slot: number,
  legs: StoredLeg[],
): Promise<string> {
  const [row] = await app.db
    .insert(zillabuildCards)
    .values({ matchId, mapNumber, slot, legs })
    .onConflictDoUpdate({
      target: [zillabuildCards.matchId, zillabuildCards.mapNumber, zillabuildCards.slot],
      set: { legs, updatedAt: new Date() },
    })
    .returning({ id: zillabuildCards.id });
  return row!.id.toString();
}

// Turn drafts into wire cards: resolve per-leg labels + odds from the
// hydrated market map, format the combined odds, sort by (map, slot).
function draftsToCards(
  drafts: CardDraft[],
  byMap: Map<number, EligibleMarket[]>,
  outcomesByMarket: Map<string, EligibleOutcome[]>,
): ZillaBuildCard[] {
  const marketById = new Map<string, EligibleMarket>();
  for (const list of byMap.values()) for (const m of list) marketById.set(m.id, m);

  const cards: ZillaBuildCard[] = [];
  for (const d of drafts) {
    const legs: ZillaBuildLeg[] = [];
    let ok = true;
    for (const leg of d.legs) {
      const m = marketById.get(leg.marketId);
      const oc = m
        ? (outcomesByMarket.get(leg.marketId) ?? []).find((o) => o.outcomeId === leg.outcomeId)
        : undefined;
      if (!m || !oc) {
        ok = false;
        break;
      }
      legs.push({
        marketId: leg.marketId,
        outcomeId: leg.outcomeId,
        marketLabel: m.marketLabel,
        outcomeLabel: oc.label ?? leg.outcomeId,
        odds: oc.odds,
      });
    }
    if (!ok) continue;
    cards.push({
      id: d.id,
      mapNumber: d.mapNumber,
      slot: d.slot,
      legs,
      combinedOdds: (d.combinedOddsX10000 / 10_000).toFixed(2),
      combinedOddsX10000: d.combinedOddsX10000,
    });
  }
  cards.sort((a, b) => a.mapNumber - b.mapNumber || a.slot - b.slot);
  return cards;
}

// ── Label hydration ───────────────────────────────────────────────────
// Fills EligibleMarket.marketLabel and EligibleOutcome.label for every
// market/outcome in the map groups, using market_descriptions /
// outcome_descriptions (English) + the catalog's naming helpers.

async function hydrateLabels(
  app: FastifyInstance,
  byMap: Map<number, EligibleMarket[]>,
  outcomesByMarket: Map<string, EligibleOutcome[]>,
  homeTeam: string,
  awayTeam: string,
): Promise<void> {
  const allMarkets = [...byMap.values()].flat();
  const pmis = Array.from(new Set(allMarkets.map((m) => m.providerMarketId)));
  if (pmis.length === 0) return;

  const [mDescs, oDescs] = await Promise.all([
    app.db
      .select({
        providerMarketId: marketDescriptions.providerMarketId,
        variant: marketDescriptions.variant,
        nameTemplate: marketDescriptions.nameTemplate,
      })
      .from(marketDescriptions)
      .where(
        and(
          inArray(marketDescriptions.providerMarketId, pmis),
          eq(marketDescriptions.language, "en"),
        ),
      ),
    app.db
      .select({
        providerMarketId: outcomeDescriptions.providerMarketId,
        variant: outcomeDescriptions.variant,
        outcomeId: outcomeDescriptions.outcomeId,
        nameTemplate: outcomeDescriptions.nameTemplate,
      })
      .from(outcomeDescriptions)
      .where(
        and(
          inArray(outcomeDescriptions.providerMarketId, pmis),
          eq(outcomeDescriptions.language, "en"),
        ),
      ),
  ]);

  const mTemplate = new Map<string, string>();
  for (const d of mDescs) mTemplate.set(`${d.providerMarketId}:${d.variant}`, d.nameTemplate);
  const oTemplate = new Map<string, string>();
  for (const d of oDescs)
    oTemplate.set(`${d.providerMarketId}:${d.variant}:${d.outcomeId}`, d.nameTemplate);

  for (const m of allMarkets) {
    const tmpl = mTemplate.get(`${m.providerMarketId}:${m.variant}`);
    m.marketLabel = tmpl
      ? substituteTemplate(tmpl, m.specifiers, { homeTeam, awayTeam }, undefined, "en")
      : `Market #${m.providerMarketId}`;
    const outcomes = outcomesByMarket.get(m.id) ?? [];
    for (const oc of outcomes) {
      const otmpl = oTemplate.get(`${m.providerMarketId}:${m.variant}:${oc.outcomeId}`) ?? oc.outcomeId;
      oc.label = renderOutcomeLabel(otmpl, m.specifiers, homeTeam, awayTeam, undefined, "en");
    }
  }
}
