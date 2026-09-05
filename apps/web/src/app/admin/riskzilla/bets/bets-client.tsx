"use client";

// RiskZilla Bets — historical search across every placement attempt.
// Filter surface + page-based pagination on top of the shared events
// table (../events-table.tsx). Currency (USDC engine view / OZ ticket
// view) is driven by the layout-level switch.
//
// Data source is /admin/riskzilla/events, which branches USDC →
// riskzilla_event_log vs OZ → tickets. Both paths return the same
// row shape (per-leg selections, match/sport/tournament/risk_tier
// metadata, decision + reason).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { toMicro } from "@oddzilla/types/money";
import { useRiskzillaCurrency } from "../currency-switch";
import {
  ColumnSettings,
  EventsTable,
  ExportCsvButton,
  useColumnLayout,
  type EventDto,
  type SortKey,
  type SortDir,
} from "../events-table";

const PAGE_SIZE = 100;
const COLUMN_STORAGE_KEY = "oz:admin:riskzilla:bets:columns:v1";

interface ListResponse {
  entries: EventDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface SportOption {
  id: number;
  slug: string;
  name: string;
}

type StateKey = "all" | "open" | "won" | "lost" | "rejected" | "void" | "cashed_out";
const STATE_PILLS: ReadonlyArray<{ key: StateKey; label: string }> = [
  { key: "all", label: "All states" },
  { key: "open", label: "Open" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
  { key: "rejected", label: "Rejected" },
  { key: "void", label: "Void" },
  { key: "cashed_out", label: "Cashed out" },
];

type BetTypeKey = "" | "single" | "combo";
const TYPE_PILLS: ReadonlyArray<{ key: BetTypeKey; label: string }> = [
  { key: "single", label: "Single" },
  { key: "combo", label: "Combo" },
];

type PhaseKey = "" | "prematch" | "live";
const PHASE_PILLS: ReadonlyArray<{ key: PhaseKey; label: string }> = [
  { key: "prematch", label: "Prematch" },
  { key: "live", label: "Live" },
];

const DECISION_OPTIONS = [
  { key: "rejected_match_liability", label: "Match liability" },
  { key: "rejected_bet_factor", label: "Bet factor" },
  { key: "rejected_bank_limit", label: "Bank" },
  { key: "rejected_max_payout", label: "Max payout" },
  { key: "rejected_min_stake", label: "Min stake" },
  { key: "rejected_market_factor", label: "Market factor" },
  { key: "rejected_user_blocked", label: "User blocked" },
  { key: "rejected_velocity", label: "Velocity" },
] as const;

interface Filters {
  state: StateKey;
  decision: string;
  betType: BetTypeKey;
  phase: PhaseKey;
  riskTier: string;
  sportId: string;
  // Bettor UUID. Seeded from `?userId=` so the bettor card can deep-link
  // into "every ticket of this account"; free-typed values are only
  // sent once they parse as a UUID (the API 400s on anything else).
  userId: string;
  // Free text: bettor email / nickname (server-side ILIKE).
  q: string;
  // Comma-separated ticket UUIDs.
  ticketIds: string;
  fromTs: string;
  toTs: string;
  minStake: string;
  maxStake: string;
}

const EMPTY_FILTERS: Filters = {
  state: "all",
  decision: "",
  betType: "",
  phase: "",
  riskTier: "",
  sportId: "",
  userId: "",
  q: "",
  ticketIds: "",
  fromTs: "",
  toTs: "",
  minStake: "",
  maxStake: "",
};

function parseTicketIds(raw: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (!t) continue;
    (UUID_RE.test(t) ? valid : invalid).push(t);
  }
  return { valid, invalid };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function BetsClient() {
  const currency = useRiskzillaCurrency();
  const sp = useSearchParams();
  const initialUserId = sp?.get("userId") ?? "";
  const initialTicketIds = sp?.get("ticketIds") ?? "";
  const [rows, setRows] = useState<EventDto[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [filters, setFilters] = useState<Filters>({
    ...EMPTY_FILTERS,
    userId: UUID_RE.test(initialUserId) ? initialUserId : "",
    ticketIds: initialTicketIds,
  });
  const [sports, setSports] = useState<SportOption[]>([]);
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

  const ticketIdParse = useMemo(() => parseTicketIds(filters.ticketIds), [filters.ticketIds]);

  const stakeError = useMemo(() => {
    const min = stakeToMicroOrNull(filters.minStake);
    const max = stakeToMicroOrNull(filters.maxStake);
    if (min === "invalid" || max === "invalid") {
      return "Stake filter must be a positive decimal (e.g. 10 or 12.5).";
    }
    if (ticketIdParse.invalid.length > 0) {
      return `Ticket ids must be UUIDs: ${ticketIdParse.invalid.slice(0, 3).join(", ")}${ticketIdParse.invalid.length > 3 ? "…" : ""}`;
    }
    if (filters.userId.trim() && !UUID_RE.test(filters.userId.trim())) {
      return "Bettor id must be a UUID. Use the search box for email / nickname.";
    }
    return null;
  }, [filters.minStake, filters.maxStake, filters.userId, ticketIdParse, stakeToMicroOrNull]);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", String(PAGE_SIZE));
    p.set("page", String(page));
    p.set("sortBy", sortBy);
    p.set("sortDir", sortDir);
    p.set("currency", currency);
    if (filters.state !== "all") p.set("state", filters.state);
    if (filters.decision) p.set("decision", filters.decision);
    if (filters.betType) p.set("betType", filters.betType);
    if (filters.phase) p.set("phase", filters.phase);
    if (filters.riskTier) p.set("riskTier", filters.riskTier);
    if (filters.sportId) p.set("sportId", filters.sportId);
    if (UUID_RE.test(filters.userId.trim())) p.set("userId", filters.userId.trim());
    if (filters.q.trim()) p.set("q", filters.q.trim());
    if (ticketIdParse.valid.length > 0 && ticketIdParse.invalid.length === 0) {
      p.set("ticketIds", ticketIdParse.valid.join(","));
    }
    if (filters.fromTs) p.set("fromTs", new Date(filters.fromTs).toISOString());
    if (filters.toTs) p.set("toTs", new Date(filters.toTs).toISOString());
    const minMicro = stakeToMicroOrNull(filters.minStake);
    if (minMicro && minMicro !== "invalid") p.set("minStakeMicro", minMicro);
    const maxMicro = stakeToMicroOrNull(filters.maxStake);
    if (maxMicro && maxMicro !== "invalid") p.set("maxStakeMicro", maxMicro);
    return p.toString();
  }, [filters, page, sortBy, sortDir, currency, stakeToMicroOrNull, ticketIdParse]);

  const reload = useCallback(async () => {
    if (stakeError) return;
    setLoading(true);
    setError(null);
    try {
      const res = await clientApi<ListResponse>(
        `/admin/riskzilla/events?${queryString}`,
      );
      setRows(res.entries);
      setTotal(res.total);
      setTotalPages(res.totalPages);
      setLoadedAt(new Date());
    } catch (err) {
      setError(err instanceof ApiFetchError ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [queryString, stakeError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setFiltersAndResetPage = (
    next: Filters | ((f: Filters) => Filters),
  ) => {
    setFilters((prev) =>
      typeof next === "function" ? (next as (f: Filters) => Filters)(prev) : next,
    );
    setPage(1);
  };

  const setF = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFiltersAndResetPage((f) => ({ ...f, [key]: value }));

  const onSort = (col: SortKey) => {
    if (sortBy === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortDir("desc");
    }
    setPage(1);
  };

  const hasAnyFilter =
    filters.state !== "all" ||
    !!filters.decision ||
    !!filters.betType ||
    !!filters.phase ||
    !!filters.riskTier ||
    !!filters.sportId ||
    !!filters.userId ||
    !!filters.q ||
    !!filters.ticketIds ||
    !!filters.fromTs ||
    !!filters.toTs ||
    !!filters.minStake ||
    !!filters.maxStake;

  const startIndex = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const endIndex = total === 0 ? 0 : (page - 1) * PAGE_SIZE + rows.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <PillRow>
          {STATE_PILLS.map((p) => (
            <Pill
              key={p.key}
              active={filters.state === p.key}
              onClick={() =>
                setFiltersAndResetPage((f) => ({
                  ...f,
                  state: p.key,
                  decision: p.key === "rejected" ? f.decision : "",
                }))
              }
            >
              {p.label}
            </Pill>
          ))}
        </PillRow>
        <Divider />
        <PillRow>
          {TYPE_PILLS.map((p) => (
            <Pill
              key={p.key}
              active={filters.betType === p.key}
              onClick={() => setF("betType", filters.betType === p.key ? "" : p.key)}
            >
              {p.label}
            </Pill>
          ))}
        </PillRow>
        <Divider />
        <PillRow>
          {PHASE_PILLS.map((p) => (
            <Pill
              key={p.key}
              active={filters.phase === p.key}
              onClick={() => setF("phase", filters.phase === p.key ? "" : p.key)}
            >
              {p.label}
            </Pill>
          ))}
        </PillRow>
      </div>

      <section style={filterRowStyle}>
        <FilterLabel label="Bettor email / nickname">
          <input
            type="search"
            placeholder="search…"
            value={filters.q}
            onChange={(e) => setF("q", e.target.value)}
            style={selectStyle}
            spellCheck={false}
          />
        </FilterLabel>
        <FilterLabel label="Ticket IDs">
          <input
            type="text"
            placeholder="comma-separated"
            value={filters.ticketIds}
            onChange={(e) => setF("ticketIds", e.target.value)}
            style={{
              ...selectStyle,
              borderColor: ticketIdParse.invalid.length > 0 ? "#dc2626" : undefined,
            }}
            spellCheck={false}
          />
        </FilterLabel>
        <FilterLabel label="Rejection reason">
          <select
            value={filters.decision}
            onChange={(e) => {
              const next = e.target.value;
              setFiltersAndResetPage((f) => ({
                ...f,
                decision: next,
                state: next ? "rejected" : f.state,
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
        <FilterLabel label="Bettor ID">
          <input
            type="text"
            placeholder="uuid"
            value={filters.userId}
            onChange={(e) => setF("userId", e.target.value)}
            style={{
              ...selectStyle,
              borderColor:
                filters.userId.trim() && !UUID_RE.test(filters.userId.trim())
                  ? "#dc2626"
                  : undefined,
            }}
            spellCheck={false}
          />
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

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
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
            onClick={() => setFiltersAndResetPage(EMPTY_FILTERS)}
            style={ghostButtonStyle}
          >
            Clear filters
          </button>
        )}
        <span style={{ flex: 1 }} />
        <TotalLine
          rows={rows.length}
          total={total}
          startIndex={startIndex}
          endIndex={endIndex}
          currency={currency}
        />
        {loadedAt ? (
          <span className="mono" style={totalLineStyle}>
            as of{" "}
            {loadedAt.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        ) : null}
        <ExportCsvButton rows={rows} filenamePrefix="tickets" />
        <ColumnSettings layout={columnLayout} />
      </div>

      {stakeError && <div style={errorStyle}>{stakeError}</div>}
      {error && <div style={errorStyle}>{error}</div>}

      {total > 0 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          loading={loading}
          onChange={setPage}
          position="top"
        />
      )}

      <EventsTable
        rows={rows}
        loading={loading}
        sortBy={sortBy}
        sortDir={sortDir}
        onSort={onSort}
        layout={columnLayout}
      />

      {total > 0 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          loading={loading}
          onChange={setPage}
        />
      )}
    </div>
  );
}

function TotalLine({
  rows,
  total,
  startIndex,
  endIndex,
  currency,
}: {
  rows: number;
  total: number;
  startIndex: number;
  endIndex: number;
  currency: string;
}) {
  const suffix = `· ${currency} view`;
  if (total === 0) {
    return (
      <span className="mono" style={totalLineStyle}>
        0 events {suffix}
      </span>
    );
  }
  if (total === rows) {
    return (
      <span className="mono" style={totalLineStyle}>
        {total.toLocaleString()} event{total === 1 ? "" : "s"} · all shown{" "}
        {suffix}
      </span>
    );
  }
  return (
    <span className="mono" style={totalLineStyle}>
      Showing {startIndex.toLocaleString()}–{endIndex.toLocaleString()} of{" "}
      <span style={{ color: "var(--color-fg)", fontWeight: 600 }}>
        {total.toLocaleString()}
      </span>{" "}
      event{total === 1 ? "" : "s"} {suffix}
    </span>
  );
}

const totalLineStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--color-fg-muted)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

function Pagination({
  page,
  totalPages,
  loading,
  onChange,
  position = "bottom",
}: {
  page: number;
  totalPages: number;
  loading: boolean;
  onChange: (p: number) => void;
  position?: "top" | "bottom";
}) {
  const pages = useMemo(() => {
    const result: (number | "…")[] = [];
    const push = (p: number | "…") => {
      if (result[result.length - 1] === p) return;
      result.push(p);
    };
    const window = [page - 1, page, page + 1].filter(
      (p) => p >= 1 && p <= totalPages,
    );
    push(1);
    if (window[0]! > 2) push("…");
    for (const p of window) push(p);
    if (window[window.length - 1]! < totalPages - 1) push("…");
    if (totalPages > 1) push(totalPages);
    return result;
  }, [page, totalPages]);

  const isTop = position === "top";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingTop: isTop ? 0 : 8,
        paddingBottom: isTop ? 8 : 0,
        borderTop: isTop ? "none" : "1px solid var(--color-border)",
        borderBottom: isTop ? "1px solid var(--color-border)" : "none",
        flexWrap: "wrap",
      }}
    >
      <PageButton
        disabled={loading || page <= 1}
        onClick={() => onChange(page - 1)}
      >
        ← Prev
      </PageButton>
      {pages.map((p, i) =>
        p === "…" ? (
          <span
            key={`gap-${i}`}
            style={{ color: "var(--color-fg-muted)", padding: "0 4px" }}
          >
            …
          </span>
        ) : (
          <PageButton
            key={p}
            active={p === page}
            disabled={loading}
            onClick={() => onChange(p)}
          >
            {p}
          </PageButton>
        ),
      )}
      <PageButton
        disabled={loading || page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        Next →
      </PageButton>
      <span
        className="mono"
        style={{
          marginLeft: 12,
          fontSize: 11,
          color: "var(--color-fg-muted)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        Page {page} of {totalPages}
      </span>
    </div>
  );
}

function PageButton({
  children,
  active,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        minWidth: 32,
        height: 30,
        padding: "0 8px",
        border: "1px solid var(--color-border)",
        background: active ? "var(--color-fg)" : "var(--color-bg)",
        color: active ? "var(--color-bg)" : "var(--color-fg)",
        borderRadius: 6,
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled && !active ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function PillRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{children}</div>;
}

function Divider() {
  return (
    <span
      style={{
        width: 1,
        height: 22,
        background: "var(--color-border)",
        margin: "0 4px",
      }}
    />
  );
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
