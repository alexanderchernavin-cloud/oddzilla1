"use client";

import { useMemo } from "react";
import { useLiveOdds } from "@/lib/use-live-odds";
import { useBetSlip } from "@/lib/bet-slip";

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

function marketTitle(m: MarketSnapshot): string {
  const base = MARKET_LABELS[m.providerMarketId] ?? `Market #${m.providerMarketId}`;
  if (m.specifiers.map) return `${base} — Map ${m.specifiers.map}`;
  const extras = Object.entries(m.specifiers)
    .filter(([k]) => k !== "map")
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return extras ? `${base} (${extras})` : base;
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

  // Merge SSR snapshot + live ticks. Tick shape: key = `${marketId}:${outcomeId}`.
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
    <ul className="mt-4 space-y-3">
      {merged.map((m) => {
        const label = marketTitle(m);
        return (
          <li key={m.id} className="card p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">{label}</h3>
              {m.status !== 1 ? (
                <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                  status {m.status}
                </span>
              ) : null}
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {m.outcomes.map((o) => (
                <OutcomeCell
                  key={o.outcomeId}
                  outcome={o}
                  selected={slip.has(m.id, o.outcomeId)}
                  onAdd={() => {
                    if (!o.publishedOdds || !o.active) return;
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
                  }}
                />
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function OutcomeCell({
  outcome,
  selected,
  onAdd,
}: {
  outcome: MarketSnapshot["outcomes"][number];
  selected: boolean;
  onAdd: () => void;
}) {
  const disabled = !outcome.active || !outcome.publishedOdds;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onAdd}
      className={
        "flex items-center justify-between rounded-[10px] border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
        (selected
          ? "border-[var(--color-accent)] bg-[color:var(--color-accent)]/10"
          : "border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] hover:border-[var(--color-accent)]")
      }
    >
      <span className="text-sm">{outcome.name || outcome.outcomeId}</span>
      <span
        className={
          "font-mono text-base " +
          (outcome.publishedOdds ? "text-[var(--color-accent)]" : "text-[var(--color-fg-muted)]")
        }
      >
        {outcome.publishedOdds ?? "—"}
      </span>
    </button>
  );
}
