// ZillaFlash engine — keeps 4 boosted-odds offers warm at all times:
// 2 prematch (60 s TTL) + 2 live (15 s TTL). Each offer points at a
// random Tier 1-3 match × one of its sport's curated "top" markets
// (fe_market_display_order scope='top'). Boost is a Netwinstable
// −3pp key adjustment on the entire market, applied at read time so
// the displayed boost tracks live odds movement.
//
// State lives in-process. The api container is single-instance (see
// docker-compose.yml — only web has replicas), so an in-memory Map is
// safe and lets us avoid serialising offer objects to/from Redis on
// every read. On api restart the slots seed fresh; an in-flight bet
// quoting a now-unknown offer id 400s with `zillaflash_unknown_offer`
// and the storefront re-fetches.
//
// Rotation tick: a single 1 s timer sweeps expired slots and fills
// them from the pool. Pool is refreshed every 30 s — enough churn for
// "random" to feel different across consecutive offers but cheap
// enough to run on a small box. When the pool is dry the slot stays
// empty and the response goes out with fewer than 4 offers (storefront
// renders what it has).

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  categories,
  feMarketDisplayOrder,
  marketDescriptions,
  marketOutcomes,
  markets,
  matches,
  outcomeDescriptions,
  sports,
  tournaments,
} from "@oddzilla/db";
import {
  ZILLAFLASH_KEY_DELTA_PCT,
  ZILLAFLASH_SLOTS_PER_KIND,
  ZILLAFLASH_TTL_MS,
  type ZillaFlashKind,
  type ZillaFlashOffer,
  type ZillaFlashResponse,
  boostMarketKey,
} from "@oddzilla/types";
import {
  renderOutcomeLabel,
  substituteTemplate,
} from "../../lib/market-naming.js";

const POOL_REFRESH_MS = 30_000;
const ROTATION_TICK_MS = 1_000;
// Defensive guard. `substituteTemplate` leaves the literal `{key}`
// string when a specifier the template referenced isn't present on
// the market row; if anything slips through, hydrateOffer drops the
// offer rather than ship the raw placeholder to the slip.
const PLACEHOLDER_RE = /\{[a-z0-9_]+\}/i;
// Tolerance for "did the user click on the same offer we have now"
// at bet placement. Boosted odds drift sub-cent every second as the
// underlying ticks; the slip's display is ≤2 decimals so 0.01 is
// generous. Reject anything outside this band.
export const ZILLAFLASH_PLACEMENT_TOLERANCE = 0.01;

// In-flight offer state.
interface SlotState {
  offerId: string;
  kind: ZillaFlashKind;
  matchId: bigint;
  marketId: bigint;
  outcomeId: string;
  startedAt: Date;
  expiresAt: Date;
}

interface PoolCandidate {
  matchId: bigint;
  marketId: bigint;
  providerMarketId: number;
  sportId: number;
  status: "not_started" | "live";
}

// Module-scoped — there's one api process, so one engine instance.
const slots: Record<ZillaFlashKind, Array<SlotState | null>> = {
  prematch: Array(ZILLAFLASH_SLOTS_PER_KIND).fill(null),
  live: Array(ZILLAFLASH_SLOTS_PER_KIND).fill(null),
};

const offerById: Map<string, SlotState> = new Map();

let poolByKind: Record<ZillaFlashKind, PoolCandidate[]> = {
  prematch: [],
  live: [],
};
let poolFetchedAt = 0;
let rotationTimer: NodeJS.Timeout | null = null;
let appRef: FastifyInstance | null = null;

function pickRandom<T>(arr: readonly T[]): T | null {
  if (arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)]!;
}

