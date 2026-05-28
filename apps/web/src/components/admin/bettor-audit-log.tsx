"use client";

// Per-bettor admin audit log card.
//
// Drops onto any /admin page where the surrounding context already
// implies a user — match the surrounding "Section" / "card" styling of
// the host page via the wrapper at the call site (this component
// renders the inner list only). Wired to GET /admin/users/:id/audit-log,
// which filters by the indexed subject_user_id column (migration 0075).
//
// Cursor pagination: server returns up to `limit+1` rows and exposes a
// nextCursor when more exist. "Load more" appends the next page client-
// side; the page-level wrapper stays a single component instance with
// stable scroll position.

import { useCallback, useEffect, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface BettorAuditEntry {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  ipInet: string | null;
  createdAt: string;
}

interface PageResponse {
  entries: BettorAuditEntry[];
  nextCursor: { createdAt: string; id: string } | null;
}

const PAGE_SIZE = 50;

export function BettorAuditLog({ userId }: { userId: string }) {
  const [entries, setEntries] = useState<BettorAuditEntry[]>([]);
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(
    null,
  );
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after: { createdAt: string; id: string } | null) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (after) {
          qs.set("cursorCreatedAt", after.createdAt);
          qs.set("cursorId", after.id);
        }
        const data = await clientApi<PageResponse>(
          `/admin/users/${userId}/audit-log?${qs.toString()}`,
        );
        setEntries((prev) => (after ? [...prev, ...data.entries] : data.entries));
        setCursor(data.nextCursor);
        if (!data.nextCursor) setDone(true);
      } catch (err) {
        setError(
          err instanceof ApiFetchError
            ? err.message
            : "Couldn't load audit entries.",
        );
      } finally {
        setLoading(false);
      }
    },
    [userId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  if (error) {
    return (
      <p className="text-sm text-[var(--color-negative)]">
        {error}{" "}
        <button
          type="button"
          onClick={() => void load(null)}
          className="underline hover:no-underline"
        >
          Retry
        </button>
      </p>
    );
  }

  if (loading && entries.length === 0) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">Loading audit log…</p>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">
        No admin actions recorded for this bettor yet.
      </p>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
        {entries.map((e) => (
          <AuditRow key={e.id} entry={e} />
        ))}
      </ul>

      <div className="mt-3 flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
        <span>{entries.length} entr{entries.length === 1 ? "y" : "ies"} shown</span>
        {done ? (
          <span>End of log</span>
        ) : (
          <button
            type="button"
            onClick={() => cursor && void load(cursor)}
            disabled={loading || !cursor}
            className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}

function AuditRow({ entry }: { entry: BettorAuditEntry }) {
  const [open, setOpen] = useState(false);
  const summary = summariseAction(entry);
  const hasDetails = entry.beforeJson != null || entry.afterJson != null;

  return (
    <li className="p-4">
      <div className="flex items-center justify-between gap-4 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        <div className="min-w-0 truncate">
          <span className="text-[var(--color-accent)]">{entry.action}</span>
          {summary ? (
            <>
              {" · "}
              <span className="normal-case tracking-normal text-[var(--color-fg)]">
                {summary}
              </span>
            </>
          ) : null}
        </div>
        <time dateTime={entry.createdAt} className="whitespace-nowrap">
          {new Date(entry.createdAt).toLocaleString()}
        </time>
      </div>
      <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
        by {entry.actorEmail ?? "—"}
        {entry.ipInet ? (
          <span className="font-mono text-[var(--color-fg-subtle)]">
            {" · "}
            {entry.ipInet}
          </span>
        ) : null}
      </p>
      {hasDetails ? (
        <details
          open={open}
          onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
          className="mt-2"
        >
          <summary className="cursor-pointer select-none text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]">
            {open ? "Hide details" : "Show details"}
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-[8px] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-fg-muted)]">
            {JSON.stringify(
              { before: entry.beforeJson, after: entry.afterJson },
              null,
              2,
            )}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

// Friendly one-line summary derived from the structured before/after.
// Falls back to "" — the action string in the header already carries
// the canonical info.
function summariseAction(entry: BettorAuditEntry): string {
  const before = (entry.beforeJson ?? {}) as Record<string, unknown>;
  const after = (entry.afterJson ?? {}) as Record<string, unknown>;

  switch (entry.action) {
    case "user.update": {
      const parts: string[] = [];
      for (const k of Object.keys(after)) {
        const b = stringifyValue(before[k]);
        const a = stringifyValue(after[k]);
        parts.push(`${k}: ${b} → ${a}`);
      }
      return parts.join(", ");
    }
    case "wallet.adjust": {
      const delta = stringifyValue(after.deltaMicro);
      const cur = stringifyValue(after.currency);
      const reason = stringifyValue(after.reason);
      return `Δ ${delta} ${cur} — ${reason}`;
    }
    case "riskzilla.bettor.risk_score_update": {
      return `RS ${stringifyValue(before.riskScore)} → ${stringifyValue(after.riskScore)}`;
    }
    case "user.notes_update": {
      const b = stringifyValue(before.notes);
      const a = stringifyValue(after.notes);
      const trim = (s: string) =>
        s.length > 60 ? `${s.slice(0, 57)}…` : s;
      return `${trim(b)} → ${trim(a)}`;
    }
    case "zillapass.stage.override":
    case "zillapass.user_stage": {
      const b = stringifyValue(before.currentSetNumber);
      const a = stringifyValue(after.currentSetNumber);
      const stamp = stringifyValue(after.lastSetCompletedDate);
      return `set ${b} → ${a} (stamp ${stamp})`;
    }
    default: {
      // Per-scope cascade mutations carry a scope hint in target_id.
      if (entry.action.startsWith("bettor_odds_adjustment.")) {
        const bp = (after.adjustmentBp ?? before.adjustmentBp) as
          | number
          | undefined;
        return bp != null ? `${entry.targetId ?? ""} bp=${bp}` : entry.targetId ?? "";
      }
      if (entry.action.startsWith("bettor_promo_visibility.")) {
        const v = after.visible as boolean | undefined;
        return v != null
          ? `${entry.targetId ?? ""} visible=${v}`
          : entry.targetId ?? "";
      }
      return "";
    }
  }
}

function stringifyValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint")
    return String(v);
  return JSON.stringify(v);
}
