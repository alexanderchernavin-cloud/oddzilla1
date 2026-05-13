"use client";

// Live decision feed. Polls /admin/riskzilla/events every POLL_MS and
// merges new rows into the front of the list while preserving older
// ones already on screen. Same filter surface as the Bets page minus
// the date range (this view is always "now"). Currency comes from the
// layout-level switch.

import { useCallback, useEffect, useMemo, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { EventRow } from "../events-row";
import type { EventDto } from "../events-row";
import { useRiskzillaCurrency } from "../currency-switch";
import { toMicro } from "@oddzilla/types/money";

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
  { key: "rejected_bank_limit", label: "Bank" },
  { key: "rejected_max_payout", label: "Max payout" },
  { key: "rejected_min_stake", label: "Min stake" },
  { key: "rejected_market_factor", label: "Market factor" },
  { key: "rejected_user_blocked", label: "User blocked" },
] as const;

interface SportOption {
  id: number;
  slug: string;
  name: string;
}

interface Filters {
  status: "all" | "accepted" | "rejected";
  decision: string | null;
  riskTier: string;
  sportId: string;
  minStake: string;
  maxStake: string;
  paused: boolean;
}

const EMPTY_FILTERS: Filters = {
  status: "all",
  decision: null,
  riskTier: "",
  sportId: "",
  minStake: "",
  maxStake: "",
  paused: false,
};

export function BettickerClient() {
  const currency = useRiskzillaCurrency();
  const [rows, setRows] = useState<EventDto[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sports, setSports] = useState<SportOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    clientApi<{ sports: SportOption[] }>("/catalog/sports")
      .then((res) => {
        if (cancelled) return;
        setSports(res.sports);
      })
      .catch(() => {
        // Sport filter is optional — silently degrade.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const stakeToMicroOrNull = useCallback(
    (raw: string): string | null | "invalid" => {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      try {
        return BigInt(toMicro(trimmed)).toString();
      } catch {
        return "invalid";
      }
    },
    [],
  );

  const stakeError = useMemo(() => {
    const min = stakeToMicroOrNull(filters.minStake);
    const max = stakeToMicroOrNull(filters.maxStake);
    if (min === "invalid" || max === "invalid") {
      return "Stake filter must be a positive decimal (e.g. 10 or 12.5).";
    }
    return null;
  }, [filters.minStake, filters.maxStake, stakeToMicroOrNull]);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", "50");
    p.set("currency", currency);
    if (filters.status !== "all") p.set("status", filters.status);
    if (filters.decision) p.set("decision", filters.decision);
    if (filters.riskTier) p.set("riskTier", filters.riskTier);
    if (filters.sportId) p.set("sportId", filters.sportId);
    const minMicro = stakeToMicroOrNull(filters.minStake);
    if (minMicro && minMicro !== "invalid") p.set("minStakeMicro", minMicro);
    const maxMicro = stakeToMicroOrNull(filters.maxStake);
    if (maxMicro && maxMicro !== "invalid") p.set("maxStakeMicro", maxMicro);
    return p.toString();
  }, [
    filters.status,
    filters.decision,
    filters.riskTier,
    filters.sportId,
    filters.minStake,
    filters.maxStake,
    currency,
    stakeToMicroOrNull,
  ]);

  const refresh = useCallback(async () => {
    if (stakeError) return;
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
  }, [queryString, stakeError]);

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

  const setF = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const hasAnyFilter =
    filters.status !== "all" ||
    !!filters.decision ||
    !!filters.riskTier ||
    !!filters.sportId ||
    !!filters.minStake ||
    !!filters.maxStake;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
        }}
      >
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
        <span
          style={{
            width: 1,
            height: 22,
            background: "var(--color-border)",
            margin: "0 4px",
          }}
        />
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
            background: filters.paused
              ? "var(--accent, #16a34a)"
              : "var(--color-bg-subtle)",
            color: filters.paused ? "#fff" : "var(--color-fg)",
            borderRadius: 6,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {filters.paused ? "Resume" : "Pause"}
        </button>
      </div>

      <section style={filterRowStyle}>
        <FilterLabel label="Risk tier">
          <select
            value={filters.riskTier}
            onChange={(e) => setF("riskTier", e.target.value)}
            style={selectStyle}
          >
            <option value="">Any</option>
            {Array.from({ length: 11 }, (_, n) => n).map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "0 (default)" : n}
              </option>
            ))}
          </select>
        </FilterLabel>
        <FilterLabel label="Sport">
          <select
            value={filters.sportId}
            onChange={(e) => setF("sportId", e.target.value)}
            style={selectStyle}
            disabled={sports.length === 0}
          >
            <option value="">Any</option>
            {sports.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </FilterLabel>
        <FilterLabel label={`Min stake (${currency})`}>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={filters.minStake}
            onChange={(e) => setF("minStake", e.target.value)}
            style={selectStyle}
          />
        </FilterLabel>
        <FilterLabel label={`Max stake (${currency})`}>
          <input
            type="text"
            inputMode="decimal"
            placeholder="∞"
            value={filters.maxStake}
            onChange={(e) => setF("maxStake", e.target.value)}
            style={selectStyle}
          />
        </FilterLabel>
        {hasAnyFilter && (
          <div style={{ alignSelf: "end", paddingBottom: 1 }}>
            <button
              type="button"
              onClick={() =>
                setFilters((f) => ({ ...EMPTY_FILTERS, paused: f.paused }))
              }
              style={{
                height: 32,
                padding: "0 12px",
                border: "1px solid transparent",
                background: "transparent",
                color: "var(--color-fg-muted)",
                borderRadius: 6,
                fontSize: 12,
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </section>

      {stakeError && (
        <div
          style={{
            fontSize: 12.5,
            color: "#dc2626",
            background: "color-mix(in oklab, #dc2626 8%, transparent)",
            padding: "6px 10px",
            borderRadius: 6,
          }}
        >
          {stakeError}
        </div>
      )}
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

function FilterLabel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--color-fg-muted)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

const filterRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 8,
  alignItems: "end",
};

const selectStyle: React.CSSProperties = {
  height: 32,
  padding: "0 8px",
  border: "1px solid var(--color-border)",
  background: "var(--color-bg)",
  color: "var(--color-fg)",
  borderRadius: 6,
  fontSize: 13,
  width: "100%",
  boxSizing: "border-box",
};
