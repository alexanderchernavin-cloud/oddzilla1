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
  scope: { id: string; label: string; order: number };
  status: number;
  lastOddinTs: string;
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

  // Scope tabs: "All" plus one per group. "All" is the default; selecting a
  // specific scope filters the rendered tree to just that group.
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

      {visible.map((g) => (
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
            {g.markets.map((m) => (
              <MarketCard key={m.id} market={m} match={match} slip={slip} />
            ))}
          </div>
        </section>
      ))}
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

function MarketCard({
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
        {suspended && (
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
        )}
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
              onClick={() => {
                if (!o.publishedOdds || !o.active || suspended) return;
                if (selected) {
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
                    outcomeLabel: label,
                    sportSlug: match.sportSlug,
                  });
                }
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
