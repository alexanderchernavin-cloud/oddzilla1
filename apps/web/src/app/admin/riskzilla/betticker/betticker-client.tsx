"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { EventRow } from "../events-row";
import type { EventDto } from "../events-row";

const POLL_MS = 3000;
const MAX_ROWS = 250;

const STATUS_PILLS = [
  { key: "all", label: "All" },
  { key: "accepted", label: "Accepted" },
  { key: "rejected", label: "Rejected" },
] as const;

const REJECTION_PILLS = [
  { key: "rejected_match_liability", label: "Match liability" },
  { key: "rejected_bet_factor", label: "Bet factor" },
  { key: "rejected_bank_limit", label: "Bank limit" },
  { key: "rejected_max_payout", label: "Max payout" },
  { key: "rejected_min_stake", label: "Min stake" },
  { key: "rejected_market_factor", label: "Market factor" },
  { key: "rejected_user_blocked", label: "User blocked" },
] as const;

interface Filters {
  status: "all" | "accepted" | "rejected";
  decision: string | null;
  riskTier: number | null;
  paused: boolean;
}

export function BettickerClient() {
  const [rows, setRows] = useState<EventDto[]>([]);
  const [filters, setFilters] = useState<Filters>({
    status: "all",
    decision: null,
    riskTier: null,
    paused: false,
  });
  const [error, setError] = useState<string | null>(null);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", "50");
    if (filters.status !== "all") p.set("status", filters.status);
    if (filters.decision) p.set("decision", filters.decision);
    if (filters.riskTier !== null) p.set("riskTier", String(filters.riskTier));
    return p.toString();
  }, [filters.status, filters.decision, filters.riskTier]);

  const refresh = useCallback(async () => {
    try {
      const res = await clientApi<{ entries: EventDto[] }>(
        `/admin/riskzilla/events?${queryString}`,
      );
      // Merge new rows into the front, dropping duplicates and trimming
      // to MAX_ROWS so the page doesn't grow unbounded.
      setRows((prev) => {
        const merged: EventDto[] = [];
        const seen = new Set<string>();
        for (const e of res.entries) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          merged.push(e);
        }
        for (const e of prev) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          merged.push(e);
          if (merged.length >= MAX_ROWS) break;
        }
        merged.sort((a, b) => (a.cursor < b.cursor ? 1 : -1));
        return merged;
      });
      setError(null);
    } catch (err) {
      setError(err instanceof ApiFetchError ? err.message : "fetch failed");
    }
  }, [queryString]);

  // Reset rows on filter change so we don't carry over a stale stream
  // matching the previous filter set.
  useEffect(() => {
    setRows([]);
    void refresh();
  }, [refresh]);

  // Poll while not paused. Pause stops the timer rather than clearing
  // the state so admins can lock the view while inspecting a row.
  useEffect(() => {
    if (filters.paused) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [filters.paused, refresh]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <PillRow>
          {STATUS_PILLS.map((p) => (
            <Pill
              key={p.key}
              active={filters.status === p.key}
              onClick={() =>
                setFilters((f) => ({ ...f, status: p.key, decision: null }))
              }
            >
              {p.label}
            </Pill>
          ))}
        </PillRow>
        <span style={{ width: 1, height: 22, background: "var(--color-border)", margin: "0 4px" }} />
        <PillRow>
          {REJECTION_PILLS.map((p) => (
            <Pill
              key={p.key}
              active={filters.decision === p.key}
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  status: "rejected",
                  decision: f.decision === p.key ? null : p.key,
                }))
              }
            >
              {p.label}
            </Pill>
          ))}
        </PillRow>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setFilters((f) => ({ ...f, paused: !f.paused }))}
          style={{
            height: 28,
            padding: "0 10px",
            border: "1px solid var(--color-border)",
            background: filters.paused ? "var(--accent, #16a34a)" : "var(--color-bg-subtle)",
            color: filters.paused ? "#fff" : "var(--color-fg)",
            borderRadius: 6,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {filters.paused ? "Resume" : "Pause"}
        </button>
      </div>
      {error && (
        <div
          style={{
            fontSize: 12.5,
            color: "#dc2626",
            background: "color-mix(in oklab, #dc2626 8%, transparent)",
            padding: "6px 10px",
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--color-fg-muted)" }}>
            No events yet. Place a bet on the storefront to see it here.
          </p>
        ) : (
          rows.map((r) => <EventRow key={r.id} row={r} />)
        )}
      </div>
    </div>
  );
}

function PillRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: 4 }}>{children}</div>;
}

function Pill({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 26,
        padding: "0 10px",
        borderRadius: 13,
        border: "1px solid var(--color-border)",
        background: active ? "var(--color-fg)" : "var(--color-bg-subtle)",
        color: active ? "var(--color-bg)" : "var(--color-fg)",
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
