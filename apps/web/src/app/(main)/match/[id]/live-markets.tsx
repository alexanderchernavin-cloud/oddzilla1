"use client";

import { useEffect, useMemo, useState } from "react";
import { useLiveMarketStatus, useLiveOdds } from "@/lib/use-live-odds";
import { useBetSlip } from "@/lib/bet-slip";
import { useZillaTips } from "@/lib/use-zillatips";
import {
  formatRemaining,
  indexOffers,
  offersForMatch,
  useZillaFlash,
  type OutcomeBoostEntry,
} from "@/lib/use-zillaflash";
import type { ZillaFlashOffer } from "@oddzilla/types";
import { useTranslations } from "@/lib/i18n";
import type { ZillaTip } from "@oddzilla/types/zillatips";
import { OddButton } from "@/components/ui/primitives";
import { I } from "@/components/ui/icons";
import {
  BetBuilderTogglePill,
  useBetBuilderProbe,
} from "@/components/match/betbuilder-toggle";
import {
  ZillaTipsBadge,
  ZillaTipsProvider,
  type TipContext,
} from "@/components/match/zillatips-widget";
import { useMarketTabChangeTracker } from "@/lib/zillapass-track";

export interface MarketOutcome {
  outcomeId: string;
  name: string; // rendered by the API (home→homeTeam, "2:1", "Over", …)
  rawName: string;
  publishedOdds: string | null;
  // Implied probability from the Oddin feed; carried into the bet slip
  // so the rail can preview Tiple/Tippot pricing locally. Server still
  // re-reads this at placement.
  probability: string | null;
  active: boolean;
}

export interface MarketSnapshot {
  id: string;
  providerMarketId: number;
  specifiers: Record<string, string>;
  variant: string;
  name: string; // rendered from the Oddin description template
  baseName: string; // same template with the line specifier stripped
  scope: { id: string; label: string; order: number };
  status: number;
  lastOddinTs: string;
  lineKey: string | null;
  lineSpec: "threshold" | "handicap" | null;
  lineValue: string | null;
  outcomes: MarketOutcome[];
}

export interface MarketGroup {
  id: string;
  label: string;
  order: number;
  markets: MarketSnapshot[];
}

interface MatchMeta {
  id: string;
  homeTeam: string;
  awayTeam: string;
  sportSlug: string;
}

// A line family bundles every market sharing the same lineKey — e.g. all
// "Total kills" thresholds for Map 1. The UI renders each family as one
// card with the common name at the top and a row per line value.
interface LineFamily {
  kind: "lines";
  key: string;
  baseName: string;
  lineSpec: "threshold" | "handicap";
  providerMarketId: number;
  order: number;
  markets: MarketSnapshot[]; // sorted ascending by numeric line value
}

interface SingleMarket {
  kind: "single";
  key: string;
  market: MarketSnapshot;
  order: number;
}

type RenderEntry = SingleMarket | LineFamily;

function partitionIntoFamilies(markets: MarketSnapshot[]): RenderEntry[] {
  const familiesByKey = new Map<string, LineFamily>();
  const singles: SingleMarket[] = [];

  for (const m of markets) {
    if (m.lineKey && m.lineSpec) {
      let fam = familiesByKey.get(m.lineKey);
      if (!fam) {
        fam = {
          kind: "lines",
          key: m.lineKey,
          baseName: m.baseName,
          lineSpec: m.lineSpec,
          providerMarketId: m.providerMarketId,
          order: m.providerMarketId,
          markets: [],
        };
        familiesByKey.set(m.lineKey, fam);
      }
      fam.markets.push(m);
    } else {
      singles.push({
        kind: "single",
        key: m.id,
        market: m,
        order: m.providerMarketId,
      });
    }
  }

  for (const fam of familiesByKey.values()) {
    fam.markets.sort((a, b) => {
      const av = Number.parseFloat(a.lineValue ?? "0");
      const bv = Number.parseFloat(b.lineValue ?? "0");
      if (Number.isFinite(av) && Number.isFinite(bv)) return av - bv;
      return (a.lineValue ?? "").localeCompare(b.lineValue ?? "");
    });
  }

  return [...singles, ...Array.from(familiesByKey.values())].sort(
    (a, b) => a.order - b.order,
  );
}

// Terminal statuses — the market can never come back this session, so
// fully dropping it from the UI is the right call. 0 = deactivated
// (Oddin closed; e.g. Map 1 markets after Map 1 ends), -3 = settled
// (settlement service flipped this on bet_settlement), -4 = cancelled
// (bet_cancel without end_time). Each of these is now broadcast over
// the WS marketStatus channel so they flip live without a refresh.
// -1 (suspended) is recoverable and stays in the UI as a greyed title
// so the user knows it may come back.
function isMarketDeactivated(m: MarketSnapshot): boolean {
  return m.status === 0 || m.status === -3 || m.status === -4;
}

