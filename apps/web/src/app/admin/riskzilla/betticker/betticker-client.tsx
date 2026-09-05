"use client";

// Live decision feed. Polls /admin/riskzilla/events every POLL_MS and
// merges new rows into the front of the list while preserving older
// ones already on screen. Same column structure as the Bets page (via
// the shared events-table module) — operators get matching mental
// models across both surfaces. The visibility + width choices are
// persisted under a betticker-specific localStorage key so each page
// keeps its own layout preference.
//
// No sort controls: the feed is always recency-first server-side.
// onSort is omitted, so the shared table renders plain header labels.

import { useCallback, useEffect, useMemo, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { useRiskzillaCurrency } from "../currency-switch";
import {
  ColumnSettings,
  EventsTable,
  ExportCsvButton,
  useColumnLayout,
  type EventDto,
} from "../events-table";
import { toMicro } from "@oddzilla/types/money";

const POLL_OPTIONS = [3000, 15000, 30000] as const;
const MAX_ROWS = 250;
const COLUMN_STORAGE_KEY = "oz:admin:riskzilla:betticker:columns:v1";

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
  { key: "rejected_velocity", label: "Velocity" },
] as const;

interface SportOption {
  id: number;
  slug: string;
  name: string;
}

type Phase = "all" | "live" | "prematch";
const PHASE_PILLS: ReadonlyArray<{ key: Phase; label: string }> = [
  { key: "all", label: "All" },
  { key: "live", label: "Live" },
  { key: "prematch", label: "Prematch" },
];

interface Filters {
  status: "all" | "accepted" | "rejected";
  decision: string | null;
  phase: Phase;
  betType: "" | "single" | "combo";
  riskTier: string;
  sportId: string;
  minStake: string;
  maxStake: string;
  paused: boolean;
}

const EMPTY_FILTERS: Filters = {
  status: "all",
  decision: null,
  phase: "all",
  betType: "",
  riskTier: "",
  sportId: "",
  minStake: "",
  maxStake: "",
  paused: false,
};

// Client-side quick search over the rows already on screen: match,
// tournament, bettor (email / nickname / id) or ticket id. Comma
// separates alternatives so a batch of ticket ids pastes straight in.
function matchesSearch(row: EventDto, needles: string[]): boolean {
  if (needles.length === 0) return true;
  const hay = [
    row.matchLabel,
    row.tournamentName,
    row.userEmail,
    row.userNickname,
    row.userId,
    row.ticketId,
    row.id,
    row.sportSlug,
    ...row.selections.flatMap((s) => [s.matchLabel, s.marketName, s.outcomeName]),
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" \u0000 ")
    .toLowerCase();
  return needles.some((n) => hay.includes(n));
}

export function BettickerClient() {
  const currency = useRiskzillaCurrency();
  const [rows, setRows] = useState<EventDto[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [search, setSearch] = useState("");
  const [pollMs, setPollMs] = useState<number>(POLL_OPTIONS[0]);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [sports, setSports] = useState<SportOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const columnLayout = useColumnLayout(COLUMN_STORAGE_KEY);

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
    if (filters.phase !== "all") p.set("phase", filters.phase);
    if (filters.betType) p.set("betType", filters.betType);
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
    filters.phase,
    filters.betType,
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
      setLastRefresh(new Date());
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
    const id = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(id);
  }, [filters.paused, pollMs, refresh]);

  const setF = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const hasAnyFilter =
    filters.status !== "all" ||
    !!filters.decision ||
    filters.phase !== "all" ||
    !!filters.betType ||
    !!filters.riskTier ||
    !!filters.sportId ||
    !!filters.minStake ||
    !!filters.maxStake;

  const needles = useMemo(
    () =>
      search
        .split(",")
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean),
    [search],
  );
  const visibleRows = useMemo(
    () => rows.filter((r) => matchesSearch(r, needles)),
    [rows, needles],
  );
  const openInView = useMemo(
    () =>
      visibleRows.filter(
        (r) => r.decision === "accepted" || r.decision === "pending_delay",
      ).length,
    [visibleRows],
  );

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
        <span
          style={{
            width: 1,
            height: 22,
            background: "var(--color-border)",
            margin: "0 4px",
          }}
        />
        <PillRow>
          {PHASE_PILLS.map((p) => (
            <Pill
              key={p.key}
              active={filters.phase === p.key}
              onClick={() => setF("phase", p.key)}
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
          {(
            [
              { key: "", label: "Any type" },
              { key: "single", label: "Single" },
              { key: "combo", label: "Combo" },
            ] as const
          ).map((p) => (
            <Pill
              key={p.key || "any"}
              active={filters.betType === p.key}
              onClick={() => setF("betType", p.key)}
            >
              {p.label}
            </Pill>
          ))}
        </PillRow>
        <span style={{ flex: 1 }} />
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--color-fg)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={!filters.paused}
            onChange={(e) => setF("paused", !e.target.checked)}
          />
          Auto-update
        </label>
        <select
          value={pollMs}
          onChange={(e) => setPollMs(Number(e.target.value))}
          disabled={filters.paused}
          aria-label="Auto-update interval"
          style={{
            height: 28,
            padding: "0 8px",
            border: "1px solid var(--color-border)",
            background: "var(--color-bg)",
            color: "var(--color-fg)",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          {POLL_OPTIONS.map((ms) => (
            <option key={ms} value={ms}>
              {ms / 1000}s
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void refresh()}
          title="Refresh now"
          style={{
            height: 28,
            padding: "0 10px",
            border: "1px solid var(--color-border)",
            background: "var(--color-bg-subtle)",
            color: "var(--color-fg)",
            borderRadius: 6,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Refresh
        </button>
      </div>

      <section style={filterRowStyle}>
        <FilterLabel label="Search event / bettor / ticket id">
          <input
            type="search"
            placeholder="comma-separated for a batch"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={selectStyle}
            spellCheck={false}
          />
        </FilterLabel>
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

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--color-fg-muted)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {visibleRows.length.toLocaleString()} event{visibleRows.length === 1 ? "" : "s"}
          {needles.length > 0 ? ` of ${rows.length.toLocaleString()}` : ""} ·{" "}
          {openInView.toLocaleString()} open in view ·{" "}
          {filters.paused ? "paused" : `auto-update ${pollMs / 1000}s`}
          {lastRefresh
            ? ` · as of ${lastRefresh.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}`
            : ""}{" "}
          · {currency} view
        </span>
        <span style={{ flex: 1 }} />
        <ExportCsvButton rows={visibleRows} filenamePrefix="ticket-stream" />
        <ColumnSettings layout={columnLayout} />
      </div>

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

      <EventsTable
        rows={visibleRows}
        loading={false}
        layout={columnLayout}
        emptyText={
          needles.length > 0
            ? "Nothing on screen matches the search."
            : "No events yet. Place a bet on the storefront to see it here."
        }
      />
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