async function refreshPool(app: FastifyInstance): Promise<void> {
  // Pool = every (match, top-market) pair for active Tier 1-3 fixtures
  // whose match-status is `not_started` (→ prematch slots) or `live` (→
  // live slots). The top-markets allowlist is the per-sport curated
  // list in fe_market_display_order(scope='top') — if a sport has no
  // top list configured, none of its matches show up here.
  const rows = await app.db
    .select({
      matchId: matches.id,
      marketId: markets.id,
      providerMarketId: markets.providerMarketId,
      sportId: sports.id,
      status: matches.status,
    })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .innerJoin(categories, eq(categories.id, tournaments.categoryId))
    .innerJoin(sports, eq(sports.id, categories.sportId))
    .innerJoin(markets, eq(markets.matchId, matches.id))
    .innerJoin(
      feMarketDisplayOrder,
      and(
        eq(feMarketDisplayOrder.sportId, sports.id),
        eq(feMarketDisplayOrder.scope, "top"),
        eq(feMarketDisplayOrder.providerMarketId, markets.providerMarketId),
      ),
    )
    .where(
      and(
        gte(tournaments.riskTier, 1),
        // riskTier <= 3 expressed via raw sql because drizzle's lte
        // chain with gte is fine but explicit BETWEEN reads cleaner.
        sql`${tournaments.riskTier} <= 3`,
        eq(sports.active, true),
        inArray(matches.status, ["not_started", "live"]),
        eq(markets.status, 1),
      ),
    )
    .limit(500);

  const next: Record<ZillaFlashKind, PoolCandidate[]> = {
    prematch: [],
    live: [],
  };
  for (const r of rows) {
    const candidate: PoolCandidate = {
      matchId: r.matchId,
      marketId: r.marketId,
      providerMarketId: r.providerMarketId,
      sportId: r.sportId,
      status: r.status as "not_started" | "live",
    };
    if (r.status === "live") next.live.push(candidate);
    else if (r.status === "not_started") next.prematch.push(candidate);
  }
  poolByKind = next;
  poolFetchedAt = Date.now();
}

function offerIsHydratable(slot: SlotState): boolean {
  return slot.expiresAt.getTime() > Date.now();
}

async function pickReplacement(
  app: FastifyInstance,
  kind: ZillaFlashKind,
): Promise<SlotState | null> {
  const pool = poolByKind[kind];
  if (pool.length === 0) return null;

  // Avoid putting the same match in two slots of the same kind at once.
  // The other slot's match-id is already taken; bias the random pick to
  // skip it.
  const usedMatchIds = new Set<string>();
  for (const s of slots[kind]) {
    if (s) usedMatchIds.add(s.matchId.toString());
  }
  const available = pool.filter((c) => !usedMatchIds.has(c.matchId.toString()));
  const candidate = pickRandom(available.length > 0 ? available : pool);
  if (!candidate) return null;

  // Confirm at least 2 active outcomes with usable odds exist on this
  // market right now — otherwise the offer would render empty.
  const outcomes = await loadMarketOutcomes(app, candidate.marketId);
  if (outcomes.filter((o) => o.publishedOdds > 1).length < 2) return null;

  const now = new Date();
  const ttl = ZILLAFLASH_TTL_MS[kind];
  // Boost the highest-edge outcome (lowest odds wins → biggest absolute
  // boost). Skews offers toward favorites which is what makes a flash
  // boost feel "real" — boosting a 6.0 longshot to 6.4 is invisible
  // but a 1.50 favorite jumping to 1.56 reads.
  const ranked = [...outcomes]
    .filter((o) => o.publishedOdds > 1)
    .sort((a, b) => a.publishedOdds - b.publishedOdds);
  const chosenOutcome = ranked[0]!;

  return {
    offerId: randomUUID(),
    kind,
    matchId: candidate.matchId,
    marketId: candidate.marketId,
    outcomeId: chosenOutcome.outcomeId,
    startedAt: now,
    expiresAt: new Date(now.getTime() + ttl),
  };
}

// Raw outcome row, name unresolved. Used at pick time (where we only
// need active + price) and at hydration time (where the caller threads
// the resolved label through renderOutcomeLabel below).
interface MarketOutcomeRow {
  outcomeId: string;
  rawName: string;
  publishedOdds: number;
}

interface MatchMeta {
  homeTeam: string;
  awayTeam: string;
  sportSlug: string;
  sportName: string;
  providerMarketId: number;
  /** Specifier-substituted market name, ready to render (e.g. "Round 5 winner - map 1"). */
  marketLabel: string;
  /** Raw specifiers jsonb for downstream outcome-label rendering. */
  specifiers: Record<string, string>;
  /** Variant (the specifier called `variant`, if any) — feeds the outcome_descriptions lookup. */
  variant: string;
}

async function loadMarketOutcomes(
  app: FastifyInstance,
  marketId: bigint,
): Promise<MarketOutcomeRow[]> {
  const rows = await app.db
    .select({
      outcomeId: marketOutcomes.outcomeId,
      name: marketOutcomes.name,
      publishedOdds: marketOutcomes.publishedOdds,
      active: marketOutcomes.active,
    })
    .from(marketOutcomes)
    .where(eq(marketOutcomes.marketId, marketId));
  return rows
    .filter((r) => r.active && r.publishedOdds !== null)
    .map((r) => ({
      outcomeId: r.outcomeId,
      rawName: r.name,
      publishedOdds: Number(r.publishedOdds),
    }));
}

