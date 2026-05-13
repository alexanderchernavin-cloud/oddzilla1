"use client";

// Shared table surface for the RiskZilla Bets + Betticker pages.
//
// Both pages render the same column structure — adding or removing a
// column here flips both surfaces in one edit, which is the contract
// the operator asked for. What can differ per page is the user's
// chosen visibility + per-column widths, persisted under a page-local
// localStorage key passed to useColumnLayout().
//
// Sorting is opt-in via the `onSort` prop. The Bets page wires it to
// its server-side `sortBy` + `sortDir` query params; the Betticker
// page omits it (the feed is always recency-first) and headers render
// as plain labels.

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fromMicro } from "@oddzilla/types/money";

// ── Shared event DTO (returned by /admin/riskzilla/events) ────────────

export interface EventSelectionDto {
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

export interface EventDto {
  id: string;
  cursor: string;
  ticketId: string | null;
  userId: string;
  userEmail: string | null;
  userNickname: string | null;
  decision: string;
  reasonMessage: string | null;
  currency: string;
  stakeMicro: string;
  potentialPayoutMicro: string;
  matchId: string | null;
  matchLabel: string | null;
  sportId: number | null;
  sportSlug: string | null;
  tournamentId: number | null;
  tournamentName: string | null;
  riskTier: number | null;
  rsAtDecision: string;
  bankAtDecisionMicro: string;
  decisionMeta: unknown;
  selections: EventSelectionDto[];
  createdAt: string;
}

// ── Column metadata ───────────────────────────────────────────────────

export type ColumnKey =
  | "decision"
  | "createdAt"
  | "user"
  | "stake"
  | "potentialPayout"
  | "riskTier"
  | "sport"
  | "tournament"
  | "match"
  | "market"
  | "selection"
  | "detail";

export type SortKey =
  | "createdAt"
  | "stake"
  | "potentialPayout"
  | "decision"
  | "riskTier";
export type SortDir = "asc" | "desc";

interface ColumnDef {
  key: ColumnKey;
  label: string;
  settingsLabel?: string;
  defaultWidth: number;
  minWidth: number;
  align?: "right";
  sortable?: boolean;
}

// Order matters: long-text columns (Tournament / Match / Market /
// Selection) push the right side off-screen on most CS2 / LoL rows.
// Money + tier columns come right after User so Stake / Payout / Tier
// stay visible no matter how wide the prose columns end up.
export const COLUMN_DEFS: ColumnDef[] = [
  { key: "decision", label: "Status", defaultWidth: 110, minWidth: 80, sortable: true },
  { key: "createdAt", label: "Time", defaultWidth: 100, minWidth: 80, sortable: true },
  { key: "user", label: "User", defaultWidth: 130, minWidth: 80 },
  { key: "stake", label: "Stake", defaultWidth: 100, minWidth: 70, align: "right", sortable: true },
  { key: "potentialPayout", label: "Payout", defaultWidth: 100, minWidth: 70, align: "right", sortable: true },
  { key: "riskTier", label: "Tier", defaultWidth: 70, minWidth: 50, align: "right", sortable: true },
  { key: "sport", label: "Sport", defaultWidth: 90, minWidth: 60 },
  { key: "tournament", label: "Tournament", defaultWidth: 180, minWidth: 100 },
  { key: "match", label: "Match", defaultWidth: 180, minWidth: 100 },
  { key: "market", label: "Market", defaultWidth: 160, minWidth: 100 },
  { key: "selection", label: "Selection", defaultWidth: 160, minWidth: 100 },
  { key: "detail", label: "", settingsLabel: "Detail toggle", defaultWidth: 70, minWidth: 60 },
];

const COLUMN_KEYS = COLUMN_DEFS.map((c) => c.key);
const COLUMN_DEF_BY_KEY: Record<ColumnKey, ColumnDef> = COLUMN_DEFS.reduce(
  (acc, c) => {
    acc[c.key] = c;
    return acc;
  },
  {} as Record<ColumnKey, ColumnDef>,
);

// ── Layout hook (per-page storage key) ────────────────────────────────

interface ColumnLayoutState {
  widths: Record<ColumnKey, number>;
  visible: Record<ColumnKey, boolean>;
}

export interface ColumnLayout {
  state: ColumnLayoutState;
  setWidth: (key: ColumnKey, width: number) => void;
  setVisible: (key: ColumnKey, vis: boolean) => void;
  reset: () => void;
}

function defaultColumnLayout(): ColumnLayoutState {
  const widths = {} as Record<ColumnKey, number>;
  const visible = {} as Record<ColumnKey, boolean>;
  for (const c of COLUMN_DEFS) {
    widths[c.key] = c.defaultWidth;
    visible[c.key] = true;
  }
  return { widths, visible };
}

function mergeColumnLayout(stored: unknown): ColumnLayoutState {
  const base = defaultColumnLayout();
  if (!stored || typeof stored !== "object") return base;
  const s = stored as Partial<ColumnLayoutState>;
  for (const c of COLUMN_DEFS) {
    const w = s.widths?.[c.key];
    if (typeof w === "number" && Number.isFinite(w) && w >= c.minWidth) {
      base.widths[c.key] = Math.max(c.minWidth, Math.min(800, Math.round(w)));
    }
    const v = s.visible?.[c.key];
    if (typeof v === "boolean") {
      base.visible[c.key] = v;
    }
  }
  return base;
}

export function useColumnLayout(storageKey: string): ColumnLayout {
  const [state, setState] = useState<ColumnLayoutState>(defaultColumnLayout);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage post-mount so SSR + first client render
  // agree on the default layout (no hydration mismatch); persisted
  // overrides then snap in.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        setState(mergeColumnLayout(JSON.parse(raw)));
      }
    } catch {
      // Bad JSON / disabled storage — fall back to defaults.
    }
    setHydrated(true);
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Quota or disabled storage — silently degrade.
    }
  }, [hydrated, state, storageKey]);

  const setWidth = useCallback((key: ColumnKey, width: number) => {
    setState((prev) => {
      const def = COLUMN_DEF_BY_KEY[key];
      const clamped = Math.max(def.minWidth, Math.min(800, Math.round(width)));
      if (prev.widths[key] === clamped) return prev;
      return { ...prev, widths: { ...prev.widths, [key]: clamped } };
    });
  }, []);

  const setVisible = useCallback((key: ColumnKey, vis: boolean) => {
    setState((prev) => ({
      ...prev,
      visible: { ...prev.visible, [key]: vis },
    }));
  }, []);

  const reset = useCallback(() => setState(defaultColumnLayout()), []);

  return { state, setWidth, setVisible, reset };
}

