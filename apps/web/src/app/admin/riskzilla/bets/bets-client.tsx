"use client";

// RiskZilla Bets — historical search across every placement attempt.
// Renders a true table with sortable column headers and page-based
// pagination. Currency (USDC engine view / OZ ticket view) is driven
// by the layout-level switch.
//
// Data source is /admin/riskzilla/events, which branches USDC →
// riskzilla_event_log vs OZ → tickets. Both paths return the same
// row shape (per-leg selections, match/sport/tournament/risk_tier
// metadata, decision + reason).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { fromMicro, toMicro } from "@oddzilla/types/money";
import { useRiskzillaCurrency } from "../currency-switch";
import type { EventDto, EventSelectionDto } from "../events-row";

const PAGE_SIZE = 100;

type SortKey =
  | "createdAt"
  | "stake"
  | "potentialPayout"
  | "decision"
  | "riskTier";
type SortDir = "asc" | "desc";

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
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sports, setSports] = useState<SportOption[]>([]);

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
    p.set("limit", String(PAGE_SIZE));
    p.set("page", String(page));
    p.set("sortBy", sortBy);
    p.set("sortDir", sortDir);
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
  }, [filters, page, sortBy, sortDir, currency, stakeToMicroOrNull]);

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
    filters.status !== "all" ||
    !!filters.decision ||
    !!filters.riskTier ||
    !!filters.sportId ||
    !!filters.fromTs ||
    !!filters.toTs ||
    !!filters.minStake ||
    !!filters.maxStake;

  const startIndex = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const endIndex = total === 0 ? 0 : (page - 1) * PAGE_SIZE + rows.length;

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
              setFiltersAndResetPage((f) => ({
                ...f,
                decision: next,
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

      <BetsTable
        rows={rows}
        loading={loading}
        sortBy={sortBy}
        sortDir={sortDir}
        onSort={onSort}
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

// ── Table ──────────────────────────────────────────────────────────────

// Column order matters: long-text cells (tournament / match / market /
// selection) push the right-side numeric columns off-screen on rows
// with verbose tournament + market names — which is most CS2 / LoL
// rows once Map / Way substitution lengthens the market label. Money
// columns come right after User so Stake / Payout stay visible no
// matter how wide the prose columns end up. Tier closes out the
// numeric block; details toggle is last.
const COLUMNS: Array<{
  key: SortKey | "user" | "tournament" | "sport" | "match" | "market" | "selection" | "detail";
  label: string;
  align?: "right";
  sortable?: boolean;
}> = [
  { key: "decision", label: "Status", sortable: true },
  { key: "createdAt", label: "Time", sortable: true },
  { key: "user", label: "User" },
  { key: "stake", label: "Stake", align: "right", sortable: true },
  { key: "potentialPayout", label: "Payout", align: "right", sortable: true },
  { key: "riskTier", label: "Tier", align: "right", sortable: true },
  { key: "sport", label: "Sport" },
  { key: "tournament", label: "Tournament" },
  { key: "match", label: "Match" },
  { key: "market", label: "Market" },
  { key: "selection", label: "Selection" },
  { key: "detail", label: "" },
];

function BetsTable({
  rows,
  loading,
  sortBy,
  sortDir,
  onSort,
}: {
  rows: EventDto[];
  loading: boolean;
  sortBy: SortKey;
  sortDir: SortDir;
  onSort: (col: SortKey) => void;
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12.5,
          tableLayout: "auto",
        }}
      >
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.key} style={thStyle(c.align)}>
                {c.sortable ? (
                  <SortButton
                    label={c.label}
                    col={c.key as SortKey}
                    active={sortBy === c.key}
                    dir={sortDir}
                    onClick={() => onSort(c.key as SortKey)}
                    align={c.align}
                  />
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !loading ? (
            <tr>
              <td
                colSpan={COLUMNS.length}
                style={{
                  padding: "16px 8px",
                  fontSize: 13,
                  color: "var(--color-fg-muted)",
                  textAlign: "center",
                }}
              >
                No matching events.
              </td>
            </tr>
          ) : (
            rows.map((r) => <BetRow key={r.id} row={r} />)
          )}
        </tbody>
      </table>
    </div>
  );
}

function SortButton({
  label,
  col,
  active,
  dir,
  onClick,
  align,
}: {
  label: string;
  col: SortKey;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: "right";
}) {
  const arrow = active ? (dir === "asc" ? "↑" : "↓") : "";
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Sort by ${label}`}
      style={{
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        color: active ? "var(--color-fg)" : "var(--color-fg-muted)",
        fontFamily: "var(--font-mono, monospace)",
        fontSize: 10,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        fontWeight: active ? 700 : 500,
        display: "flex",
        gap: 4,
        alignItems: "center",
        justifyContent: align === "right" ? "flex-end" : "flex-start",
        width: "100%",
      }}
    >
      <span>{label}</span>
      {arrow && (
        <span style={{ fontSize: 10, fontWeight: 700 }}>{arrow}</span>
      )}
    </button>
  );
}

function thStyle(align?: "right"): React.CSSProperties {
  return {
    textAlign: align ?? "left",
    padding: "8px 8px 6px",
    borderBottom: "1px solid var(--color-border)",
    fontWeight: 500,
    fontSize: 10,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--color-fg-muted)",
    fontFamily: "var(--font-mono, monospace)",
    whiteSpace: "nowrap",
  };
}

function tdStyle(align?: "right"): React.CSSProperties {
  return {
    padding: "8px 8px",
    borderBottom: "1px solid var(--color-border)",
    verticalAlign: "top",
    textAlign: align ?? "left",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 220,
  };
}

// Status pill colour + label for every state the API may surface.
// Placement decisions (accepted / rejected_*) come straight from
// `riskzilla_event_log.decision`; the lifecycle states (won, lost,
// partial, void, cashed_out, pending_delay) are derived in
// `services/api/src/modules/admin/riskzilla/events.ts` from
// `tickets.status` + `actual_payout_micro` so the column flips off
// "ACCEPTED" once the ticket actually settles.
const DECISION_COLOR: Record<string, string> = {
  // Placement decisions
  accepted: "#16a34a",
  rejected_min_stake: "#f59e0b",
  rejected_max_payout: "#f59e0b",
  rejected_match_liability: "#dc2626",
  rejected_bet_factor: "#dc2626",
  rejected_bank_limit: "#dc2626",
  rejected_user_blocked: "#94a3b8",
  rejected_market_factor: "#dc2626",
  // Post-settlement lifecycle
  won: "#16a34a",
  partial: "#22c55e",
  lost: "#ef4444",
  void: "#94a3b8",
  cashed_out: "#0ea5e9",
  pending_delay: "#a3a3a3",
};

const DECISION_LABEL: Record<string, string> = {
  accepted: "ACCEPTED",
  rejected_min_stake: "MIN STAKE",
  rejected_max_payout: "MAX PAYOUT",
  rejected_match_liability: "MATCH LIAB",
  rejected_bet_factor: "BET FACTOR",
  rejected_bank_limit: "BANK LIMIT",
  rejected_user_blocked: "USER BLOCKED",
  rejected_market_factor: "MARKET FACTOR",
  won: "WON",
  partial: "WON · PARTIAL",
  lost: "LOST",
  void: "VOID",
  cashed_out: "CASHED OUT",
  pending_delay: "DELAYED",
};

function BetRow({ row }: { row: EventDto }) {
  const [expanded, setExpanded] = useState(false);
  const ts = new Date(row.createdAt);
  const stake = fromMicro(BigInt(row.stakeMicro));
  const payout = fromMicro(BigInt(row.potentialPayoutMicro));
  const color = DECISION_COLOR[row.decision] ?? "var(--color-fg)";
  const label = DECISION_LABEL[row.decision] ?? row.decision.toUpperCase();
  const firstLeg = row.selections[0];
  const extraLegs = row.selections.length - 1;

  const marketCell = firstLeg
    ? firstLeg.marketName
    : row.matchId
      ? "—"
      : "—";
  const selectionCell = firstLeg
    ? `${firstLeg.outcomeName ?? firstLeg.outcomeId} @ ${Number(firstLeg.oddsAtPlacement).toFixed(2)}`
    : "—";

  return (
    <>
      <tr>
        <td style={{ ...tdStyle(), color, fontWeight: 600 }}>
          <span
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: "0.06em",
            }}
          >
            {label}
          </span>
        </td>
        <td
          style={{
            ...tdStyle(),
            fontVariantNumeric: "tabular-nums",
            color: "var(--color-fg-muted)",
            fontSize: 11,
          }}
          title={ts.toLocaleString()}
        >
          {ts.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
          <br />
          <span style={{ fontSize: 10 }}>{ts.toLocaleDateString()}</span>
        </td>
        <td style={tdStyle()}>
          <Link
            href={`/admin/riskzilla/bettors/${row.userId}`}
            style={{
              color: "var(--color-fg)",
              textDecoration: "none",
            }}
            title={row.userEmail ?? row.userId}
          >
            {row.userNickname ?? row.userEmail ?? row.userId.slice(0, 8)}
          </Link>
        </td>
        <td
          style={{
            ...tdStyle("right"),
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {stake} {row.currency}
        </td>
        <td
          style={{
            ...tdStyle("right"),
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {payout} {row.currency}
        </td>
        <td
          style={{
            ...tdStyle("right"),
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {row.riskTier ?? "—"}
        </td>
        <td style={tdStyle()}>{row.sportSlug ?? "—"}</td>
        <td style={tdStyle()} title={row.tournamentName ?? undefined}>
          {row.tournamentName ?? "—"}
        </td>
        <td style={tdStyle()} title={row.matchLabel ?? undefined}>
          {row.matchLabel ?? "—"}
        </td>
        <td style={tdStyle()} title={marketCell}>
          {marketCell}
          {extraLegs > 0 && (
            <span
              style={{
                color: "var(--color-fg-muted)",
                marginLeft: 4,
                fontSize: 11,
              }}
            >
              +{extraLegs}
            </span>
          )}
        </td>
        <td style={tdStyle()} title={selectionCell}>
          {selectionCell}
        </td>
        <td style={{ ...tdStyle("right") }}>
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
        </td>
      </tr>
      {expanded && (
        <tr>
          <td
            colSpan={COLUMNS.length}
            style={{
              padding: "10px 12px",
              background: "var(--color-bg-subtle)",
              borderBottom: "1px solid var(--color-border)",
            }}
          >
            <DetailPanel row={row} />
          </td>
        </tr>
      )}
    </>
  );
}

function DetailPanel({ row }: { row: EventDto }) {
  const ts = new Date(row.createdAt);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        fontSize: 12,
      }}
    >
      {row.selections.length > 0 && (
        <div>
          <span
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--color-fg-muted)",
            }}
          >
            Selections ({row.selections.length})
          </span>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 12,
              marginTop: 6,
            }}
          >
            <thead>
              <tr style={{ color: "var(--color-fg-muted)" }}>
                <th style={detailThStyle}>#</th>
                <th style={detailThStyle}>Match</th>
                <th style={detailThStyle}>Market</th>
                <th style={detailThStyle}>Pick</th>
                <th style={{ ...detailThStyle, textAlign: "right" }}>Odds</th>
                <th style={detailThStyle}>Result</th>
              </tr>
            </thead>
            <tbody>
              {row.selections.map((sel: EventSelectionDto, i: number) => (
                <tr key={`${sel.marketId}-${sel.outcomeId}`}>
                  <td style={detailTdStyle}>{i + 1}</td>
                  <td style={detailTdStyle}>{sel.matchLabel ?? "—"}</td>
                  <td style={detailTdStyle}>{sel.marketName}</td>
                  <td style={detailTdStyle}>
                    {sel.outcomeName ?? sel.outcomeId}
                  </td>
                  <td
                    style={{
                      ...detailTdStyle,
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {Number(sel.oddsAtPlacement).toFixed(2)}
                  </td>
                  <td style={detailTdStyle}>
                    <ResultBadge result={sel.result} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {row.reasonMessage && (
        <div>
          <span
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--color-fg-muted)",
            }}
          >
            Reason
          </span>
          <p style={{ margin: "4px 0 0", color: "var(--color-fg)" }}>
            {row.reasonMessage}
          </p>
        </div>
      )}
      <div>
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--color-fg-muted)",
          }}
        >
          Engine meta
        </span>
        <pre
          style={{
            margin: "4px 0 0",
            padding: "8px 10px",
            background: "var(--color-bg)",
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
              ticketId: row.ticketId,
              decision: row.decision,
              rsAtDecision: row.rsAtDecision,
              bankAtDecisionMicro: row.bankAtDecisionMicro,
              tournament: row.tournamentName,
              riskTier: row.riskTier,
              createdAt: ts.toISOString(),
              meta: row.decisionMeta,
            },
            null,
            2,
          )}
        </pre>
      </div>
    </div>
  );
}

function ResultBadge({ result }: { result: string | null }) {
  if (!result)
    return <span style={{ color: "var(--color-fg-muted)" }}>—</span>;
  const map: Record<string, { label: string; color: string }> = {
    won: { label: "won", color: "#16a34a" },
    lost: { label: "lost", color: "#dc2626" },
    void: { label: "void", color: "var(--color-fg-muted)" },
    half_won: { label: "half-won", color: "#16a34a" },
    half_lost: { label: "half-lost", color: "#dc2626" },
  };
  const m = map[result] ?? {
    label: result,
    color: "var(--color-fg-muted)",
  };
  return (
    <span
      className="mono"
      style={{
        fontSize: 11,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: m.color,
      }}
    >
      {m.label}
    </span>
  );
}

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

const detailThStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "4px 6px",
  borderBottom: "1px solid var(--color-border)",
  fontWeight: 500,
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const detailTdStyle: React.CSSProperties = {
  padding: "4px 6px",
  borderBottom: "1px solid var(--color-border)",
};