// Combined match + market lookup. Returns the resolved market label
// (specifier-substituted), the specifiers needed for outcome
// rendering, and the team names used as a fallback for positional
// 1/2 outcomes. Locale is pinned to 'en' since ZillaFlash offers
// don't differentiate today.
async function loadMatchMeta(
  app: FastifyInstance,
  matchId: bigint,
  marketId: bigint,
): Promise<MatchMeta | null> {
  const [row] = await app.db
    .select({
      homeTeam: matches.homeTeam,
      awayTeam: matches.awayTeam,
      sportSlug: sports.slug,
      sportName: sports.name,
      providerMarketId: markets.providerMarketId,
      specifiersJson: markets.specifiersJson,
    })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .innerJoin(categories, eq(categories.id, tournaments.categoryId))
    .innerJoin(sports, eq(sports.id, categories.sportId))
    .innerJoin(markets, eq(markets.id, marketId))
    .where(eq(matches.id, matchId))
    .limit(1);
  if (!row) return null;

  const specifiers = (row.specifiersJson ?? {}) as Record<string, string>;
  const variant = typeof specifiers.variant === "string" ? specifiers.variant : "";

  // Prefer the variant-specific description row, fall back to the
  // empty-variant base — same precedence /catalog/matches/:id uses.
  const descRows = await app.db
    .select({
      variant: marketDescriptions.variant,
      nameTemplate: marketDescriptions.nameTemplate,
    })
    .from(marketDescriptions)
    .where(
      and(
        eq(marketDescriptions.providerMarketId, row.providerMarketId),
        eq(marketDescriptions.language, "en"),
      ),
    );
  const template =
    descRows.find((d) => d.variant === variant)?.nameTemplate ??
    descRows.find((d) => d.variant === "")?.nameTemplate ??
    `Market #${row.providerMarketId}`;

  const teams = { homeTeam: row.homeTeam, awayTeam: row.awayTeam };
  const marketLabel = substituteTemplate(template, specifiers, teams, undefined, "en");

  return {
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    sportSlug: row.sportSlug,
    sportName: row.sportName,
    providerMarketId: row.providerMarketId,
    marketLabel,
    specifiers,
    variant,
  };
}

async function loadOutcomeDescriptions(
  app: FastifyInstance,
  meta: MatchMeta,
): Promise<Map<string, string>> {
  const rows = await app.db
    .select({
      variant: outcomeDescriptions.variant,
      outcomeId: outcomeDescriptions.outcomeId,
      nameTemplate: outcomeDescriptions.nameTemplate,
    })
    .from(outcomeDescriptions)
    .where(
      and(
        eq(outcomeDescriptions.providerMarketId, meta.providerMarketId),
        eq(outcomeDescriptions.language, "en"),
      ),
    );
  // (variant, outcomeId) precedence: prefer the variant-specific row,
  // fall back to the empty-variant base. Mirrors catalog resolution.
  const map = new Map<string, string>();
  for (const d of rows) {
    if (d.variant === meta.variant) map.set(d.outcomeId, d.nameTemplate);
  }
  for (const d of rows) {
    if (d.variant === "" && !map.has(d.outcomeId)) {
      map.set(d.outcomeId, d.nameTemplate);
    }
  }
  return map;
}

function resolveOutcomeLabel(
  meta: MatchMeta,
  outcomeId: string,
  rawName: string,
  template: string | null,
): string {
  // Resolution order, matching the storefront catalog:
  //   1. market_outcomes.name (Oddin's pre-resolved label, when present)
  //   2. outcome_descriptions.name_template, specifier-substituted via
  //      renderOutcomeLabel (handles "home"/"away" → team name,
  //      "draw" → "Draw", URN profile lookups, etc.)
  //   3. Positional fallback for outcome ids "1"/"2"/"3" so Round /
  //      Map-Winner outcomes don't ship with the raw id.
  if (rawName && rawName.length > 0) return rawName;
  if (template) {
    const rendered = renderOutcomeLabel(
      template,
      meta.specifiers,
      meta.homeTeam,
      meta.awayTeam,
      undefined,
      "en",
    );
    if (rendered.length > 0) return rendered;
  }
  if (outcomeId === "1") return meta.homeTeam;
  if (outcomeId === "2") return meta.awayTeam;
  if (outcomeId === "3") return "Draw";
  return outcomeId;
}

function fmtOdds(n: number): string {
  // Floor to 2 decimals to match the rest of the site's quoting.
  if (!Number.isFinite(n)) return "0.00";
  return (Math.floor(n * 100) / 100).toFixed(2);
}