// ── Status pill colour + label ────────────────────────────────────────
// Placement decisions (accepted / rejected_*) come straight from
// `riskzilla_event_log.decision`; the lifecycle states (won, lost,
// partial, void, cashed_out, pending_delay) are derived in
// `services/api/src/modules/admin/riskzilla/events.ts` from
// `tickets.status` + `actual_payout_micro` so the column flips off
// "ACCEPTED" once the ticket actually settles.

const DECISION_COLOR: Record<string, string> = {
  accepted: "#16a34a",
  rejected_min_stake: "#f59e0b",
  rejected_max_payout: "#f59e0b",
  rejected_match_liability: "#dc2626",
  rejected_bet_factor: "#dc2626",
  rejected_bank_limit: "#dc2626",
  rejected_user_blocked: "#94a3b8",
  rejected_market_factor: "#dc2626",
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
  rejected_bank_limit: "BANK",
  rejected_user_blocked: "USER BLOCKED",
  rejected_market_factor: "MARKET FACTOR",
  won: "WON",
  partial: "WON · PARTIAL",
  lost: "LOST",
  void: "VOID",
  cashed_out: "CASHED OUT",
  pending_delay: "DELAYED",
};

// ── The table ─────────────────────────────────────────────────────────

interface EventsTableProps {
  rows: EventDto[];
  loading: boolean;
  layout: ColumnLayout;
  // Sorting is opt-in. When onSort is omitted, every header renders as
  // a plain label (no buttons, no arrows) — used by the live betticker
  // feed which is always recency-first server-side.
  sortBy?: SortKey;
  sortDir?: SortDir;
  onSort?: (col: SortKey) => void;
  emptyText?: string;
}

