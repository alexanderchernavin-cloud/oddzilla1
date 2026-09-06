"use client";

// Alert center queue. Filters + list + per-alert actions (acknowledge,
// assign to me, comment, resolve, reopen) with an expandable detail
// panel showing the payload and the event trail. Polls the list every
// 30 s while the tab is open so a fresh critical shows up unprompted.

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { fromMicroMoney } from "@oddzilla/types/money";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { SEVERITY_COLOR, type AlertSummary } from "@/components/admin/alerts-banner";
import { LabelChip } from "@/app/admin/users/label-chip";
import { BETTOR_LABELS, type BettorLabel } from "@oddzilla/types/bettor-labels";
import { RulesEditor, type AlertRuleDto } from "./rules-editor";

export interface AlertDto {
  id: string;
  kind: string;
  kindLabel: string;
  severity: "critical" | "serious" | "warning";
  status: "open" | "acknowledged" | "resolved";
  title: string;
  body: string | null;
  subjectUserId: string | null;
  subjectEmail: string | null;
  subjectNickname: string | null;
  subjectLabels: string[];
  ticketId: string | null;
  matchId: string | null;
  matchLabel: string | null;
  currency: string | null;
  amountMicro: string | null;
  payload: Record<string, unknown>;
  assignedTo: string | null;
  assigneeEmail: string | null;
  acknowledgedAt: string | null;
  acknowledgedByEmail: string | null;
  resolvedAt: string | null;
  resolvedByEmail: string | null;
  resolution: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  commentCount: number;
}

export interface AlertListResponse {
  entries: AlertDto[];
  total: number;
  limit: number;
  offset: number;
  counts: AlertSummary | null;
}

interface AlertEventDto {
  id: string;
  kind: string;
  note: string | null;
  meta: Record<string, unknown>;
  actorEmail: string | null;
  createdAt: string;
}

type StatusKey = "active" | "open" | "acknowledged" | "resolved" | "all";
const STATUS_PILLS: ReadonlyArray<{ key: StatusKey; label: string }> = [
  { key: "active", label: "Active" },
  { key: "open", label: "Open" },
  { key: "acknowledged", label: "Acknowledged" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "All" },
];
const SEVERITY_PILLS = ["critical", "serious", "warning"] as const;
type AssigneeKey = "" | "me" | "unassigned";

const POLL_MS = 30_000;

