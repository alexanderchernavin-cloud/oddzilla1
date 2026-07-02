"use client";

// FE analytics dashboard. Range-selectable overview of the first-party
// tracker's dataset: session/engagement KPIs, sessions-per-day bars,
// popular sections + pages, top clicked elements, and a recent-sessions
// table linking into the per-session journey view.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type {
  AdminAnalyticsOverview,
  AdminAnalyticsSessionSummary,
} from "@oddzilla/types";
import { clientApi } from "@/lib/api-client";

const RANGES = [1, 7, 30, 90] as const;

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  if (m > 0) return `${m}m ${rest}s`;
  return `${rest}s`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AnalyticsOverview() {
  const [days, setDays] = useState<number>(7);
  const [data, setData] = useState<AdminAnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<AdminAnalyticsSessionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    clientApi<AdminAnalyticsOverview>(`/admin/analytics/overview?days=${days}`)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const loadSessions = useCallback(
    async (reset: boolean, cursorArg?: string | null) => {
      setLoadingSessions(true);
      try {
        const params = new URLSearchParams({ days: String(days) });
        if (q.trim()) params.set("q", q.trim());
        if (!reset && cursorArg) params.set("cursor", cursorArg);
        const res = await clientApi<{
          sessions: AdminAnalyticsSessionSummary[];
          nextCursor: string | null;
        }>(`/admin/analytics/sessions?${params.toString()}`);
        setSessions((prev) => (reset ? res.sessions : [...prev, ...res.sessions]));
        setCursor(res.nextCursor);
      } catch {
        // Table just stops growing on a transient failure.
      } finally {
        setLoadingSessions(false);
      }
    },
    [days, q],
  );

  // Intentionally keyed on the range only — the search input applies on
  // submit, not per keystroke.
  useEffect(() => {
    void loadSessions(true);
  }, [days]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            First-party storefront analytics — sessions, journeys, clicks and mouse
            trails. Admin traffic is excluded; mouse trails keep 14 days, everything
            else 90.
          </p>
        </div>
        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setDays(r)}
              className="rounded-full border px-3 py-1 text-xs mono"
              style={{
                borderColor: "var(--color-border)",
                background: days === r ? "var(--color-bg-subtle)" : "transparent",
                color: days === r ? "var(--color-fg)" : "var(--color-fg-muted)",
                fontWeight: days === r ? 600 : 400,
              }}
            >
              {r === 1 ? "24h" : `${r}d`}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mt-6 rounded-[14px] border border-[var(--color-negative)] bg-[var(--color-bg-card)] p-4 text-sm text-[var(--color-negative)]">
          {error}
        </div>
      )}

      {!data && !error && (
        <div className="mt-6 text-sm text-[var(--color-fg-muted)]">Loading…</div>
      )}

      {data && (
        <>
          <KpiGrid data={data} />
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <SessionsPerDay data={data} />
            <TopSections data={data} />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <RankTable
              title="Top pages"
              rows={data.topPaths.map((p) => ({ label: p.path, value: p.views }))}
              valueLabel="views"
            />
            <RankTable
              title="Top clicked elements"
              rows={data.topClickTargets.map((c) => ({ label: c.label, value: c.clicks }))}
              valueLabel="clicks"
            />
          </div>
        </>
      )}

      <SessionsTable
        sessions={sessions}
        cursor={cursor}
        loading={loadingSessions}
        q={q}
        onQChange={setQ}
        onSearch={() => void loadSessions(true)}
        onLoadMore={() => void loadSessions(false, cursor)}
      />
    </div>
  );
}

