"use client";

// All-bets browser for the backoffice. Sources from /admin/tickets,
// which returns every ticket regardless of currency or engine path.
// Useful for ops triage, OZ perf-test monitoring, and any "did this
// user actually place that?" question that the RiskZilla view can't
// answer (engine bypassed for OZ + no row for rejected USDC).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { fromMicro, toMicro } from "@oddzilla/types/money";

interface TicketRow {
  id: string;
  cursor: string;
  userId: string;
  userEmail: string | null;
  userNickname: string | null;
  status: string;
  outcome: "won" | "lost" | "void" | null;
  currency: string;
  betType: string;
  legCount: number;
  stakeMicro: string;
  potentialPayoutMicro: string;
  actualPayoutMicro: string | null;
  rejectReason: string | null;
  matchId: string | null;
  matchLabel: string | null;
  sportId: number | null;
  sportSlug: string | null;
  tournamentId: number | null;
  tournamentName: string | null;
  riskTier: number | null;
  placedAt: string;
  settledAt: string | null;
}

interface SportOption {
  id: number;
  slug: string;
  name: string;
}

const CURRENCIES = ["all", "USDC", "OZ"] as const;
type CurrencyKey = (typeof CURRENCIES)[number];

const STATUSES = [
  { key: "", label: "All" },
  { key: "accepted", label: "Open" },
  { key: "pending_delay", label: "Delayed" },
  { key: "settled", label: "Settled" },
  { key: "voided", label: "Voided" },
] as const;

