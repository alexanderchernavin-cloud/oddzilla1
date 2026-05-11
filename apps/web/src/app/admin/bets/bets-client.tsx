"use client";

// All-bets browser for the backoffice. Sources from /admin/tickets,
// which returns every ticket regardless of currency or engine path.
// Useful for ops triage, OZ perf-test monitoring, and any "did this
// user actually place that?" question that the RiskZilla view can't
// answer (engine bypassed for OZ + no row for rejected USDC).
//
// Default time window is "last 3 days" so the initial page isn't
// dominated by a single perf test or the whole project history; the
// operator can widen via the From filter (or clear it for unbounded).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { fromMicro, toMicro } from "@oddzilla/types/money";

interface TicketSelection {
  marketId: string;
  providerMarketId: number;
  marketName: string;
  outcomeId: string;
  outcomeName: string | null;
  oddsAtPlacement: string;
  matchId: string | null;
  matchLabel: string | null;
  result: string | null;
}

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
  matchScheduledAt: string | null;
  sportId: number | null;
  sportSlug: string | null;
  tournamentId: number | null;
  tournamentName: string | null;
  riskTier: number | null;
  selections: TicketSelection[];
  placedAt: string;
  settledAt: string | null;
}

interface SportOption {
  id: number;
  slug: string;
  name: string;
}

const PAGE_SIZE = 100;

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

// Format a Date for the <input type="datetime-local"> value. Strips
// the seconds + timezone so the input renders cleanly across browsers.
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultFromTs(): string {
  const d = new Date();
  d.setDate(d.getDate() - 3);
  return toLocalInputValue(d);
}

function makeEmptyFilters(): Filters {
  return {
    currency: "all",
    status: "",
    outcome: "",
    betType: "",
    userQuery: "",
    sportId: "",
    // Default to the last 3 days so the initial page reflects recent
    // activity rather than the full history. Operator can clear or
    // widen.
    fromTs: defaultFromTs(),
    toTs: "",
    minStake: "",
    maxStake: "",
  };
}