export function EventsTable({
  rows,
  loading,
  layout,
  sortBy,
  sortDir,
  onSort,
  emptyText = "No matching events.",
}: EventsTableProps) {
  const visibleCols = useMemo(
    () => COLUMN_DEFS.filter((c) => layout.state.visible[c.key] !== false),
    [layout.state.visible],
  );
  const tableWidth = useMemo(
    () => visibleCols.reduce((sum, c) => sum + layout.state.widths[c.key], 0),
    [visibleCols, layout.state.widths],
  );

  // No visible columns is a degenerate state — render an empty hint
  // rather than a 0-wide table. Settings popover stays reachable from
  // the toolbar so the user can re-enable a column.
  if (visibleCols.length === 0) {
    return (
      <div
        style={{
          padding: "20px 8px",
          fontSize: 13,
          color: "var(--color-fg-muted)",
          textAlign: "center",
          border: "1px dashed var(--color-border)",
          borderRadius: 6,
        }}
      >
        All columns are hidden. Open the Columns menu above to re-enable some.
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          // Explicit width = sum of visible cols. With tableLayout:
          // fixed + a colgroup, this is the table's "natural" width.
          // min-width: 100% then stretches the table to fill its
          // wrapper on wide viewports — browsers scale the explicit
          // col widths up proportionally so user-dragged ratios are
          // preserved. When the sum exceeds the viewport, the wrapper
          // scrolls horizontally and the exact pixel widths are kept.
          width: tableWidth,
          minWidth: "100%",
          borderCollapse: "collapse",
          fontSize: 12.5,
          tableLayout: "fixed",
        }}
      >
        <colgroup>
          {visibleCols.map((c) => (
            <col key={c.key} style={{ width: layout.state.widths[c.key] }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {visibleCols.map((c, i) => (
              <th key={c.key} style={thStyle(c.align)}>
                {c.sortable && onSort ? (
                  <SortButton
                    label={c.label}
                    col={c.key as SortKey}
                    active={sortBy === c.key}
                    dir={sortDir ?? "desc"}
                    onClick={() => onSort(c.key as SortKey)}
                    align={c.align}
                  />
                ) : (
                  <span
                    style={{
                      display: "inline-block",
                      textAlign: c.align ?? "left",
                      width: "100%",
                    }}
                  >
                    {c.label}
                  </span>
                )}
                {/* Last column has no resize handle — there's nothing
                    to its right to resize against, and a handle there
                    would feel like the table itself is draggable. */}
                {i < visibleCols.length - 1 && (
                  <ResizeHandle
                    onResize={(delta) =>
                      layout.setWidth(
                        c.key,
                        layout.state.widths[c.key] + delta,
                      )
                    }
                  />
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !loading ? (
            <tr>
              <td
                colSpan={visibleCols.length}
                style={{
                  padding: "16px 8px",
                  fontSize: 13,
                  color: "var(--color-fg-muted)",
                  textAlign: "center",
                }}
              >
                {emptyText}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <EventRow key={r.id} row={r} visibleCols={visibleCols} />
            ))
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
    padding: "8px 14px 6px 8px",
    borderBottom: "1px solid var(--color-border)",
    fontWeight: 500,
    fontSize: 10,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--color-fg-muted)",
    fontFamily: "var(--font-mono, monospace)",
    whiteSpace: "nowrap",
    position: "relative",
    overflow: "hidden",
  };
}

function tdStyle(align?: "right"): React.CSSProperties {
  // Width is enforced by the table's <colgroup>; cells just need
  // ellipsis truncation when content overflows the assigned column.
  return {
    padding: "8px 8px",
    borderBottom: "1px solid var(--color-border)",
    verticalAlign: "top",
    textAlign: align ?? "left",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

function ResizeHandle({ onResize }: { onResize: (delta: number) => void }) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    let lastX = e.clientX;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - lastX;
      lastX = ev.clientX;
      if (delta !== 0) onResize(delta);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return (
    <div
      onPointerDown={onPointerDown}
      onClick={(e) => e.stopPropagation()}
      title="Drag to resize column"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 8,
        cursor: "col-resize",
        touchAction: "none",
        userSelect: "none",
      }}
    />
  );
}

export function ColumnSettings({ layout }: { layout: ColumnLayout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visibleCount = COLUMN_KEYS.reduce(
    (n, k) => n + (layout.state.visible[k] ? 1 : 0),
    0,
  );

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Show / hide columns and reset widths"
        style={{
          height: 32,
          padding: "0 12px",
          border: "1px solid var(--color-border)",
          background: open ? "var(--color-bg-subtle)" : "var(--color-bg)",
          color: "var(--color-fg)",
          borderRadius: 6,
          fontSize: 12,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span>Columns</span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--color-fg-muted)",
            letterSpacing: "0.06em",
          }}
        >
          {visibleCount}/{COLUMN_KEYS.length}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 220,
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            padding: 8,
            zIndex: 30,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--color-fg-muted)",
              padding: "4px 6px 6px",
            }}
          >
            Visible columns
          </div>
          {COLUMN_DEFS.map((c) => {
            const checked = layout.state.visible[c.key] !== false;
            return (
              <label
                key={c.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 6px",
                  fontSize: 13,
                  color: "var(--color-fg)",
                  cursor: "pointer",
                  borderRadius: 4,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => layout.setVisible(c.key, e.target.checked)}
                />
                <span>{c.settingsLabel ?? c.label}</span>
              </label>
            );
          })}
          <div
            style={{
              borderTop: "1px solid var(--color-border)",
              marginTop: 6,
              paddingTop: 6,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              style={{
                fontSize: 11,
                color: "var(--color-fg-muted)",
              }}
            >
              Drag column edges to resize
            </span>
            <button
              type="button"
              onClick={layout.reset}
              style={{
                background: "transparent",
                border: "1px solid var(--color-border)",
                color: "var(--color-fg)",
                borderRadius: 4,
                padding: "4px 10px",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Row + detail panel ────────────────────────────────────────────────

function EventRow({
  row,
  visibleCols,
}: {
  row: EventDto;
  visibleCols: ColumnDef[];
}) {
  const [expanded, setExpanded] = useState(false);
  const ts = new Date(row.createdAt);
  const stake = fromMicro(BigInt(row.stakeMicro));
  const payout = fromMicro(BigInt(row.potentialPayoutMicro));
  const color = DECISION_COLOR[row.decision] ?? "var(--color-fg)";
  const label = DECISION_LABEL[row.decision] ?? row.decision.toUpperCase();
  const firstLeg = row.selections[0];
  const extraLegs = row.selections.length - 1;

  const marketCell = firstLeg ? firstLeg.marketName : "—";
  const selectionCell = firstLeg
    ? `${firstLeg.outcomeName ?? firstLeg.outcomeId} @ ${Number(firstLeg.oddsAtPlacement).toFixed(2)}`
    : "—";

  const cells: Record<ColumnKey, ReactNode> = {
    decision: (
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
    ),
    createdAt: (
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
    ),
    user: (
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
    ),
    stake: (
      <td
        style={{
          ...tdStyle("right"),
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {stake} {row.currency}
      </td>
    ),
    potentialPayout: (
      <td
        style={{
          ...tdStyle("right"),
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {payout} {row.currency}
      </td>
    ),
    riskTier: (
      <td
        style={{
          ...tdStyle("right"),
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {row.riskTier ?? "—"}
      </td>
    ),
    sport: <td style={tdStyle()}>{row.sportSlug ?? "—"}</td>,
    tournament: (
      <td style={tdStyle()} title={row.tournamentName ?? undefined}>
        {row.tournamentName ?? "—"}
      </td>
    ),
    match: (
      <td style={tdStyle()} title={row.matchLabel ?? undefined}>
        {row.matchLabel ?? "—"}
      </td>
    ),
    market: (
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
    ),
    selection: (
      <td style={tdStyle()} title={selectionCell}>
        {selectionCell}
      </td>
    ),
    detail: (
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
    ),
  };

  return (
    <>
      <tr>{visibleCols.map((c) => <Cell key={c.key}>{cells[c.key]}</Cell>)}</tr>
      {expanded && (
        <tr>
          <td
            colSpan={visibleCols.length}
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

// Each cell renders as <td> already; this passthrough keeps key semantics
// at the row level while letting each cell carry its own props (align,
// color, monospace, etc).
function Cell({ children }: { children: ReactNode }) {
  return <>{children}</>;
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
              {row.selections.map((sel, i) => (
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