const OUTCOMES = [
  { key: "", label: "Any" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
  { key: "void", label: "Void" },
] as const;

const BET_TYPES = [
  { key: "", label: "Any" },
  { key: "single", label: "Single" },
  { key: "combo", label: "Combo" },
  { key: "betbuilder", label: "BetBuilder" },
  { key: "tiple", label: "Tiple" },
  { key: "tippot", label: "Tippot" },
] as const;

interface Filters {
  currency: CurrencyKey;
  status: string;
  outcome: string;
  betType: string;
  userQuery: string;
  sportId: string;
  fromTs: string;
  toTs: string;
  minStake: string;
  maxStake: string;
}

const EMPTY: Filters = {
  currency: "all",
  status: "",
  outcome: "",
  betType: "",
  userQuery: "",
  sportId: "",
  fromTs: "",
  toTs: "",
  minStake: "",
  maxStake: "",
};

export function BetsClient() {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [sports, setSports] = useState<SportOption[]>([]);
  const [hasMore, setHasMore] = useState(true);

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
    p.set("limit", "100");
    if (filters.currency !== "all") p.set("currency", filters.currency);
    if (filters.status) p.set("status", filters.status);
    if (filters.outcome) p.set("outcome", filters.outcome);
    if (filters.betType) p.set("betType", filters.betType);
    if (filters.userQuery.trim()) p.set("userQuery", filters.userQuery.trim());
    if (filters.sportId) p.set("sportId", filters.sportId);
    if (filters.fromTs) p.set("fromTs", new Date(filters.fromTs).toISOString());
    if (filters.toTs) p.set("toTs", new Date(filters.toTs).toISOString());
    const minMicro = stakeToMicroOrNull(filters.minStake);
    if (minMicro && minMicro !== "invalid") p.set("minStakeMicro", minMicro);
    const maxMicro = stakeToMicroOrNull(filters.maxStake);
    if (maxMicro && maxMicro !== "invalid") p.set("maxStakeMicro", maxMicro);
    return p.toString();
  }, [filters, stakeToMicroOrNull]);

  const reload = useCallback(async () => {
    if (stakeError) return;
    setLoading(true);
    setError(null);
    try {
      const res = await clientApi<{ entries: TicketRow[] }>(
        `/admin/tickets?${queryString}`,
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
      const res = await clientApi<{ entries: TicketRow[] }>(
        `/admin/tickets?${p.toString()}`,
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
    filters.currency !== "all" ||
    !!filters.status ||
    !!filters.outcome ||
    !!filters.betType ||
    !!filters.userQuery ||
    !!filters.sportId ||
    !!filters.fromTs ||
    !!filters.toTs ||
    !!filters.minStake ||
    !!filters.maxStake;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Currency pill row stays prominent at the top — the whole point
          of this page is that it sees both real and demo activity. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--color-fg-muted)",
            marginRight: 4,
          }}
        >
          Currency
        </span>
        {CURRENCIES.map((c) => (
          <Pill
            key={c}
            active={filters.currency === c}
            onClick={() => setF("currency", c)}
          >
            {c === "all" ? "All" : c === "USDC" ? "USDC · real" : "OZ · demo"}
          </Pill>
        ))}
      </div>

      <section style={filterRowStyle}>
        <FilterLabel label="Status">
          <select
            value={filters.status}
            onChange={(e) => setF("status", e.target.value)}
            style={selectStyle}
          >
            {STATUSES.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </FilterLabel>
        <FilterLabel label="Outcome">
          <select
            value={filters.outcome}
            onChange={(e) => {
              const next = e.target.value;
              setFilters((f) => ({
                ...f,
                outcome: next,
                // Outcome only meaningful for settled tickets — auto-
                // narrow status so the UI matches the server filter.
                status: next ? "settled" : f.status,
              }));
            }}
            style={selectStyle}
          >
            {OUTCOMES.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </FilterLabel>
        <FilterLabel label="Bet type">
          <select
            value={filters.betType}
            onChange={(e) => setF("betType", e.target.value)}
            style={selectStyle}
          >
            {BET_TYPES.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
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
        <FilterLabel label="User (email / nickname)">
          <input
            type="search"
            placeholder="search…"
            value={filters.userQuery}
            onChange={(e) => setF("userQuery", e.target.value)}
            style={selectStyle}
          />
        </FilterLabel>
        <FilterLabel label="Min stake">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={filters.minStake}
            onChange={(e) => setF("minStake", e.target.value)}
            style={selectStyle}
          />
        </FilterLabel>
        <FilterLabel label="Max stake">
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

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
            onClick={() => setFilters(EMPTY)}
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
          {rows.length} {rows.length === 1 ? "row" : "rows"}
        </span>
      </div>

      {stakeError && <div style={errorStyle}>{stakeError}</div>}
      {error && <div style={errorStyle}>{error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.length === 0 && !loading ? (
          <p style={{ fontSize: 13, color: "var(--color-fg-muted)" }}>
            No tickets match the current filters.
          </p>
        ) : (
          rows.map((r) => <TicketCard key={r.id} row={r} />)
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

function TicketCard({ row }: { row: TicketRow }) {
  const [expanded, setExpanded] = useState(false);
  const stake = fromMicro(BigInt(row.stakeMicro));
  const potentialPayout = fromMicro(BigInt(row.potentialPayoutMicro));
  const actualPayout =
    row.actualPayoutMicro != null ? fromMicro(BigInt(row.actualPayoutMicro)) : null;
  const placed = new Date(row.placedAt);

  // Status / outcome rendering: ACCEPTED (grey), DELAYED (grey),
  // WON (green), LOST (red), VOID (grey), VOIDED (grey).
  const { label, color } = renderStatusLabel(row);
  const payoutLine =
    row.status === "settled" && actualPayout != null
      ? `${stake} → ${actualPayout} ${row.currency}`
      : `${stake} → ${potentialPayout} ${row.currency}`;

  return (
    <article
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        padding: "8px 12px",
        display: "grid",
        gridTemplateColumns: "100px 120px 1fr 1fr auto auto",
        gap: 12,
        alignItems: "center",
        fontSize: 13,
        background: "var(--color-bg)",
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.06em",
          color,
        }}
      >
        {label}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 11,
          color: "var(--color-fg-muted)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {placed.toLocaleTimeString()}
        <span style={{ display: "block", fontSize: 10 }}>
          {placed.toLocaleDateString()}
        </span>
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <Link
          href={`/admin/users/${row.userId}`}
          style={{ color: "var(--color-fg)", textDecoration: "none" }}
        >
          {row.userNickname ?? row.userEmail ?? row.userId.slice(0, 8)}
        </Link>
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {row.matchLabel ?? "—"}
        {row.sportSlug && (
          <span style={{ color: "var(--color-fg-muted)", marginLeft: 6 }}>
            · {row.sportSlug}
          </span>
        )}
        <span style={{ color: "var(--color-fg-muted)", marginLeft: 6 }}>
          ·{" "}
          {row.betType === "single"
            ? "single"
            : `${row.betType} (${row.legCount})`}
        </span>
      </span>
      <span style={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
        {payoutLine}
      </span>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        style={{
          height: 24,
          padding: "0 8px",
          background: "transparent",
          border: "1px solid var(--color-border)",
          borderRadius: 4,
          fontSize: 11,
          color: "var(--color-fg-muted)",
          cursor: "pointer",
        }}
      >
        {expanded ? "Hide" : "Detail"}
      </button>
      {expanded && (
        <pre
          style={{
            gridColumn: "1 / -1",
            margin: "6px 0 0 0",
            padding: "10px 12px",
            background: "var(--color-bg-subtle)",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            fontSize: 11,
            fontFamily: "var(--font-mono, monospace)",
            color: "var(--color-fg-muted)",
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {JSON.stringify(
            {
              ticketId: row.id,
              status: row.status,
              outcome: row.outcome,
              betType: row.betType,
              legCount: row.legCount,
              currency: row.currency,
              stake,
              potentialPayout,
              actualPayout,
              rejectReason: row.rejectReason,
              match: row.matchLabel,
              sport: row.sportSlug,
              tournament: row.tournamentName,
              riskTier: row.riskTier,
              placedAt: row.placedAt,
              settledAt: row.settledAt,
            },
            null,
            2,
          )}
        </pre>
      )}
    </article>
  );
}

function renderStatusLabel(row: TicketRow): { label: string; color: string } {
  if (row.status === "settled") {
    if (row.outcome === "won")
      return { label: "WON", color: "#16a34a" };
    if (row.outcome === "lost")
      return { label: "LOST", color: "#dc2626" };
    return { label: "VOID", color: "var(--color-fg-muted)" };
  }
  if (row.status === "voided")
    return { label: "VOIDED", color: "var(--color-fg-muted)" };
  if (row.status === "accepted")
    return { label: "OPEN", color: "var(--color-fg)" };
  if (row.status === "pending_delay")
    return { label: "DELAYED", color: "#f59e0b" };
  if (row.status === "rejected")
    return { label: "REJECTED", color: "#dc2626" };
  return { label: row.status.toUpperCase(), color: "var(--color-fg-muted)" };
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