function isLabel(v: string): v is BettorLabel {
  return (BETTOR_LABELS as readonly string[]).includes(v);
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function AlertsClient({
  initial,
  initialRules,
  initialUserId,
}: {
  initial: AlertListResponse;
  initialRules: AlertRuleDto[];
  initialUserId: string;
}) {
  const [tab, setTab] = useState<"queue" | "rules">("queue");
  const [rows, setRows] = useState<AlertDto[]>(initial.entries);
  const [total, setTotal] = useState(initial.total);
  const [counts, setCounts] = useState<AlertSummary | null>(initial.counts);
  const [rules, setRules] = useState<AlertRuleDto[]>(initialRules);
  const [status, setStatus] = useState<StatusKey>("active");
  const [severity, setSeverity] = useState<"" | (typeof SEVERITY_PILLS)[number]>("");
  const [kind, setKind] = useState("");
  const [assignee, setAssignee] = useState<AssigneeKey>("");
  const [userId, setUserId] = useState(initialUserId);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sweepMsg, setSweepMsg] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);

  const queryString = useMemo(() => {
    const p = new URLSearchParams({ status, limit: "200" });
    if (severity) p.set("severity", severity);
    if (kind) p.set("kind", kind);
    if (assignee) p.set("assignee", assignee);
    if (userId.trim()) p.set("userId", userId.trim());
    if (q.trim()) p.set("q", q.trim());
    return p.toString();
  }, [status, severity, kind, assignee, userId, q]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await clientApi<AlertListResponse>(`/admin/riskzilla/alerts?${queryString}`);
      setRows(res.entries);
      setTotal(res.total);
      setCounts(res.counts);
      setLastLoaded(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFetchError ? e.body.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    const t = setTimeout(() => void reload(), 150);
    return () => clearTimeout(t);
  }, [reload]);

  useEffect(() => {
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [reload]);

  async function runSweep() {
    setSweepMsg("Running…");
    try {
      const r = await clientApi<{ ran: number; inserted: number; bumped: number; failed: string[] }>(
        "/admin/riskzilla/alerts/sweep",
        { method: "POST", body: "{}" },
      );
      setSweepMsg(
        `${r.ran} rules · ${r.inserted} new · ${r.bumped} re-seen${r.failed.length ? ` · failed: ${r.failed.join(", ")}` : ""}`,
      );
      await reload();
      const rr = await clientApi<{ rules: AlertRuleDto[] }>("/admin/riskzilla/alerts/rules");
      setRules(rr.rules);
    } catch (e) {
      setSweepMsg(e instanceof ApiFetchError ? e.body.message : "sweep failed");
    }
  }

  const replaceRow = (a: AlertDto) => setRows((rs) => rs.map((r) => (r.id === a.id ? a : r)));

  return (
    <div className="flex flex-col gap-5">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <Kpi label="Critical" value={counts?.critical ?? 0} color={SEVERITY_COLOR.critical!} />
        <Kpi label="Serious" value={counts?.serious ?? 0} color={SEVERITY_COLOR.serious!} />
        <Kpi label="Warning" value={counts?.warning ?? 0} color={SEVERITY_COLOR.warning!} />
        <Kpi label="Open" value={counts?.open ?? 0} />
        <Kpi label="Acknowledged" value={counts?.acknowledged ?? 0} />
        <Kpi label="Assigned to me" value={counts?.assignedToMe ?? 0} />
        <Kpi label="Resolved 24h" value={counts?.resolved24h ?? 0} />
      </section>

      <nav className="flex gap-1 border-b border-[var(--color-border)]">
        {(
          [
            { key: "queue", label: `Queue${total ? ` · ${total}` : ""}` },
            { key: "rules", label: `Rules · ${rules.length}` },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              "-mb-px border-b-2 px-3 py-2 text-sm " +
              (tab === t.key
                ? "border-[var(--color-fg)] text-[var(--color-fg)]"
                : "border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
            }
          >
            {t.label}
          </button>
        ))}
        <span className="flex-1" />
        <div className="flex items-center gap-2 pb-1 text-xs text-[var(--color-fg-muted)]">
          {sweepMsg ? <span>{sweepMsg}</span> : null}
          <button
            type="button"
            onClick={() => void runSweep()}
            className="h-8 rounded-[6px] border border-[var(--color-border-strong)] px-3 text-xs uppercase tracking-[0.12em] text-[var(--color-fg)]"
          >
            Run sweep now
          </button>
        </div>
      </nav>

      {tab === "rules" ? (
        <RulesEditor
          rules={rules}
          onSaved={(r) => setRules((rs) => rs.map((x) => (x.kind === r.kind ? r : x)))}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <PillRow>
              {STATUS_PILLS.map((p) => (
                <Pill key={p.key} active={status === p.key} onClick={() => setStatus(p.key)}>
                  {p.label}
                </Pill>
              ))}
            </PillRow>
            <Divider />
            <PillRow>
              {SEVERITY_PILLS.map((s) => (
                <Pill
                  key={s}
                  active={severity === s}
                  color={SEVERITY_COLOR[s]}
                  onClick={() => setSeverity(severity === s ? "" : s)}
                >
                  {s}
                </Pill>
              ))}
            </PillRow>
            <Divider />
            <PillRow>
              {(
                [
                  { key: "me", label: "Mine" },
                  { key: "unassigned", label: "Unassigned" },
                ] as const
              ).map((p) => (
                <Pill key={p.key} active={assignee === p.key} onClick={() => setAssignee(assignee === p.key ? "" : p.key)}>
                  {p.label}
                </Pill>
              ))}
            </PillRow>
          </div>

          <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Rule">
              <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass}>
                <option value="">Any rule</option>
                {rules.map((r) => (
                  <option key={r.kind} value={r.kind}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Bettor ID">
              <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="uuid" className={inputClass + " font-mono"} spellCheck={false} />
            </Field>
            <Field label="Search title / bettor / ticket id">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…" className={inputClass} spellCheck={false} />
            </Field>
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => void reload()}
                disabled={loading}
                className="h-8 rounded-[6px] border border-[var(--color-border-strong)] px-3 text-xs uppercase tracking-[0.12em] disabled:opacity-50"
              >
                {loading ? "Loading…" : "Refresh"}
              </button>
              <span className="pb-2 text-[11px] text-[var(--color-fg-subtle)]">
                {total} alert{total === 1 ? "" : "s"}
                {lastLoaded ? ` · as of ${lastLoaded.toLocaleTimeString()}` : ""} · auto 30s
              </span>
            </div>
          </section>

          {error ? <p className="text-sm text-[var(--color-negative)]">{error}</p> : null}

          {rows.length === 0 ? (
            <p className="card p-6 text-sm text-[var(--color-fg-muted)]">
              {status === "active" && !severity && !kind && !q && !userId && !assignee
                ? "Nothing active. The sweeper runs every minute; use \"Run sweep now\" after tuning a rule."
                : "No alerts match these filters."}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {rows.map((a) => (
                <AlertRow key={a.id} alert={a} onChange={replaceRow} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Row ───────────────────────────────────────────────────────────────

function AlertRow({ alert, onChange }: { alert: AlertDto; onChange: (a: AlertDto) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<AlertEventDto[] | null>(null);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const color = SEVERITY_COLOR[alert.severity] ?? "var(--color-fg)";
  const resolved = alert.status === "resolved";

  const loadEvents = useCallback(async () => {
    try {
      const r = await clientApi<{ alert: AlertDto; events: AlertEventDto[] }>(`/admin/riskzilla/alerts/${alert.id}`);
      setEvents(r.events);
    } catch {
      setEvents([]);
    }
  }, [alert.id]);

  useEffect(() => {
    if (expanded && events === null) void loadEvents();
  }, [expanded, events, loadEvents]);

  function act(path: string, body?: Record<string, unknown>) {
    setErr(null);
    startTransition(async () => {
      try {
        const r = await clientApi<{ alert: AlertDto }>(`/admin/riskzilla/alerts/${alert.id}/${path}`, {
          method: "POST",
          body: JSON.stringify(body ?? {}),
        });
        onChange(r.alert);
        setNote("");
        if (expanded) await loadEvents();
      } catch (e) {
        setErr(e instanceof ApiFetchError ? e.body.message : "action failed");
      }
    });
  }

  const subject = alert.subjectNickname ?? alert.subjectEmail;

  return (
    <div
      className="card"
      style={{ borderLeft: `4px solid ${resolved ? "var(--color-border)" : color}`, opacity: resolved ? 0.75 : 1 }}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <span
          className="mono rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]"
          style={{ borderColor: color, color }}
        >
          {alert.severity}
        </span>
        <span className="mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
          {alert.kindLabel}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="min-w-0 flex-1 text-left text-sm font-medium hover:underline"
          style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", color: "var(--color-fg)" }}
          title={expanded ? "Collapse" : "Expand"}
        >
          {alert.title}
        </button>
        {alert.subjectUserId ? (
          <span className="flex items-center gap-1.5 text-xs">
            <Link href={`/admin/users/${alert.subjectUserId}`} className="text-[var(--color-accent)] hover:underline">
              {subject ?? alert.subjectUserId.slice(0, 8)}
            </Link>
            {alert.subjectLabels.filter(isLabel).map((l) => (
              <LabelChip key={l} label={l} />
            ))}
          </span>
        ) : alert.matchLabel ? (
          <span className="text-xs text-[var(--color-fg-muted)]">{alert.matchLabel}</span>
        ) : null}
        {alert.amountMicro ? (
          <span className="mono text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
            {fromMicroMoney(BigInt(alert.amountMicro))} {alert.currency ?? ""}
          </span>
        ) : null}
        <span className="text-[11px] text-[var(--color-fg-subtle)]" title={`first ${new Date(alert.firstSeenAt).toLocaleString()}`}>
          {alert.occurrences > 1 ? `×${alert.occurrences} · ` : ""}
          {ago(alert.lastSeenAt)}
        </span>
        <StatusBadge status={alert.status} />
        <span className="text-[11px] text-[var(--color-fg-muted)]">
          {alert.assigneeEmail ? `→ ${alert.assigneeEmail}` : "unassigned"}
          {alert.commentCount > 0 ? ` · ${alert.commentCount} comment${alert.commentCount === 1 ? "" : "s"}` : ""}
        </span>
        <div className="flex items-center gap-1.5">
          {alert.status === "open" ? (
            <ActionButton onClick={() => act("acknowledge")} disabled={pending} primary>
              Acknowledge
            </ActionButton>
          ) : null}
          {!resolved ? (
            <ActionButton
              onClick={() => act("assign", { assigneeId: alert.assignedTo ? null : "me" })}
              disabled={pending}
            >
              {alert.assignedTo ? "Unassign" : "Assign to me"}
            </ActionButton>
          ) : null}
          {!resolved ? (
            <ActionButton
              onClick={() => {
                const n = window.prompt("Resolution note (optional)", note);
                if (n === null) return;
                act("resolve", { note: n });
              }}
              disabled={pending}
            >
              Resolve
            </ActionButton>
          ) : (
            <ActionButton onClick={() => act("reopen")} disabled={pending}>
              Reopen
            </ActionButton>
          )}
        </div>
      </div>

      {err ? <p className="px-4 pb-2 text-xs text-[var(--color-negative)]">{err}</p> : null}

      {expanded ? (
        <div className="grid gap-4 border-t border-[var(--color-border)] px-4 py-4 lg:grid-cols-2">
          <div className="flex flex-col gap-3 text-sm">
            {alert.body ? <p>{alert.body}</p> : null}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-[var(--color-fg-subtle)]">Alert</dt>
              <dd className="font-mono">#{alert.id} · {alert.kind}</dd>
              <dt className="text-[var(--color-fg-subtle)]">First seen</dt>
              <dd>{new Date(alert.firstSeenAt).toLocaleString()}</dd>
              <dt className="text-[var(--color-fg-subtle)]">Last seen</dt>
              <dd>{new Date(alert.lastSeenAt).toLocaleString()} ({alert.occurrences}×)</dd>
              {alert.ticketId ? (
                <>
                  <dt className="text-[var(--color-fg-subtle)]">Ticket</dt>
                  <dd>
                    <Link href={`/admin/riskzilla/bets?ticketIds=${alert.ticketId}`} className="font-mono text-[var(--color-accent)] hover:underline">
                      {alert.ticketId}
                    </Link>
                  </dd>
                </>
              ) : null}
              {alert.matchId ? (
                <>
                  <dt className="text-[var(--color-fg-subtle)]">Match</dt>
                  <dd>
                    <Link href={`/admin/logs/matches/${alert.matchId}`} className="text-[var(--color-accent)] hover:underline">
                      {alert.matchLabel ?? alert.matchId}
                    </Link>
                  </dd>
                </>
              ) : null}
              {alert.acknowledgedAt ? (
                <>
                  <dt className="text-[var(--color-fg-subtle)]">Acknowledged</dt>
                  <dd>{new Date(alert.acknowledgedAt).toLocaleString()} {alert.acknowledgedByEmail ? `by ${alert.acknowledgedByEmail}` : ""}</dd>
                </>
              ) : null}
              {alert.resolvedAt ? (
                <>
                  <dt className="text-[var(--color-fg-subtle)]">Resolved</dt>
                  <dd>
                    {new Date(alert.resolvedAt).toLocaleString()} {alert.resolvedByEmail ? `by ${alert.resolvedByEmail}` : ""}
                    {alert.resolution ? <span className="block text-[var(--color-fg-muted)]">{alert.resolution}</span> : null}
                  </dd>
                </>
              ) : null}
            </dl>
            <details>
              <summary className="cursor-pointer text-xs text-[var(--color-fg-muted)]">Payload</summary>
              <pre className="mt-1 overflow-x-auto rounded-[6px] border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[11px] text-[var(--color-fg-muted)]">
                {JSON.stringify(alert.payload, null, 2)}
              </pre>
            </details>
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">Timeline</h3>
            {events === null ? (
              <p className="text-xs text-[var(--color-fg-muted)]">Loading…</p>
            ) : (
              <ol className="flex flex-col gap-2 text-xs">
                {events.map((e) => (
                  <li key={e.id} className="flex gap-3">
                    <span className="w-32 shrink-0 text-[var(--color-fg-subtle)]">{new Date(e.createdAt).toLocaleString()}</span>
                    <span className="mono w-24 shrink-0 uppercase tracking-[0.08em] text-[var(--color-fg-muted)]">{e.kind}</span>
                    <span className="min-w-0">
                      {e.actorEmail ? <span className="text-[var(--color-fg-muted)]">{e.actorEmail}: </span> : null}
                      {e.note ?? (e.kind === "assigned" ? (e.meta.assigneeId ? "assigned" : "unassigned") : "")}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <form
              onSubmit={(ev) => {
                ev.preventDefault();
                if (note.trim()) act("comment", { note: note.trim() });
              }}
              className="flex gap-2"
            >
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add a comment for the desk…"
                className={inputClass + " flex-1"}
                maxLength={2000}
              />
              <button
                type="submit"
                disabled={pending || !note.trim()}
                className="h-8 rounded-[6px] border border-[var(--color-border-strong)] px-3 text-xs uppercase tracking-[0.12em] disabled:opacity-50"
              >
                Comment
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Bits ──────────────────────────────────────────────────────────────

const inputClass =
  "h-8 w-full rounded-[6px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-2 text-sm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">{label}</span>
      {children}
    </label>
  );
}

function Kpi({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="card p-3">
      <p className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">{label}</p>
      <p className="mono mt-1 text-xl" style={{ color: value > 0 ? color : undefined, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: AlertDto["status"] }) {
  const color =
    status === "open" ? "#dc2626" : status === "acknowledged" ? "#2563eb" : "var(--color-fg-muted)";
  return (
    <span className="mono text-[10px] uppercase tracking-[0.12em]" style={{ color }}>
      {status}
    </span>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "h-7 rounded-[6px] border px-2.5 text-[11px] uppercase tracking-[0.1em] disabled:opacity-50 " +
        (primary
          ? "border-[var(--color-accent)] text-[var(--color-accent)]"
          : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
      }
    >
      {children}
    </button>
  );
}

function PillRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-1">{children}</div>;
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-[var(--color-border)]" />;
}

function Pill({
  children,
  active,
  onClick,
  color,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 rounded-full border px-3 text-xs capitalize"
      style={{
        borderColor: active ? (color ?? "var(--color-fg)") : "var(--color-border)",
        background: active ? (color ?? "var(--color-fg)") : "var(--color-bg-subtle)",
        color: active ? "#fff" : "var(--color-fg)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
