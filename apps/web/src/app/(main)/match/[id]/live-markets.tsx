"use client";

import { useMemo, useState } from "react";
import { useLiveOdds } from "@/lib/use-live-odds";
import { useBetSlip } from "@/lib/bet-slip";
import { OddButton } from "@/components/ui/primitives";

export interface MarketOutcome {
  outcomeId: string;
  name: string; // rendered by the API (home→homeTeam, "2:1", "Over", …)
  rawName: string;
  publishedOdds: string | null;
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
  const visible = scope === "all" ? mergedGroups : mergedGroups.filter((g) => g.id === scope);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {mergedGroups.length > 1 && (
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <ScopeTab active={scope === "all"} onClick={() => setScope("all")}>
            All
          </ScopeTab>
          {mergedGroups.map((g) => (
            <ScopeTab
              key={g.id}
              active={scope === g.id}
              onClick={() => setScope(g.id)}
            >
              {g.label}
            </ScopeTab>
          ))}
        </div>
      )}

      {visible.map((g) => {
        const entries = partitionIntoFamilies(g.markets);
        return (
          <section
            key={g.id}
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
          >
            <h2
              className="display"
              style={{
                margin: 0,
                fontSize: 15,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                color: "var(--fg-muted)",
              }}
            >
              {g.label}
            </h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {entries.map((entry) =>
                entry.kind === "single" ? (
                  <SingleMarketCard
                    key={entry.key}
                    market={entry.market}
                    match={match}
                    slip={slip}
                  />
                ) : (
                  <LineFamilyCard
                    key={entry.key}
                    family={entry}
                    match={match}
                    slip={slip}
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

function SingleMarketCard({
  market: m,
  match,
  slip,
}: {
  market: MarketSnapshot;
  match: MatchMeta;
  slip: ReturnType<typeof useBetSlip>;
}) {
  const suspended = m.status !== 1;
  const cols = m.outcomes.length <= 2 ? 2 : m.outcomes.length <= 3 ? 3 : 4;
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
              locked={!o.active || !price || suspended}
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
}: {
  family: LineFamily;
  match: MatchMeta;
  slip: ReturnType<typeof useBetSlip>;
}) {
  // Identify the stable set of outcome "slots" across the family so each
  // row lines up vertically. Use the rendered outcome name (already
  // resolved: home team / away team / Over / Under / …) from the first
  // market in the family, falling back to subsequent markets when they
  // don't all share the same slots (rare).
  const slotNames = useMemo(() => {
    const seen: string[] = [];
    for (const m of family.markets) {
      for (const o of m.outcomes) {
        const label = o.name || o.rawName || o.outcomeId;
        if (!seen.includes(label)) seen.push(label);
      }
    }
    // Canonical ordering for common pairs so the layout matches user
    // intuition (Under before Over, Home before Away).
    return orderSlots(seen);
  }, [family.markets]);

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
        {family.markets.map((m) => {
          const suspended = m.status !== 1;
          return (
            <LineRow
              key={m.id}
              market={m}
              match={match}
              slip={slip}
              slotNames={slotNames}
              suspended={suspended}
            />
          );
        })}
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
}: {
  market: MarketSnapshot;
  match: MatchMeta;
  slip: ReturnType<typeof useBetSlip>;
  slotNames: string[];
  suspended: boolean;
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
            locked={!o.active || !price || suspended}
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
  const suspended = m.status !== 1;
  if (!o.publishedOdds || !o.active || suspended) return;
  if (slip.has(m.id, o.outcomeId)) {
    slip.remove(m.id, o.outcomeId);
  } else {
    slip.add({
      matchId: match.id,
      marketId: m.id,
      outcomeId: o.outcomeId,
      odds: o.publishedOdds,
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
