"use client";

import { useEffect, useMemo, useState } from "react";
import { useLiveOdds } from "@/lib/use-live-odds";
import { useBetSlip } from "@/lib/bet-slip";
import { OddButton } from "@/components/ui/primitives";
import { I } from "@/components/ui/icons";
import {
  BetBuilderTogglePill,
  useBetBuilderProbe,
} from "@/components/match/betbuilder-toggle";

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

// status=0 = deactivated (Oddin closed the market, e.g. Map 1 markets
// after Map 1 ends). Per spec these don't recover without a fresh
// market_status_change, which our WS doesn't carry — and the user
// asked to remove deactivated markets from the offer entirely.
// status=-1 = suspended (mid-round freeze, pre-map idle) and stays in
// the UI as a greyed title so the user knows it's coming back.
function isMarketDeactivated(m: MarketSnapshot): boolean {
  return m.status === 0;
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
  const slip = useBetSlip();

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

  // Merge live odds ticks into the server-rendered group tree while
  // preserving the grouping. A tick keyed by marketId:outcomeId updates
  // that outcome's price + active state only.
  const mergedGroups = useMemo<MarketGroup[]>(() => {
    return initialGroups.map((g) => ({
      ...g,
      markets: g.markets.map((m) => ({
        ...m,
        outcomes: m.outcomes.map((o) => {
          const tick = ticks[`${m.id}:${o.outcomeId}`];
          return tick
            ? { ...o, publishedOdds: tick.publishedOdds, active: tick.active }
            : o;
        }),
      })),
    }));
  }, [initialGroups, ticks]);

  const [scope, setScope] = useState<string>("all");
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
        No markets from the feed yet. This page will update live when odds start
        flowing.
      </p>
    );
  }

  // Scope tabs and the BetBuilder pill share one row above the markets.
  // Render the row only when EITHER has something to show — otherwise
  // the parent's column-gap would steal 18px of vertical space for an
  // empty flex container.
  return (
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
              <ScopeTab active={scope === "all"} onClick={() => setScope("all")}>
                All
              </ScopeTab>
              {renderableGroups.map((g) => (
                <ScopeTab
                  key={g.id}
                  active={scope === g.id}
                  onClick={() => setScope(g.id)}
                >
                  {g.label}
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
            {g.label}
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
                />
              ) : (
                <LineFamilyCard
                  key={entry.key}
                  family={entry}
                  match={match}
                  slip={slip}
                  builderLocked={builderLocked}
                />
              ),
            )}
          </div>
        </section>
        );
      })}
    </div>
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

// Whether the market is currently bettable. Derived from the OUTCOMES
// rather than `m.status` because the WS only carries outcome-level
// updates (active flag + publishedOdds) — the parent market.status
// stays at whatever the SSR snapshot baked in. If we keyed off m.status
// alone, a market that was suspended at SSR would never visually
// "unlock" again, even after an odds_change re-activates every outcome.
// Symmetric on the way out: when every outcome flips inactive, the
// market is suspended regardless of m.status.
function isMarketBettable(m: MarketSnapshot): boolean {
  return m.outcomes.some((o) => o.active && !!o.publishedOdds);
}

function SingleMarketCard({
  market: m,
  match,
  slip,
  builderLocked,
}: {
  market: MarketSnapshot;
  match: MatchMeta;
  slip: ReturnType<typeof useBetSlip>;
  builderLocked: BuilderLockFn;
}) {
  const suspended = !isMarketBettable(m);
  const cols = m.outcomes.length <= 2 ? 2 : m.outcomes.length <= 3 ? 3 : 4;
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
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: 8,
        }}
      >
        {m.outcomes.map((o) => {
          const selected = slip.has(m.id, o.outcomeId);
          const price = o.publishedOdds ? Number(o.publishedOdds) : null;
          const label = o.name || o.rawName || o.outcomeId;
          return (
            <OddButton
              key={o.outcomeId}
              size="lg"
              price={price}
              label={label}
              selected={selected}
              locked={
                !o.active ||
                !price ||
                suspended ||
                builderLocked(m.id, o.outcomeId)
              }
              onClick={() =>
                toggle(slip, m, o, match, label)
              }
            />
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
}: {
  family: LineFamily;
  match: MatchMeta;
  slip: ReturnType<typeof useBetSlip>;
  builderLocked: BuilderLockFn;
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
          gridTemplateColumns: `60px repeat(${slotNames.length}, 1fr)`,
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
}: {
  market: MarketSnapshot;
  match: MatchMeta;
  slip: ReturnType<typeof useBetSlip>;
  slotNames: string[];
  suspended: boolean;
  builderLocked: BuilderLockFn;
}) {
  const bySlot = new Map<string, MarketOutcome>();
  for (const o of m.outcomes) {
    const label = o.name || o.rawName || o.outcomeId;
    bySlot.set(label, o);
  }
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
        {formatLineValue(m.lineValue, m.lineSpec)}
      </div>
      {slotNames.map((slot) => {
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
        return (
          <OddButton
            key={slot}
            size="md"
            price={price}
            label=""
            selected={selected}
            locked={
              !o.active ||
              !price ||
              suspended ||
              builderLocked(m.id, o.outcomeId)
            }
            onClick={() => toggle(slip, m, o, match, `${slot} ${formatLineValue(m.lineValue, m.lineSpec)}`)}
          />
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

function toggle(
  slip: ReturnType<typeof useBetSlip>,
  m: MarketSnapshot,
  o: MarketOutcome,
  match: MatchMeta,
  outcomeLabel: string,
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
      odds: o.publishedOdds,
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