// Whether a render entry has any content worth keeping in the UI.
// A single-market entry vanishes when its market is deactivated; a
// line family vanishes only when EVERY line in the family is
// deactivated — partial families render their non-deactivated rows
// (and may collapse to a title-only suspended pill if none of those
// rows currently has bettable outcomes).
function entryShouldRender(entry: RenderEntry): boolean {
  if (entry.kind === "single") {
    return !isMarketDeactivated(entry.market);
  }
  return entry.markets.some((m) => !isMarketDeactivated(m));
}

// Stable empty array so card props that take a tips list don't churn
// reference identity on every render of a no-tip card.
const EMPTY_TIPS: ZillaTip[] = [];

// BetBuilder reachability gate. Computed once per render in LiveMarkets
// and threaded down to each outcome button. Returns true when an
// outcome should be locked because the slip is in BetBuilder mode for
// THIS match and the outcome's market isn't reachable from the current
// session (or, before the first leg is picked, isn't OBB-eligible at
// all). Already-picked legs are exempt so the user can deselect them;
// outcomes within markets that have a leg in the slip are also exempt
// so the user can swap a same-market outcome.
type BuilderLockFn = (marketId: string, outcomeId: string) => boolean;
const NEVER_LOCK: BuilderLockFn = () => false;

export function LiveMarkets({
  matchId,
  match,
  initialGroups,
}: {
  matchId: string;
  match: MatchMeta;
  initialGroups: MarketGroup[];
}) {
  const ticks = useLiveOdds(matchId);
  // Per-market live status (1 active / -1 suspended / -3 settled / -4
  // cancelled / 0 deactivated). Server publishes a `marketStatus` WS
  // frame on every transition — outcome ticks alone can't carry this
  // because Oddin frequently leaves `<outcome active="1">` with the
  // last price while the parent `<market status="-1">` is suspended.
  // Without merging the WS status, a market settled or suspended
  // mid-session keeps showing as bettable and placement rejects with
  // `market_not_active` (rendered to the user as "This market is
  // suspended").
  const marketStatusTicks = useLiveMarketStatus(matchId);
  const slip = useBetSlip();
  // ZillaTips loads lazily after first render so the SSR'd markets
  // tree appears without waiting on the historical ROI calc.
  const { tipsByMarket } = useZillaTips(matchId);
  // ZillaFlash: poll-driven boosted offers for this match. The hook
  // returns the global set; we index it down to outcomes on THIS match
  // so the chip overlay below the market name is a cheap Map lookup.
  // Tracks the current odds, so when the underlying ticks the chip
  // re-renders with the fresh boosted price.
  const flashSnapshot = useZillaFlash();
  const flashByOutcome = useMemo<Map<string, OutcomeBoostEntry>>(() => {
    const offers = offersForMatch(flashSnapshot, matchId);
    return indexOffers(offers);
  }, [flashSnapshot, matchId]);
  const flashNowMs = flashSnapshot.nowMs;
  const tMatch = useTranslations("match");
  const tSport = useTranslations("sport");
  const tFlash = useTranslations("zillaflash");

  // Map the API-supplied `scope.id` to a translated label. The API still
  // ships a plain-English `label` field so older clients render
  // something readable, but every storefront fetch resolves through the
  // i18n dictionary instead — that's the only path that respects the
  // user's picked locale.
  function scopeLabel(group: { id: string; label: string }): string {
    if (group.id === "top") return tMatch("topTab");
    if (group.id === "match") return tMatch("matchTab");
    const m = group.id.match(/^map_(\d+)$/);
    if (m && m[1]) return tMatch("mapTab", { n: Number(m[1]) });
    return group.label;
  }

  const builderLocked = useMemo<BuilderLockFn>(() => {
    const isBuilderForThisMatch =
      slip.mode === "betbuilder" && slip.betbuilderMatchId === matchId;
    if (!isBuilderForThisMatch) return NEVER_LOCK;

    // Markets that already carry a leg — clicks within these markets
    // are always allowed (deselecting a leg, or swapping outcomes
    // within the market, both flow through the slip's same-market
    // replace path).
    const marketsWithLeg = new Set<string>();
    const pickedKeys = new Set<string>();
    for (const s of slip.selections) {
      if (s.matchId !== matchId) continue;
      marketsWithLeg.add(s.marketId);
      pickedKeys.add(`${s.marketId}:${s.outcomeId}`);
    }

    const quote = slip.betbuilderQuote;
    if (quote) {
      // Per-outcome gate. Oddin's SessionCreate response lists exactly
      // the outcomes the user can add to extend the current session;
      // anything outside that list is unreachable as a 3rd+ leg. Same-
      // market swaps bypass the gate (above) — Oddin's response
      // intentionally omits the markets we already picked.
      const allowed = new Set<string>();
      for (const m of quote.availableMarkets) {
        if (!m.marketId) continue;
        for (const o of m.outcomes) {
          allowed.add(`${m.marketId}:${o.outcomeId}`);
        }
      }
      return (mid, oid) => {
        const k = `${mid}:${oid}`;
        if (pickedKeys.has(k)) return false;
        if (marketsWithLeg.has(mid)) return false;
        return !allowed.has(k);
      };
    }

    const eligible = slip.betbuilderEligibleMarketIds;
    if (eligible) {
      // First-leg gate. We only have market-level resolution from the
      // /betbuilder/match/:id/markets probe; lock any outcome whose
      // market isn't OBB-eligible for this fixture.
      const allowedMarkets = new Set(eligible);
      return (mid) => {
        if (marketsWithLeg.has(mid)) return false;
        return !allowedMarkets.has(mid);
      };
    }

    // Builder mode is on but the probe hasn't landed yet — don't lock
    // prematurely (would flicker).
    return NEVER_LOCK;
  }, [
    slip.mode,
    slip.betbuilderMatchId,
    slip.betbuilderQuote,
    slip.betbuilderEligibleMarketIds,
    slip.selections,
    matchId,
  ]);

  // Merge live odds + market-status ticks into the server-rendered
  // group tree while preserving the grouping. An odds tick keyed by
  // marketId:outcomeId updates that outcome's price + active flag; a
  // marketStatus tick keyed by marketId updates the parent
  // `m.status`. The two flow on the same shared WS connection so a
  // single subscription per match covers both.
  const mergedGroups = useMemo<MarketGroup[]>(() => {
    return initialGroups.map((g) => ({
      ...g,
      markets: g.markets.map((m) => {
        const statusTick = marketStatusTicks[m.id];
        const status = statusTick ? statusTick.status : m.status;
        return {
          ...m,
          status,
          outcomes: m.outcomes.map((o) => {
            const tick = ticks[`${m.id}:${o.outcomeId}`];
            return tick
              ? { ...o, publishedOdds: tick.publishedOdds, active: tick.active }
              : o;
          }),
        };
      }),
    }));
  }, [initialGroups, ticks, marketStatusTicks]);

  const [scope, setScope] = useState<string>("all");
  const trackTabChange = useMarketTabChangeTracker();
  // Wraps setScope so a click that actually changes the active tab
  // fires a ZillaPass nudge. Re-clicks on the active tab are no-ops
  // (state hasn't changed, no track call).
  function chooseScope(next: string) {
    if (next === scope) return;
    setScope(next);
    trackTabChange();
  }
  const hasAnyMarket = mergedGroups.some((g) => g.markets.length > 0);
  // BetBuilder availability — probe runs once on mount, hides when the
  // sport / fixture isn't OBB-eligible. We use it both to gate the
  // scope-tabs row visibility AND to forward to LiveMarkets' outcome-
  // gate (the eligibility list also feeds slip.betbuilderEligibleMarketIds
  // when the user toggles ON).
  const builder = useBetBuilderProbe(matchId, match.sportSlug);

  // When BetBuilder is active for this match, hide markets that have
  // zero pickable outcomes (every outcome locked by the builderLocked
  // gate). Without this filter the markets list is dominated by greyed
  // rows the user can't interact with — for a typical CS2 fixture that
  // shadows ~75 of the ~125 markets. Markets containing an already-
  // picked leg (or matching same-market swap exemption) always pass
  // because builderLocked returns false for them.
  const isBuilderForThisMatch =
    slip.mode === "betbuilder" && slip.betbuilderMatchId === matchId;

  // Compute the renderable entries per scope group: partition into
  // singles + line families, then drop entries that are fully
  // deactivated (status=0 with no live siblings). When BetBuilder is
  // on for this match, layer the OBB-eligibility filter on top —
  // markets with zero pickable outcomes also drop out. Groups whose
  // entry list ends up empty are excluded so the scope tab + section
  // header don't render an empty body.
  const renderableGroups = useMemo<
    Array<{ id: string; label: string; order: number; entries: RenderEntry[] }>
  >(() => {
    return mergedGroups
      .map((g) => {
        let markets = g.markets;
        if (isBuilderForThisMatch) {
          markets = markets.filter((m) =>
            m.outcomes.some((o) => !builderLocked(m.id, o.outcomeId)),
          );
        }
        const entries = partitionIntoFamilies(markets).filter(entryShouldRender);
        return { id: g.id, label: g.label, order: g.order, entries };
      })
      .filter((g) => g.entries.length > 0);
  }, [mergedGroups, isBuilderForThisMatch, builderLocked]);

  // If the active scope just got filtered out (e.g. user was on "Map 3"
  // and toggled BetBuilder ON, but Map 3 has no OBB-eligible markets),
  // fall back to "all". Otherwise the list goes blank.
  useEffect(() => {
    if (scope === "all") return;
    if (renderableGroups.some((g) => g.id === scope)) return;
    setScope("all");
  }, [renderableGroups, scope]);

  const visible =
    scope === "all"
      ? renderableGroups
      : renderableGroups.filter((g) => g.id === scope);
  const showScopeRow = renderableGroups.length > 1 || builder.available;

  if (!hasAnyMarket) {
    // Subscription is still mounted via useLiveOdds above — when ticks
    // arrive carrying market ids we don't have an SSR shape for, the
    // page falls back to its placeholder. Adding new market shapes
    // mid-session would require a client-side fetch on first-tick-for-
    // unknown-market; for now the SSR filter (status IN 1,0,-1) covers
    // the common case (in-play suspension windows).
    return (
      <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
        {tMatch("noMarkets")}
      </p>
    );
  }

  // Scope tabs and the BetBuilder pill share one row above the markets.
  // Render the row only when EITHER has something to show — otherwise
  // the parent's column-gap would steal 18px of vertical space for an
  // empty flex container.
  //
  // ZillaTipsProvider wraps the entire markets tree so every ZillaTips
  // badge across all groups (single markets + line families) shares
  // one open-state. Hovering a new badge auto-closes the previous;
  // without this, every badge tracks its own state and the popovers
  // stack on top of each other.
  return (
    <ZillaTipsProvider>
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {showScopeRow && (
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {renderableGroups.length > 1 && (
            <>
              <ScopeTab active={scope === "all"} onClick={() => chooseScope("all")}>
                {tSport("all")}
              </ScopeTab>
              {renderableGroups.map((g) => (
                <ScopeTab
                  key={g.id}
                  active={scope === g.id}
                  onClick={() => chooseScope(g.id)}
                >
                  {scopeLabel(g)}
                </ScopeTab>
              ))}
            </>
          )}
          {builder.available && builder.eligibleMarketIds && (
            <div style={{ marginLeft: "auto" }}>
              <BetBuilderTogglePill
                matchId={matchId}
                eligibleMarketIds={builder.eligibleMarketIds}
              />
            </div>
          )}
        </div>
      )}

      {visible.map((g) => {
        const isTop = g.id === "top";
        return (
        <section
          key={g.id}
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          <h2
            className="display"
            style={{
              margin: 0,
              fontSize: isTop ? 16 : 15,
              fontWeight: isTop ? 600 : 500,
              letterSpacing: "-0.01em",
              color: isTop ? "var(--tier-gold)" : "var(--fg-muted)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {isTop && <I.Fire size={16} />}
            {scopeLabel(g)}
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {g.entries.map((entry) =>
              entry.kind === "single" ? (
                <SingleMarketCard
                  key={entry.key}
                  market={entry.market}
                  match={match}
                  slip={slip}
                  builderLocked={builderLocked}
                  tips={tipsByMarket.get(entry.market.id) ?? EMPTY_TIPS}
                  flashByOutcome={flashByOutcome}
                  flashNowMs={flashNowMs}
                  flashKickerShort={tFlash("boostedTagShort")}
                />
              ) : (
                <LineFamilyCard
                  key={entry.key}
                  family={entry}
                  match={match}
                  slip={slip}
                  builderLocked={builderLocked}
                  tipsByMarket={tipsByMarket}
                  flashByOutcome={flashByOutcome}
                  flashNowMs={flashNowMs}
                  flashKickerShort={tFlash("boostedTagShort")}
                />
              ),
            )}
          </div>
        </section>
        );
      })}
    </div>
    </ZillaTipsProvider>
  );
}

function ScopeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 28,
        padding: "0 12px",
        borderRadius: 999,
        border: "1px solid var(--border)",
        background: active ? "var(--fg)" : "var(--surface-1)",
        color: active ? "var(--bg)" : "var(--fg-muted)",
        fontSize: 12,
        fontWeight: 500,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// Whether the market is currently bettable. Server's `POST /bets`
// rejects on `markets.status != 1` with `market_not_active`, so the
// predicate must agree — gate on m.status === 1 first. The WS
// marketStatus frame (server-emitted from feed-ingester and settlement
// on every status transition) keeps m.status in sync mid-session,
// closing the gap that previously let settled / suspended markets keep
// showing their last outcome prices and dead-end at placement.
//
// Outcome-level activity is still required on top — Oddin briefly
// drops individual outcomes inactive within an otherwise-active market
// (e.g. one team scored, only the live underdog markup is mid-update).
// In that case m.status stays 1 but at least one outcome is inactive.
function isMarketBettable(m: MarketSnapshot): boolean {
  if (m.status !== 1) return false;
  return m.outcomes.some((o) => o.active && !!o.publishedOdds);
}

function SingleMarketCard({
  market: m,
  match,
  slip,
  builderLocked,
  tips,
  flashByOutcome,
  flashNowMs,
  flashKickerShort,
}: {
  market: MarketSnapshot;
  match: MatchMeta;
  slip: ReturnType<typeof useBetSlip>;
  builderLocked: BuilderLockFn;
  tips: ZillaTip[];
  flashByOutcome: Map<string, OutcomeBoostEntry>;
  flashNowMs: number;
  flashKickerShort: string;
}) {
  const suspended = !isMarketBettable(m);
  const cols = m.outcomes.length <= 2 ? 2 : m.outcomes.length <= 3 ? 3 : 4;
  // Group tips by their outcomeId so each outcome cell can render
  // ONLY its own historical performance overlay. Removes the
  // ambiguity the previous header-level badge had: now the badge
  // sits directly on the outcome it endorses.
  const tipsByOutcome = new Map<string, ZillaTip[]>();
  for (const t of tips) {
    const bucket = tipsByOutcome.get(t.outcomeId);
    if (bucket) bucket.push(t);
    else tipsByOutcome.set(t.outcomeId, [t]);
  }
  return (
    <div
      className="card"
      style={{
        padding: 16,
        borderRadius: "var(--r-md)",
        opacity: suspended ? 0.6 : undefined,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 500, letterSpacing: "-0.005em" }}>
          {m.name}
        </div>
        <div style={{ flex: 1 }} />
        {suspended && <SuspendedPill />}
      </div>
      <div
        style={{
          display: "grid",
          // `minmax(0, 1fr)` (not bare `1fr`) lets each column shrink
          // below its content's min-content. Without this, a long
          // outcome label (player props like "Jonathan E. Smith over
          // 12.5", or a long team name) pushes the column wider than
          // its 1fr share and the rightmost cells visibly clip past
          // the card border on mobile — the shell's overflow-x: clip
          // hides the actual horizontal scroll but the eye still sees
          // the price button truncated at the viewport edge.
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gap: 8,
        }}
      >
        {m.outcomes.map((o, idx) => {
          const selected = slip.has(m.id, o.outcomeId);
          const price = o.publishedOdds ? Number(o.publishedOdds) : null;
          const label = o.name || o.rawName || o.outcomeId;
          const outcomeTips = tipsByOutcome.get(o.outcomeId) ?? [];
          // Right-edge cells get a right-anchored popover; everything
          // else anchors left so the popover doesn't push off-screen
          // when the badge is in the leftmost column.
          const popoverAlign = idx === cols - 1 ? "right" : "left";
          const locked =
            !o.active ||
            !price ||
            suspended ||
            builderLocked(m.id, o.outcomeId);
          // Wrapper is a plain block div that fills the grid cell —
          // no paddingTop, so the cell's height is identical whether
          // or not it has a tip badge. Keeps the OddButtons aligned
          // across rows in line families.
          //
          // `minWidth: 0` mirrors the `minmax(0, 1fr)` on the parent
          // grid so the wrapper itself can shrink below its content's
          // min-content; otherwise the OddButton's nowrap label would
          // re-inflate the cell from inside.
          //
          // Stacking: the badge overlay div has NO z-index. Without
          // one, a positioned element doesn't create a new stacking
          // context, which means the popover (z-index 200, defined
          // inside the badge) ESCAPES to the nearest stacking-
          // context ancestor and beats all sibling badge chips
          // globally. Previously the overlay carried `zIndex: 5`,
          // which trapped the popover inside a z=5 context and
          // peer badges from later cells painted over it.
          //
          // DOM order: OddButton FIRST, badge wrapper SECOND. With
          // both at the same stacking level, the later element
          // paints on top — the badge sits visibly over the
          // OddButton's top-right corner without needing z-index.
          return (
            <div
              key={o.outcomeId}
              style={{ position: "relative", minWidth: 0 }}
            >
              <OddButton
                size="lg"
                // ZillaFlash boost: when an entry exists for this
                // (marketId, outcomeId), the OddButton renders the
                // BOOSTED price, the cell paints with a green border
                // + soft green tint via `boosted`, and a small chip
                // overlay anchors the top-left corner. Click handler
                // routes through toggle() with the entry so the slip
                // leg carries the offer id + per-outcome boosted odds.
                price={
                  flashByOutcome.get(`${m.id}:${o.outcomeId}`)
                    ? Number(
                        flashByOutcome.get(`${m.id}:${o.outcomeId}`)!.boostedOdds,
                      )
                    : price
                }
                label={label}
                selected={selected}
                locked={locked}
                boosted={!!flashByOutcome.get(`${m.id}:${o.outcomeId}`)}
                onClick={() =>
                  toggle(
                    slip,
                    m,
                    o,
                    match,
                    label,
                    flashByOutcome.get(`${m.id}:${o.outcomeId}`),
                  )
                }
                style={{ width: "100%" }}
              />
              <ZillaFlashChip
                offer={flashByOutcome.get(`${m.id}:${o.outcomeId}`)?.offer}
                nowMs={flashNowMs}
                kickerShort={flashKickerShort}
              />
              {outcomeTips.length > 0 && (
                <div
                  style={{
                    position: "absolute",
                    // Inset into the top-right corner of the OddButton
                    // frame (per the latest design ask). 6px on each
                    // axis keeps the chip clear of the button's
                    // rounded corner radius.
                    top: 6,
                    right: 6,
                    pointerEvents: "auto",
                  }}
                  // Stop click propagation so a tap on the chip's edge
                  // doesn't fall through to the OddButton underneath
                  // and toggle the bet slip selection.
                  onClick={(e) => e.stopPropagation()}
                >
                  <ZillaTipsBadge
                    tips={outcomeTips}
                    currentHome={match.homeTeam}
                    currentAway={match.awayTeam}
                    label={`${m.baseName} · ${label}`}
                    onPick={
                      locked ? undefined : () => toggle(slip, m, o, match, label)
                    }
                    pickSelected={selected}
                    contexts={outcomeTips.map((t) => ({
                      marketId: t.marketId,
                      outcomeId: t.outcomeId,
                      outcomeLabel: label,
                    }))}
                    size="sm"
                    popoverAlign={popoverAlign}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// A line family — multi-row card with the market name at the top and
// one row per threshold / handicap value. Outcomes within a row are
// pairs (Under / Over for totals, Home / Away for handicaps).
function LineFamilyCard({
  family,
  match,
  slip,
  builderLocked,
  tipsByMarket,
  flashByOutcome,
  flashNowMs,
  flashKickerShort,
}: {
  family: LineFamily;
  match: MatchMeta;
  slip: ReturnType<typeof useBetSlip>;
  builderLocked: BuilderLockFn;
  tipsByMarket: Map<string, ZillaTip[]>;
  flashByOutcome: Map<string, OutcomeBoostEntry>;
  flashNowMs: number;
  flashKickerShort: string;
}) {
  // Drop deactivated lines (status=0; Oddin closed them and they're
  // not coming back this session) and lines whose outcomes have no
  // live prices. Each line value is its own Oddin market, so partial
  // suspension of the deep handicaps is normal — the family stays
  // populated with whatever rows are still bettable. Empty rows
  // contribute no bettable info, so removing them keeps the ladder
  // scannable instead of letting it dominate the page with em-dashes.
  const visibleMarkets = useMemo(
    () =>
      family.markets.filter(
        (m) => !isMarketDeactivated(m) && isMarketBettable(m),
      ),
    [family.markets],
  );

  // Identify the stable set of outcome "slots" across the family so each
  // row lines up vertically. Use the rendered outcome name (already
  // resolved: home team / away team / Over / Under / …) from the first
  // market in the family, falling back to subsequent markets when they
  // don't all share the same slots (rare).
  const slotNames = useMemo(() => {
    const seen: string[] = [];
    for (const m of visibleMarkets) {
      for (const o of m.outcomes) {
        const label = o.name || o.rawName || o.outcomeId;
        if (!seen.includes(label)) seen.push(label);
      }
    }
    // Canonical ordering for common pairs so the layout matches user
    // intuition (Under before Over, Home before Away).
    return orderSlots(seen);
  }, [visibleMarkets]);

  // Per-line slot context: each LineRow needs its own tip lookup so
  // the overlay badge can sit on the specific cell with profitable
  // history. Removes the previous "family aggregator" badge from the
  // card header — too coarse to tell the user which line/outcome.

  // Family fully empty: no row in the ladder is currently bettable.
  // Collapse to a greyed title-only card with a Suspended pill so the
  // user knows the market exists and may come back, without staring
  // at a wall of em-dashes. The parent's entryShouldRender filter
  // already drops families that are entirely status=0, so reaching
  // this branch means at least one line is still in suspended/active
  // state — the ladder will repopulate when prices return.
  if (visibleMarkets.length === 0) {
    return (
      <div
        className="card"
        style={{
          padding: 16,
          borderRadius: "var(--r-md)",
          opacity: 0.6,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 500, letterSpacing: "-0.005em" }}>
            {family.baseName}
          </div>
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--fg-dim)",
            }}
          >
            {family.lineSpec === "handicap" ? "Handicap" : "Total"}
          </span>
          <div style={{ flex: 1 }} />
          <SuspendedPill />
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 16, borderRadius: "var(--r-md)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 500, letterSpacing: "-0.005em" }}>
          {family.baseName}
        </div>
        <span
          className="mono"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
          }}
        >
          {family.lineSpec === "handicap" ? "Handicap" : "Total"}
        </span>
        <div style={{ flex: 1 }} />
      </div>
      <div
        style={{
          display: "grid",
          // `minmax(0, 1fr)` (vs bare `1fr`) lets each slot column
          // shrink below its content's min-content. Without it, a long
          // slot header (e.g. a team name like "Carstensz Esports" in
          // a 2-column handicap ladder) sets the grid track wider than
          // the card and the rightmost outcome button visibly clips
          // past the card border on mobile.
          gridTemplateColumns: `60px repeat(${slotNames.length}, minmax(0, 1fr))`,
          gap: "6px 8px",
          alignItems: "center",
          fontSize: 13,
        }}
      >
        <div />
        {slotNames.map((name) => (
          <div
            key={name}
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--fg-dim)",
              textAlign: "center",
            }}
          >
            {name}
          </div>
        ))}
        {visibleMarkets.map((m) => (
          <LineRow
            key={m.id}
            market={m}
            match={match}
            slip={slip}
            slotNames={slotNames}
            suspended={!isMarketBettable(m)}
            builderLocked={builderLocked}
            tips={tipsByMarket.get(m.id) ?? EMPTY_TIPS}
            familyBaseName={family.baseName}
            flashByOutcome={flashByOutcome}
            flashNowMs={flashNowMs}
            flashKickerShort={flashKickerShort}
          />
        ))}
      </div>
    </div>
  );
}

function LineRow({
  market: m,
  match,
  slip,
  slotNames,
  suspended,
  builderLocked,
  tips,
  familyBaseName,
  flashByOutcome,
  flashNowMs,
  flashKickerShort,
}: {
  market: MarketSnapshot;
  match: MatchMeta;
  slip: ReturnType<typeof useBetSlip>;
  slotNames: string[];
  suspended: boolean;
  builderLocked: BuilderLockFn;
  tips: ZillaTip[];
  familyBaseName: string;
  flashByOutcome: Map<string, OutcomeBoostEntry>;
  flashNowMs: number;
  flashKickerShort: string;
}) {
  const bySlot = new Map<string, MarketOutcome>();
  for (const o of m.outcomes) {
    const label = o.name || o.rawName || o.outcomeId;
    bySlot.set(label, o);
  }
  // Per-outcome lookup so each slot only carries its OWN tip (not the
  // whole line's set). Mirrors the SingleMarketCard structure.
  const tipsByOutcome = new Map<string, ZillaTip[]>();
  for (const t of tips) {
    const bucket = tipsByOutcome.get(t.outcomeId);
    if (bucket) bucket.push(t);
    else tipsByOutcome.set(t.outcomeId, [t]);
  }
  const lineLabel = formatLineValue(m.lineValue, m.lineSpec);
  return (
    <>
      <div
        className="mono tnum"
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: "var(--fg)",
          textAlign: "center",
        }}
      >
        {lineLabel}
      </div>
      {slotNames.map((slot, idx) => {
        const o = bySlot.get(slot);
        if (!o) {
          return (
            <OddButton
              key={slot}
              size="md"
              price={null}
              label=""
              locked
              onClick={() => {}}
            />
          );
        }
        const selected = slip.has(m.id, o.outcomeId);
        const price = o.publishedOdds ? Number(o.publishedOdds) : null;
        const outcomeTips = tipsByOutcome.get(o.outcomeId) ?? [];
        // Last column anchors right; everything else left so the
        // popover stays on-screen across the grid.
        const popoverAlign = idx === slotNames.length - 1 ? "right" : "left";
        const locked =
          !o.active ||
          !price ||
          suspended ||
          builderLocked(m.id, o.outcomeId);
        // No paddingTop — every cell in the ladder is the same height
        // whether or not it has a tip badge. Keeps rows aligned across
        // lines (a -3.5 row with a chip and a +6.5 row without must
        // sit at the same baseline).
        //
        // `minWidth: 0` pairs with the parent grid's `minmax(0, 1fr)`
        // so the wrapper can shrink below the OddButton's min-content;
        // otherwise the price-row content would push the cell wider
        // than its 1fr share on narrow viewports.
        //
        // DOM order: OddButton first, badge wrapper second — the
        // badge paints on top naturally. No z-index on the wrapper
        // so it doesn't trap the popover in a local stacking
        // context (popover z-index 200 then beats sibling chips).
        const flashEntry = flashByOutcome.get(`${m.id}:${o.outcomeId}`);
        return (
          <div key={slot} style={{ position: "relative", minWidth: 0 }}>
            <OddButton
              size="md"
              price={flashEntry ? Number(flashEntry.boostedOdds) : price}
              label=""
              selected={selected}
              locked={locked}
              boosted={!!flashEntry}
              onClick={() =>
                toggle(slip, m, o, match, `${slot} ${lineLabel}`, flashEntry)
              }
              style={{ width: "100%" }}
            />
            <ZillaFlashChip
              offer={flashEntry?.offer}
              nowMs={flashNowMs}
              kickerShort={flashKickerShort}
            />
            {outcomeTips.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  // Inset into the top-right corner of the OddButton.
                  // Tighter inset (4px) than the SingleMarketCard
                  // version because md buttons are 44px vs 52px tall.
                  top: 4,
                  right: 4,
                  pointerEvents: "auto",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <ZillaTipsBadge
                  tips={outcomeTips}
                  currentHome={match.homeTeam}
                  currentAway={match.awayTeam}
                  label={`${familyBaseName} ${lineLabel} · ${slot}`}
                  onPick={
                    locked
                      ? undefined
                      : () => toggle(slip, m, o, match, `${slot} ${lineLabel}`)
                  }
                  pickSelected={selected}
                  contexts={outcomeTips.map((t) => ({
                    marketId: t.marketId,
                    outcomeId: t.outcomeId,
                    contextLabel: lineLabel,
                    outcomeLabel: slot,
                  }))}
                  size="sm"
                  popoverAlign={popoverAlign}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function SuspendedPill() {
  return (
    <span
      className="mono"
      style={{
        fontSize: 10.5,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--fg-dim)",
      }}
    >
      Suspended
    </span>
  );
}

// Top-left overlay on every OddButton whose outcome currently carries
// a ZillaFlash offer. Renders a small green BOOST chip + countdown;
// pure visual cue so the user spots the discount before clicking.
// Click-through is intentional — the wrapping OddButton's click
// handler is what actually adds the boosted leg to the slip (it
// reads the same offer from `flashByOutcome`). When `offer` is
// undefined the chip is unmounted, leaving the OddButton corner clean.
function ZillaFlashChip({
  offer,
  nowMs,
  kickerShort,
}: {
  offer: ZillaFlashOffer | undefined;
  nowMs: number;
  kickerShort: string;
  // `size` (md / lg) is no longer needed — the chip floats above
  // the button frame, identical position for both sizes.
}) {
  if (!offer) return null;
  const remainingMs = Math.max(
    0,
    new Date(offer.expiresAt).getTime() - nowMs,
  );
  const urgent = remainingMs <= 5_000;
  // Float the chip ABOVE the OddButton — previously it sat inset at
  // the top-left and visibly covered the price on size="md" cells
  // (which centre the price row with no label, putting it right where
  // the chip was). top=-9 plus a 16-px chip height lands the chip
  // half above the button frame and half over the empty top edge of
  // the button; the surrounding outcome-grid row gap (≥ 6 px) absorbs
  // the overhang cleanly.
  return (
    <div
      style={{
        position: "absolute",
        top: -9,
        left: 6,
        pointerEvents: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 6px",
        borderRadius: 5,
        background: urgent
          ? "rgba(185, 28, 28, 0.92)"
          : "var(--positive, #16a34a)",
        color: "#fff",
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        lineHeight: 1.1,
        boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
      }}
    >
      <span>{kickerShort}</span>
      <span className="mono tnum" style={{ letterSpacing: 0 }}>
        {formatRemaining(offer, nowMs)}
      </span>
    </div>
  );
}

function toggle(
  slip: ReturnType<typeof useBetSlip>,
  m: MarketSnapshot,
  o: MarketOutcome,
  match: MatchMeta,
  outcomeLabel: string,
  flashEntry?: OutcomeBoostEntry | null,
) {
  const suspended = !isMarketBettable(m);
  if (!o.publishedOdds || !o.active || suspended) return;
  if (slip.has(m.id, o.outcomeId)) {
    slip.remove(m.id, o.outcomeId);
  } else {
    slip.add({
      matchId: match.id,
      marketId: m.id,
      outcomeId: o.outcomeId,
      // ZillaFlash boost: when a per-outcome entry exists for this
      // (marketId, outcomeId), pick the BOOSTED price. The server
      // re-validates the offer id + boosted odds before debiting, and
      // shaves -2 s off the effective live-bet acceptance delay.
      odds: flashEntry ? flashEntry.boostedOdds : o.publishedOdds,
      probability: o.probability ?? undefined,
      // Click only reaches here when suspended/!o.active gates above
      // pass — record the stamp so the slip rail starts in the
      // bettable state and re-derives from later WS ticks.
      active: true,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      marketLabel: m.name,
      outcomeLabel,
      sportSlug: match.sportSlug,
      ...(flashEntry ? { zillaFlashOfferId: flashEntry.offer.id } : null),
    });
  }
}

function formatLineValue(v: string | null, spec: MarketSnapshot["lineSpec"]): string {
  if (v == null) return "";
  if (spec === "handicap") {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n > 0 ? `+${n}` : `${n}`;
  }
  return v;
}

// Canonical ordering for common outcome slot names. Unknown labels
// preserve their discovery order after the known slots.
function orderSlots(seen: string[]): string[] {
  const priority = (name: string): number => {
    const n = name.toLowerCase();
    if (n === "under") return 0;
    if (n === "over") return 1;
    if (n === "draw") return 2;
    return 10;
  };
  return [...seen].sort((a, b) => {
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pa - pb;
    return 0; // preserve discovery order for unknown (e.g. team names)
  });
}