async function hydrateOffer(
  app: FastifyInstance,
  slot: SlotState,
): Promise<ZillaFlashOffer | null> {
  const [meta, outcomes] = await Promise.all([
    loadMatchMeta(app, slot.matchId, slot.marketId),
    loadMarketOutcomes(app, slot.marketId),
  ]);
  if (!meta) return null;
  // Re-check the bound outcome is still active with valid odds.
  const boostedOutcome = outcomes.find((o) => o.outcomeId === slot.outcomeId);
  if (!boostedOutcome || !(boostedOutcome.publishedOdds > 1)) return null;

  // Apply Netwinstable −3pp on the full active outcome set so ratios
  // stay consistent across the board (we surface the snapshot too, so
  // a curious user can see every outcome's adjusted price).
  const oddsArray = outcomes.map((o) => o.publishedOdds);
  const adjusted = boostMarketKey(oddsArray, ZILLAFLASH_KEY_DELTA_PCT);

  const boostedIdx = outcomes.findIndex((o) => o.outcomeId === slot.outcomeId);
  if (boostedIdx < 0) return null;

  const originalOddsStr = fmtOdds(outcomes[boostedIdx]!.publishedOdds);
  const boostedOddsNum = adjusted.adjustedOdds[boostedIdx]!;
  const boostedOddsStr = fmtOdds(boostedOddsNum);

  // If the adjustment was a no-op (book already at/below fair, see
  // boostMarketKey's clamp), drop the offer rather than render a
  // crossed-out "1.95 → 1.95".
  if (boostedOddsStr === originalOddsStr) return null;

  // Resolve every outcome's display label through the same precedence
  // the storefront uses: raw name → outcome_descriptions template
  // substituted with this market's specifiers → positional fallback.
  const outcomeTemplates = await loadOutcomeDescriptions(app, meta);
  const labels = outcomes.map((o) =>
    resolveOutcomeLabel(meta, o.outcomeId, o.rawName, outcomeTemplates.get(o.outcomeId) ?? null),
  );

  // Refuse to emit an offer whose label substitution didn't fully
  // resolve. A `{key}` left in the market name or selection means a
  // specifier the template referenced wasn't present on this market
  // row — Oddin sometimes ships variant-encoded markets where the
  // expected key is missing. Better to skip this slot (rotation will
  // refill on the next tick) than to surface a literal "{map}" /
  // "{way}" string to the bet slip.
  if (
    PLACEHOLDER_RE.test(meta.marketLabel) ||
    labels.some((l) => PLACEHOLDER_RE.test(l))
  ) {
    app.log.warn(
      {
        marketId: slot.marketId.toString(),
        providerMarketId: meta.providerMarketId,
        marketLabel: meta.marketLabel,
      },
      "zillaflash.template_unresolved — dropping offer",
    );
    return null;
  }

  const now = new Date();

  return {
    id: slot.offerId,
    kind: slot.kind,
    matchId: slot.matchId.toString(),
    homeTeam: meta.homeTeam,
    awayTeam: meta.awayTeam,
    sportSlug: meta.sportSlug,
    sportName: meta.sportName,
    marketId: slot.marketId.toString(),
    providerMarketId: meta.providerMarketId,
    marketLabel: meta.marketLabel,
    outcomeId: slot.outcomeId,
    outcomeLabel: labels[boostedIdx]!,
    originalOdds: originalOddsStr,
    boostedOdds: boostedOddsStr,
    marketSnapshot: outcomes.map((o, i) => ({
      outcomeId: o.outcomeId,
      outcomeLabel: labels[i]!,
      originalOdds: fmtOdds(o.publishedOdds),
      boostedOdds: fmtOdds(adjusted.adjustedOdds[i]!),
    })),
    startedAt: slot.startedAt.toISOString(),
    expiresAt: slot.expiresAt.toISOString(),
    serverNow: now.toISOString(),
  };
}

async function rotate(app: FastifyInstance): Promise<void> {
  // Refresh the candidate pool periodically so newly-live matches
  // become eligible without restarting the api.
  if (Date.now() - poolFetchedAt > POOL_REFRESH_MS) {
    try {
      await refreshPool(app);
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, "zillaflash.pool_refresh_failed");
    }
  }
  for (const kind of ["prematch", "live"] as ZillaFlashKind[]) {
    const arr = slots[kind];
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (s && offerIsHydratable(s)) continue;
      if (s) offerById.delete(s.offerId);
      try {
        const next = await pickReplacement(app, kind);
        if (next) {
          arr[i] = next;
          offerById.set(next.offerId, next);
        } else {
          arr[i] = null;
        }
      } catch (err) {
        app.log.warn(
          { err: (err as Error).message, kind, slot: i },
          "zillaflash.rotate_failed",
        );
        arr[i] = null;
      }
    }
  }
}