export function BetsClient() {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(() => makeEmptyFilters());
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
    p.set("limit", String(PAGE_SIZE));
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
      setHasMore(res.entries.length >= PAGE_SIZE);
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
      setHasMore(res.entries.length >= PAGE_SIZE);
    } catch (err) {
      setError(err instanceof ApiFetchError ? err.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  };

  const setF = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const empty = makeEmptyFilters();
  const hasNonDefaultFilter =
    filters.currency !== empty.currency ||
    filters.status !== empty.status ||
    filters.outcome !== empty.outcome ||
    filters.betType !== empty.betType ||
    filters.userQuery !== empty.userQuery ||
    filters.sportId !== empty.sportId ||
    filters.fromTs !== empty.fromTs ||
    filters.toTs !== empty.toTs ||
    filters.minStake !== empty.minStake ||
    filters.maxStake !== empty.maxStake;

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
        <FilterLabel label="From (default: 3d ago)">
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
        {hasNonDefaultFilter && (
          <button
            type="button"
            onClick={() => setFilters(makeEmptyFilters())}
            style={ghostButtonStyle}
          >
            Reset filters
          </button>
        )}
        {filters.fromTs && (
          <button
            type="button"
            onClick={() => setF("fromTs", "")}
            style={ghostButtonStyle}
            title="Clear From filter to search the entire history"
          >
            Search all time
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
          {hasMore && " · more available"}
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

      {/* Pagination footer — explicit page count + "Show next 100"
          button so it's obvious that more data is available. The
          server uses cursor pagination so paging deeper into history
          stays cheap regardless of how far you scroll. */}
      {rows.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            paddingTop: 8,
            borderTop: "1px solid var(--color-border)",
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
            Showing {rows.length} ticket{rows.length === 1 ? "" : "s"}
          </span>
          {hasMore ? (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loading}
              style={pageButtonStyle(loading)}
            >
              {loading ? "Loading…" : `Show next ${PAGE_SIZE} (older) →`}
            </button>
          ) : (
            <span
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--color-fg-muted)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              End of results
            </span>
          )}
        </div>
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
  const scheduledAt = row.matchScheduledAt
    ? new Date(row.matchScheduledAt)
    : null;

  const { label, color } = renderStatusLabel(row);
  const payoutLine =
    row.status === "settled" && actualPayout != null
      ? `${stake} → ${actualPayout} ${row.currency}`
      : `${stake} → ${potentialPayout} ${row.currency}`;

  // Primary selection summary: first leg's market + outcome name. For
  // multi-leg tickets the "+N more" tag points to the Detail expander
  // for the full ladder.
  const firstLeg = row.selections[0];
  const extraLegs = row.selections.length - 1;
  const summary = firstLeg
    ? `${firstLeg.marketName} → ${firstLeg.outcomeName ?? firstLeg.outcomeId} @ ${Number(firstLeg.oddsAtPlacement).toFixed(2)}`
    : "—";

  return (
    <article
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        padding: "10px 12px",
        display: "grid",
        gridTemplateColumns: "100px 110px 1fr auto auto",
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
          lineHeight: 1.35,
        }}
        title={`Placed ${placed.toLocaleString()}`}
      >
        placed
        <br />
        {placed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        <br />
        {placed.toLocaleDateString()}
      </span>
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        {/* Line 1: user · bet-type · currency */}
        <div
          style={{
            fontSize: 13,
            color: "var(--color-fg)",
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <Link
            href={`/admin/users/${row.userId}`}
            style={{ color: "var(--color-fg)", textDecoration: "none", fontWeight: 500 }}
          >
            {row.userNickname ?? row.userEmail ?? row.userId.slice(0, 8)}
          </Link>
          <span style={{ color: "var(--color-fg-muted)" }}>·</span>
          <span style={{ color: "var(--color-fg-muted)" }}>
            {row.betType === "single"
              ? "single"
              : `${row.betType} (${row.legCount})`}
          </span>
          <span style={{ color: "var(--color-fg-muted)" }}>·</span>
          <Currency cur={row.currency} />
        </div>
        {/* Line 2: tournament · match · sport · scheduled */}
        <div
          style={{
            fontSize: 12,
            color: "var(--color-fg-muted)",
            display: "flex",
            gap: 6,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {row.tournamentName && (
            <>
              <span>{row.tournamentName}</span>
              <span>·</span>
            </>
          )}
          <span style={{ color: "var(--color-fg)" }}>{row.matchLabel ?? "—"}</span>
          {row.sportSlug && (
            <>
              <span>·</span>
              <span>{row.sportSlug}</span>
            </>
          )}
          {scheduledAt && (
            <>
              <span>·</span>
              <span title={`Match scheduled ${scheduledAt.toLocaleString()}`}>
                starts {scheduledAt.toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </>
          )}
          {row.riskTier != null && (
            <>
              <span>·</span>
              <span>tier {row.riskTier}</span>
            </>
          )}
        </div>
        {/* Line 3: selection summary */}
        <div
          style={{
            fontSize: 12,
            color: "var(--color-fg-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={summary}
        >
          {summary}
          {extraLegs > 0 && (
            <span style={{ color: "var(--color-fg-muted)", marginLeft: 6 }}>
              · +{extraLegs} more leg{extraLegs === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>
      <span
        style={{
          fontVariantNumeric: "tabular-nums",
          textAlign: "right",
          fontSize: 13,
        }}
      >
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
        <div
          style={{
            gridColumn: "1 / -1",
            marginTop: 8,
            padding: "10px 12px",
            background: "var(--color-bg-subtle)",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            fontSize: 12,
          }}
        >
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
                {row.selections.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={detailTdStyle}>
                      <span style={{ color: "var(--color-fg-muted)" }}>
                        (no selections recorded)
                      </span>
                    </td>
                  </tr>
                ) : (
                  row.selections.map((sel, i) => (
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
                  ))
                )}
              </tbody>
            </table>
          </div>
          {row.rejectReason && (
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
                Reject reason
              </span>
              <p style={{ margin: "4px 0 0", color: "var(--color-fg)" }}>
                {row.rejectReason}
              </p>
            </div>
          )}
          <div
            style={{
              fontSize: 11,
              color: "var(--color-fg-muted)",
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <span>ticket {row.id}</span>
            <span>placed {placed.toLocaleString()}</span>
            {row.settledAt && (
              <span>
                settled {new Date(row.settledAt).toLocaleString()}
              </span>
            )}
            {scheduledAt && (
              <span>match starts {scheduledAt.toLocaleString()}</span>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function Currency({ cur }: { cur: string }) {
  const real = cur === "USDC";
  return (
    <span
      className="mono"
      style={{
        fontSize: 11,
        padding: "1px 6px",
        borderRadius: 4,
        border: "1px solid var(--color-border)",
        color: real ? "var(--color-fg)" : "var(--color-fg-muted)",
        background: real ? "var(--color-bg-subtle)" : "transparent",
      }}
    >
      {cur}
    </span>
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

function pageButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 36,
    padding: "0 16px",
    border: "1px solid var(--color-border)",
    background: "var(--color-fg)",
    color: "var(--color-bg)",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
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
