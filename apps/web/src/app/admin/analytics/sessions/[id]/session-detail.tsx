"use client";

// Per-session journey view: header facts, the exact click-ordered event
// timeline (client seq), and an SVG mouse-trail replay per visited page
// with click markers overlaid. Trails are fetched lazily per path — the
// points tables can be large.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type {
  AdminAnalyticsMouseTrail,
  AdminAnalyticsSessionDetail,
} from "@oddzilla/types";
import { clientApi } from "@/lib/api-client";

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function offsetLabel(startIso: string, iso: string): string {
  const ms = new Date(iso).getTime() - new Date(startIso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const KIND_TONE: Record<string, string> = {
  page_view: "var(--color-accent, #7c6f57)",
  click: "var(--color-positive, #16a34a)",
  heartbeat: "var(--color-fg-subtle, #9a938a)",
  session_end: "var(--color-negative, #c1342f)",
};

export function SessionDetail({ id }: { id: string }) {
  const [data, setData] = useState<AdminAnalyticsSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHeartbeats, setShowHeartbeats] = useState(false);

  useEffect(() => {
    let cancelled = false;
    clientApi<AdminAnalyticsSessionDetail>(`/admin/analytics/sessions/${id}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const visibleEvents = useMemo(() => {
    if (!data) return [];
    return showHeartbeats
      ? data.events
      : data.events.filter((e) => e.kind !== "heartbeat");
  }, [data, showHeartbeats]);

  return (
    <div>
      <div className="flex items-center gap-3 text-sm">
        <Link
          href="/admin/analytics"
          className="text-[var(--color-fg-muted)] underline decoration-[var(--color-border)] underline-offset-4 hover:decoration-current"
        >
          Analytics
        </Link>
        <span className="text-[var(--color-fg-subtle)]">/</span>
        <span className="mono text-xs">{id}</span>
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
          <SessionHeader data={data} />
          <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <section className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">
                  Journey ({visibleEvents.length} events)
                </h2>
                <label className="flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
                  <input
                    type="checkbox"
                    checked={showHeartbeats}
                    onChange={(e) => setShowHeartbeats(e.target.checked)}
                  />
                  heartbeats
                </label>
              </div>
              <Timeline data={data} events={visibleEvents} />
            </section>
            <MouseReplay sessionId={id} data={data} />
          </div>
        </>
      )}
    </div>
  );
}

function SessionHeader({ data }: { data: AdminAnalyticsSessionDetail }) {
  const s = data.session;
  const facts: { label: string; value: string }[] = [
    { label: "User", value: s.userEmail ?? "anonymous" },
    { label: "Started", value: new Date(s.startedAt).toLocaleString() },
    { label: "Duration", value: formatDuration(s.durationSeconds) },
    { label: "Views / clicks", value: `${s.pageViewCount} / ${s.clickCount}` },
    { label: "Entry", value: s.entryPath ?? "—" },
    { label: "Exit", value: s.exitPath ?? "—" },
    {
      label: "Viewport",
      value: s.viewportW && s.viewportH ? `${s.viewportW}×${s.viewportH}` : "—",
    },
    { label: "Referrer", value: s.referrer || "—" },
  ];
  return (
    <div className="mt-4">
      <h1 className="text-2xl font-semibold tracking-tight">Session journey</h1>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {facts.map((f) => (
          <div
            key={f.label}
            className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] px-4 py-3"
          >
            <div className="text-[11px] uppercase tracking-wider text-[var(--color-fg-subtle)] mono">
              {f.label}
            </div>
            <div className="mt-0.5 truncate text-sm" title={f.value}>
              {f.value}
            </div>
          </div>
        ))}
      </div>
      {s.userAgent && (
        <p className="mt-2 truncate text-xs text-[var(--color-fg-subtle)] mono" title={s.userAgent}>
          {s.userAgent}
        </p>
      )}
    </div>
  );
}

function Timeline({
  data,
  events,
}: {
  data: AdminAnalyticsSessionDetail;
  events: AdminAnalyticsSessionDetail["events"];
}) {
  if (events.length === 0) {
    return <p className="mt-3 text-sm text-[var(--color-fg-muted)]">No events.</p>;
  }
  return (
    <ol className="mt-3 flex max-h-[560px] flex-col gap-0 overflow-y-auto">
      {events.map((e) => {
        const payload = e.payload as { label?: string; x?: number; y?: number } | null;
        return (
          <li
            key={e.seq}
            className="flex items-baseline gap-3 border-t border-[var(--color-border)] py-1.5 first:border-t-0"
          >
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-[var(--color-fg-subtle)] mono">
              {offsetLabel(data.session.startedAt, e.occurredAt)}
            </span>
            <span
              aria-hidden
              className="mt-1 h-2 w-2 shrink-0 self-center rounded-full"
              style={{ background: KIND_TONE[e.kind] ?? "var(--color-fg-subtle)" }}
            />
            <span className="w-20 shrink-0 text-xs mono text-[var(--color-fg-muted)]">
              {e.kind}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs">
              {e.kind === "click" && payload?.label ? (
                <>
                  <span className="mono">{payload.label}</span>
                  <span className="text-[var(--color-fg-subtle)]"> on {e.path}</span>
                </>
              ) : (
                <span className="mono">{e.path ?? ""}</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function MouseReplay({
  sessionId,
  data,
}: {
  sessionId: string;
  data: AdminAnalyticsSessionDetail;
}) {
  const paths = data.mousePaths;
  const [selected, setSelected] = useState<string | null>(paths[0]?.path ?? null);
  const [trails, setTrails] = useState<AdminAnalyticsMouseTrail[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    setTrails(null);
    clientApi<{ trails: AdminAnalyticsMouseTrail[] }>(
      `/admin/analytics/sessions/${sessionId}/mouse?path=${encodeURIComponent(selected)}`,
    )
      .then((res) => {
        if (!cancelled) setTrails(res.trails);
      })
      .catch(() => {
        if (!cancelled) setTrails([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, selected]);

  const clicksOnPath = useMemo(
    () =>
      data.events.filter(
        (e) => e.kind === "click" && e.path === selected && e.payload,
      ) as { payload: { x?: number; y?: number } }[],
    [data.events, selected],
  );

  if (paths.length === 0) {
    return (
      <section className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
        <h2 className="text-sm font-medium">Mouse trails</h2>
        <p className="mt-3 text-sm text-[var(--color-fg-muted)]">
          No mouse trails captured for this session (touch device, or trails past the
          14-day retention).
        </p>
      </section>
    );
  }

  const vw = trails?.[0]?.viewportW ?? data.session.viewportW ?? 1280;
  const vh = trails?.[0]?.viewportH ?? data.session.viewportH ?? 800;

  return (
    <section className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
      <h2 className="text-sm font-medium">Mouse trails</h2>
      <div className="mt-2 flex flex-wrap gap-1">
        {paths.map((p) => (
          <button
            key={p.path}
            type="button"
            onClick={() => setSelected(p.path)}
            className="max-w-[240px] truncate rounded-full border px-3 py-1 text-xs mono"
            title={`${p.path} — ${p.pointCount} points`}
            style={{
              borderColor: "var(--color-border)",
              background: selected === p.path ? "var(--color-bg-subtle)" : "transparent",
              color: selected === p.path ? "var(--color-fg)" : "var(--color-fg-muted)",
            }}
          >
            {p.path}
          </button>
        ))}
      </div>

      {loading && <p className="mt-3 text-sm text-[var(--color-fg-muted)]">Loading…</p>}

      {trails && trails.length > 0 && (
        <div className="mt-3">
          <svg
            viewBox={`0 0 ${vw} ${vh}`}
            className="w-full rounded-lg border border-[var(--color-border)]"
            style={{ background: "var(--color-bg-subtle)", maxHeight: 480 }}
          >
            {trails.map((t, ti) => {
              const pts = t.points.map(([, x, y]) => `${x},${y}`).join(" ");
              return (
                <g key={t.seq}>
                  <polyline
                    points={pts}
                    fill="none"
                    stroke="var(--color-accent, #7c6f57)"
                    strokeWidth={Math.max(1.5, vw / 900)}
                    strokeOpacity={0.35 + 0.5 * (ti / Math.max(1, trails.length - 1))}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {t.points.length > 0 && (
                    <circle
                      cx={t.points[0]![1]}
                      cy={t.points[0]![2]}
                      r={Math.max(2.5, vw / 500)}
                      fill="var(--color-accent, #7c6f57)"
                      fillOpacity={0.6}
                    />
                  )}
                </g>
              );
            })}
            {clicksOnPath.map((c, i) =>
              typeof c.payload.x === "number" && typeof c.payload.y === "number" ? (
                <circle
                  key={i}
                  cx={c.payload.x}
                  cy={c.payload.y}
                  r={Math.max(4, vw / 300)}
                  fill="none"
                  stroke="var(--color-negative, #c1342f)"
                  strokeWidth={Math.max(1.5, vw / 800)}
                />
              ) : null,
            )}
          </svg>
          <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
            {trails.length} trail segment{trails.length === 1 ? "" : "s"}, drawn light →
            dark in time order; red rings are clicks. Coordinates are viewport-relative
            ({vw}×{vh}) — scroll position isn't replayed.
          </p>
        </div>
      )}
      {trails && trails.length === 0 && !loading && (
        <p className="mt-3 text-sm text-[var(--color-fg-muted)]">No trails for this page.</p>
      )}
    </section>
  );
}
