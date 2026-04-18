"use client";

import { useMemo } from "react";
import { useLiveOdds } from "@/lib/use-live-odds";
import { useBetSlip } from "@/lib/bet-slip";
import { OddButton } from "@/components/ui/primitives";

export interface MarketSnapshot {
  id: string;
  providerMarketId: number;
  specifiers: Record<string, string>;
  status: number;
  lastOddinTs: string;
  outcomes: Array<{
    outcomeId: string;
    name: string;
    publishedOdds: string | null;
    active: boolean;
  }>;
}

interface MatchMeta {
  id: string;
  homeTeam: string;
  awayTeam: string;
  sportSlug: string;
}

const MARKET_LABELS: Record<number, string> = {
  1: "Match Winner",
  4: "Map Winner",
};

// Specifier keys Oddin sometimes attaches for display disambiguation
// (`way`, `variant`) that we never want to surface to the user — they're
// internal market-uniqueness hints, not labels. `map` is the only one we
// render explicitly, and only as "Map N" next to the title.
function marketTitle(m: MarketSnapshot): string {
  const base = MARKET_LABELS[m.providerMarketId] ?? `Market #${m.providerMarketId}`;
  if (m.specifiers.map) return `${base} — Map ${m.specifiers.map}`;
  return base;
}

export function LiveMarkets({
  matchId,
  match,
  initialMarkets,
}: {
  matchId: string;
  match: MatchMeta;
  initialMarkets: MarketSnapshot[];
}) {
  const ticks = useLiveOdds(matchId);
  const slip = useBetSlip();

  const merged = useMemo(() => {
    return initialMarkets.map((m) => ({
      ...m,
      outcomes: m.outcomes.map((o) => {
        const tick = ticks[`${m.id}:${o.outcomeId}`];
        return tick
          ? { ...o, publishedOdds: tick.publishedOdds, active: tick.active }
          : o;
      }),
    }));
  }, [initialMarkets, ticks]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {merged.map((m) => {
        const label = marketTitle(m);
        const suspended = m.status !== 1;
        const cols = m.outcomes.length <= 2 ? 2 : m.outcomes.length <= 3 ? 3 : 4;
        return (
          <div
            key={m.id}
            className="card"
            style={{ padding: 16, borderRadius: "var(--r-md)" }}
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
                {label}
              </div>
              {m.specifiers.map && (
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                  Map {m.specifiers.map}
                </span>
              )}
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
                return (
                  <OddButton
                    key={o.outcomeId}
                    size="lg"
                    price={price}
                    label={o.name || o.outcomeId}
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
                          marketLabel: label,
                          outcomeLabel: o.name || o.outcomeId,
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
      })}
    </div>
  );
}