export async function getActiveOffers(
  app: FastifyInstance,
): Promise<ZillaFlashResponse> {
  // Run a rotate pass synchronously so the first poll after boot has
  // populated slots. Subsequent polls amortise across the timer.
  if (poolFetchedAt === 0) {
    await refreshPool(app);
  }
  await rotate(app);

  const out: ZillaFlashResponse = {
    prematch: [],
    live: [],
    empty: true,
  };
  for (const kind of ["prematch", "live"] as ZillaFlashKind[]) {
    for (const s of slots[kind]) {
      if (!s) continue;
      const offer = await hydrateOffer(app, s);
      if (offer) {
        out[kind].push(offer);
        out.empty = false;
      } else {
        // Hydration failed — outcome went inactive or odds dropped to
        // 0. Drop the slot now so the next tick picks something fresh.
        offerById.delete(s.offerId);
        const arr = slots[kind];
        const idx = arr.indexOf(s);
        if (idx >= 0) arr[idx] = null;
      }
    }
  }
  return out;
}

// Bet-placement validation. The slip submits with offer id + the
// boostedOdds it last saw; we re-hydrate against the latest market
// state and confirm both the leg identity AND the price (within
// ZILLAFLASH_PLACEMENT_TOLERANCE) still match.
export interface ZillaFlashValidation {
  ok: boolean;
  reason?:
    | "zillaflash_unknown_offer"
    | "zillaflash_offer_expired"
    | "zillaflash_outcome_changed"
    | "zillaflash_odds_drift";
  /** The boosted odds the engine considers authoritative (string form). */
  authoritativeOdds?: string;
  /** Set when ok=true; the boosted odds expressed as a plain number. */
  authoritativeOddsNum?: number;
  /** The offer kind, for downstream bet-delay shaving on live legs. */
  kind?: ZillaFlashKind;
}

export async function validateOfferForBet(
  app: FastifyInstance,
  args: {
    offerId: string;
    marketId: string;
    outcomeId: string;
    quotedOdds: string;
  },
): Promise<ZillaFlashValidation> {
  const slot = offerById.get(args.offerId);
  if (!slot) return { ok: false, reason: "zillaflash_unknown_offer" };
  if (slot.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "zillaflash_offer_expired" };
  }
  if (
    slot.marketId.toString() !== args.marketId ||
    slot.outcomeId !== args.outcomeId
  ) {
    return { ok: false, reason: "zillaflash_outcome_changed" };
  }
  const offer = await hydrateOffer(app, slot);
  if (!offer) return { ok: false, reason: "zillaflash_outcome_changed" };
  const quoted = Number.parseFloat(args.quotedOdds);
  const auth = Number.parseFloat(offer.boostedOdds);
  if (!Number.isFinite(quoted) || !Number.isFinite(auth)) {
    return { ok: false, reason: "zillaflash_odds_drift" };
  }
  if (Math.abs(quoted - auth) > ZILLAFLASH_PLACEMENT_TOLERANCE) {
    return {
      ok: false,
      reason: "zillaflash_odds_drift",
      authoritativeOdds: offer.boostedOdds,
    };
  }
  return {
    ok: true,
    authoritativeOdds: offer.boostedOdds,
    authoritativeOddsNum: auth,
    kind: slot.kind,
  };
}

export function startZillaFlashRotation(app: FastifyInstance): () => void {
  if (appRef !== null) {
    app.log.warn("zillaflash.already_started — ignoring duplicate start");
    return () => undefined;
  }
  appRef = app;
  // Seed the pool eagerly so the first GET /catalog/zillaflash has data.
  void refreshPool(app).catch((err) => {
    app.log.warn(
      { err: (err as Error).message },
      "zillaflash.initial_pool_failed",
    );
  });
  rotationTimer = setInterval(() => {
    void rotate(app).catch((err) => {
      app.log.warn({ err: (err as Error).message }, "zillaflash.rotate_tick_failed");
    });
  }, ROTATION_TICK_MS);
  // Don't keep the event loop alive purely for rotation.
  rotationTimer.unref();
  return () => {
    if (rotationTimer) {
      clearInterval(rotationTimer);
      rotationTimer = null;
    }
    slots.prematch.fill(null);
    slots.live.fill(null);
    offerById.clear();
    appRef = null;
  };
}
