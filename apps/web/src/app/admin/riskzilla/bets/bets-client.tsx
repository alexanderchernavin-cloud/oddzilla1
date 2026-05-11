"use client";

// Historical bet search across riskzilla_event_log. Mirrors the
// /admin/riskzilla/events endpoint's full filter surface: status,
// decision reason, risk tier (0–10 = the full Oddin range), sport,
// date window, and stake range. Currency comes from the layout-level
// switch (USDC default, OZ for demo monitoring).

import { useCallback, useEffect, useMemo, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { EventRow, type EventDto } from "../events-row";
import { useRiskzillaCurrency } from "../currency-switch";
import { toMicro } from "@oddzilla/types/money";

type StatusKey = "all" | "accepted" | "rejected";
const STATUS_OPTIONS: ReadonlyArray<{ key: StatusKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "accepted", label: "Accepted" },
  { key: "rejected", label: "Rejected" },
];

const DECISION_OPTIONS = [
  { key: "rejected_match_liability", label: "Match liability" },
  { key: "rejected_bet_factor", label: "Bet factor" },
  { key: "rejected_bank_limit", label: "Bank limit" },
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
  status: StatusKey;
  decision: string;
  riskTier: string;
  sportId: string;
  fromTs: string;
  toTs: string;
  minStake: string;
  maxStake: string;
}

const EMPTY_FILTERS: Filters = {
  status: "all",
  decision: "",
  riskTier: "",
  sportId: "",
  fromTs: "",
  toTs: "",
  minStake: "",
  maxStake: "",
};

export function BetsClient() {
  const currency = useRiskzillaCurrency();
  const [rows, setRows] = useState<EventDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sports, setSports] = useState<SportOption[]>([]);
  const [hasMore, setHasMore] = useState(true);

  // Load the sport dropdown once; this is cached in Redis at the API
  // layer so the round-trip is cheap.
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

  // Translate the human stake number ("10", "10.5") into micro-units.
  // Returns null when the input is blank or unparseable; the latter
  // bubbles up as a UI error rather than silently dropping the filter.
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

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", "100");
    p.set("currency", currency);
    if (filters.status !== "all") p.set("status", filters.status);
    if (filters.decision) p.set("decision", filters.decision);
    if (filters.riskTier) p.set("riskTier", filters.riskTier);
    if (filters.sportId) p.set("sportId", filters.sportId);
    if (filters.fromTs) p.set("fromTs", new Date(filters.fromTs).toISOString());
    if (filters.toTs) p.set("toTs", new Date(filters.toTs).toISOString());

    const minMicro = stakeToMicroOrNull(filters.minStake);
    if (minMicro && minMicro !== "invalid") p.set("minStakeMicro", minMicro);
    const maxMicro = stakeToMicroOrNull(filters.maxStake);
    if (maxMicro && maxMicro !== "invalid") p.set("maxStakeMicro", maxMicro);

    return p.toString();
  }, [filters, currency, stakeToMicroOrNull]);

  // Surface invalid-stake input as a foreground error so the user knows
  // the filter isn't being applied.
  const stakeError = useMemo(() => {
    const min = stakeToMicroOrNull(filters.minStake);
    const max = stakeToMicroOrNull(filters.maxStake);
    if (min === "invalid" || max === "invalid") {
      return "Stake filter must be a positive decimal (e.g. 10 or 12.5).";
    }
    return null;
  }, [filters.minStake, filters.maxStake, stakeToMicroOrNull]);

  const reload = useCallback(async () => {
    if (stakeError) return;
    setLoading(true);
    setError(null);
    try {
      const res = await clientApi<{ entries: EventDto[] }>(
        `/admin/riskzilla/events?${queryString}`,
      );
      setRows(res.entries);
      setHasMore(res.entries.length >= 100);
    } catch (err) {
      setError(err instanceof ApiFetchError ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [queryString, stakeError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadMore = async () => {
    if (rows.length === 0) return;
    setLoading(true);
    try {
      const cursor = rows[rows.length - 1]!.cursor;
      const p = new URLSearchParams(queryString);
      p.set("before", cursor);
      const res = await clientApi<{ entries: EventDto[] }>(
        `/admin/riskzilla/events?${p.toString()}`,
      );
      setRows((prev) => [...prev, ...res.entries]);
      setHasMore(res.entries.length >= 100);
    } catch (err) {
      setError(err instanceof ApiFetchError ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  };

  const setF = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const hasAnyFilter =
    filters.status !== "all" ||
    !!filters.decision ||
    !!filters.riskTier ||
    !!filters.sportId ||
    !!filters.fromTs ||
    !!filters.toTs ||
    !!filters.minStake ||
    !!filters.maxStake;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <section style={filterRowStyle}>
        <FilterLabel label="Status">
          <select
            value={filters.status}
            onChange={(e) => setF("status", e.target.value as StatusKey)}
            style={selectStyle}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </FilterLabel>
        <FilterLabel label="Rejection reason">
          <select
            value={filters.decision}
            onChange={(e) => {
              const next = e.target.value;
              setFilters((f) => ({
                ...f,
                decision: next,
                // Picking a rejection reason implies status=rejected;
                // clearing it leaves status alone.
                status: next ? "rejected" : f.status,
              }));
            }}
            style={selectStyle}
          >
            <option value="">Any</option>
            {DECISION_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
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
        <FilterLabel label="From">
          <input
            type="datetime-local"
            value={filters.fromTs}
            onChange={(e) => setF("fromTs", e.target.value)}
            style={selectStyle}
          />
        </FilterLabel>
        <FilterLabel label="To">
          <input
            type="datetime-local"
            value={filters.toTs}
            onChange={(e) => setF("toTs", e.target.value)}
            style={selectStyle}
          />
        </FilterLabel>
      </section>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading || !!stakeError}
          style={primaryButtonStyle(loading || !!stakeError)}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
        {hasAnyFilter && (
          <button
            type="button"
            onClick={() => setFilters(EMPTY_FILTERS)}
            style={ghostButtonStyle}
          >
            Clear filters
          </button>
        )}
        <span style={{ flex: 1 }} />
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--color-fg-muted)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {rows.length} {rows.length === 1 ? "row" : "rows"} ·{" "}
          {currency} view
        </span>
      </div>

      {stakeError && (
        <div style={errorStyle}>{stakeError}</div>
      )}
      {error && <div style={errorStyle}>{error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.length === 0 && !loading ? (
          <p style={{ fontSize: 13, color: "var(--color-fg-muted)" }}>
            No matching events.
          </p>
        ) : (
          rows.map((r) => <EventRow key={r.id} row={r} />)
        )}
      </div>

      {hasMore && rows.length > 0 && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loading}
          style={primaryButtonStyle(loading)}
        >
          {loading ? "Loading…" : "Load older"}
        </button>
      )}
    </div>
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

const errorStyle: React.CSSProperties = {
  fontSize: 12.5,
  color: "#dc2626",
  background: "color-mix(in oklab, #dc2626 8%, transparent)",
  padding: "6px 10px",
  borderRadius: 6,
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 32,
    padding: "0 14px",
    border: "1px solid var(--color-border)",
    background: "var(--color-bg-subtle)",
    color: "var(--color-fg)",
    borderRadius: 6,
    fontSize: 12,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}

const ghostButtonStyle: React.CSSProperties = {
  height: 32,
  padding: "0 12px",
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--color-fg-muted)",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  textDecoration: "underline",
};