function KpiGrid({ data }: { data: AdminAnalyticsOverview }) {
  const t = data.totals;
  const kpis: { label: string; value: string; hint?: string }[] = [
    { label: "Sessions", value: t.sessions.toLocaleString() },
    {
      label: "Signed-in sessions",
      value: t.identifiedSessions.toLocaleString(),
      hint: t.sessions > 0 ? `${Math.round((t.identifiedSessions / t.sessions) * 100)}%` : undefined,
    },
    { label: "Unique users", value: t.uniqueUsers.toLocaleString() },
    { label: "Page views", value: t.pageViews.toLocaleString() },
    { label: "Clicks", value: t.clicks.toLocaleString() },
    {
      label: "Avg session",
      value: formatDuration(t.avgSessionSeconds),
      hint: `median ${formatDuration(t.medianSessionSeconds)}`,
    },
  ];
  return (
    <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {kpis.map((k) => (
        <div
          key={k.label}
          className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4"
        >
          <div className="text-[11px] uppercase tracking-wider text-[var(--color-fg-subtle)] mono">
            {k.label}
          </div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{k.value}</div>
          {k.hint && (
            <div className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{k.hint}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function SessionsPerDay({ data }: { data: AdminAnalyticsOverview }) {
  const rows = data.sessionsPerDay;
  const max = Math.max(1, ...rows.map((r) => r.sessions));
  return (
    <section className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
      <h2 className="text-sm font-medium">Sessions per day</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-fg-muted)]">No data yet.</p>
      ) : (
        <div className="mt-3 flex items-end gap-1" style={{ height: 120 }}>
          {rows.map((r) => (
            <div
              key={r.day}
              className="flex-1"
              title={`${r.day}: ${r.sessions} sessions, ${r.pageViews} views`}
              style={{
                height: `${Math.max(3, (r.sessions / max) * 100)}%`,
                background: "var(--color-accent, #7c6f57)",
                opacity: 0.85,
                borderRadius: 3,
                minWidth: 3,
              }}
            />
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <div className="mt-2 flex justify-between text-[10px] text-[var(--color-fg-subtle)] mono">
          <span>{rows[0]?.day}</span>
          <span>{rows[rows.length - 1]?.day}</span>
        </div>
      )}
    </section>
  );
}

function TopSections({ data }: { data: AdminAnalyticsOverview }) {
  return (
    <section className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
      <h2 className="text-sm font-medium">Popular sections</h2>
      {data.topSections.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-fg-muted)]">No data yet.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {data.topSections.map((s) => (
            <div key={s.section} className="flex items-center gap-3">
              <div className="w-28 truncate text-xs mono">{s.section}</div>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-bg-subtle)]">
                <div
                  style={{
                    width: `${Math.max(1, Math.round(s.share * 100))}%`,
                    height: "100%",
                    background: "var(--color-accent, #7c6f57)",
                  }}
                />
              </div>
              <div className="w-20 text-right text-xs tabular-nums text-[var(--color-fg-muted)]">
                {s.views.toLocaleString()}{" "}
                <span className="text-[var(--color-fg-subtle)]">
                  ({Math.round(s.share * 100)}%)
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RankTable({
  title,
  rows,
  valueLabel,
}: {
  title: string;
  rows: { label: string; value: number }[];
  valueLabel: string;
}) {
  return (
    <section className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-fg-muted)]">No data yet.</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.label}-${i}`} className="border-t border-[var(--color-border)] first:border-t-0">
                <td className="max-w-0 truncate py-1.5 pr-3 mono text-xs" title={r.label}>
                  {r.label}
                </td>
                <td className="w-24 py-1.5 text-right text-xs tabular-nums text-[var(--color-fg-muted)]">
                  {r.value.toLocaleString()} {valueLabel}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function SessionsTable({
  sessions,
  cursor,
  loading,
  q,
  onQChange,
  onSearch,
  onLoadMore,
}: {
  sessions: AdminAnalyticsSessionSummary[];
  cursor: string | null;
  loading: boolean;
  q: string;
  onQChange: (v: string) => void;
  onSearch: () => void;
  onLoadMore: () => void;
}) {
  return (
    <section className="mt-6 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Recent sessions</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSearch();
          }}
          className="flex items-center gap-2"
        >
          <input
            value={q}
            onChange={(e) => onQChange(e.target.value)}
            placeholder="Email or session/user id"
            className="rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-1.5 text-xs"
            style={{ width: 220 }}
          />
          <button
            type="submit"
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs"
          >
            Search
          </button>
        </form>
      </div>

      {sessions.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-fg-muted)]">
          {loading ? "Loading…" : "No sessions in range."}
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--color-fg-subtle)] mono">
                <th className="py-1.5 pr-3">Started</th>
                <th className="py-1.5 pr-3">User</th>
                <th className="py-1.5 pr-3">Duration</th>
                <th className="py-1.5 pr-3">Entry</th>
                <th className="py-1.5 pr-3">Exit</th>
                <th className="py-1.5 pr-3 text-right">Views</th>
                <th className="py-1.5 pr-3 text-right">Clicks</th>
                <th className="py-1.5 pr-3 text-right">Mouse</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-t border-[var(--color-border)]">
                  <td className="py-2 pr-3 text-xs tabular-nums">{formatTime(s.startedAt)}</td>
                  <td className="max-w-[180px] truncate py-2 pr-3 text-xs" title={s.userEmail ?? undefined}>
                    {s.userEmail ?? <span className="text-[var(--color-fg-subtle)]">anonymous</span>}
                  </td>
                  <td className="py-2 pr-3 text-xs tabular-nums">
                    {formatDuration(s.durationSeconds)}
                  </td>
                  <td className="max-w-[160px] truncate py-2 pr-3 text-xs mono" title={s.entryPath ?? undefined}>
                    {s.entryPath ?? "—"}
                  </td>
                  <td className="max-w-[160px] truncate py-2 pr-3 text-xs mono" title={s.exitPath ?? undefined}>
                    {s.exitPath ?? "—"}
                  </td>
                  <td className="py-2 pr-3 text-right text-xs tabular-nums">{s.pageViewCount}</td>
                  <td className="py-2 pr-3 text-right text-xs tabular-nums">{s.clickCount}</td>
                  <td className="py-2 pr-3 text-right text-xs tabular-nums">{s.mouseBatchCount}</td>
                  <td className="py-2 text-right">
                    <Link
                      href={`/admin/analytics/sessions/${s.id}`}
                      className="text-xs underline decoration-[var(--color-border)] underline-offset-4 hover:decoration-current"
                    >
                      Journey
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cursor && (
        <div className="mt-3">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}
