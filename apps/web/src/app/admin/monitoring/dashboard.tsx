"use client";

// Performance monitoring page for the backoffice. Polls
// `/admin/monitoring/snapshot` every 5 s for the live KPI tiles and
// container health table; pulls `/admin/monitoring/history?hours=24`
// once on mount + every 60 s for the three time-series charts.
//
// Severity model. Each metric has two thresholds — `warn` and
// `danger` — picked off the post-mortem incidents we've actually had
// on this Hetzner box: build-OOM (memory + swap), the disk-full
// outage that motivated this whole feature (disk), and the
// CPU-pegged-at-200% disk-full follow-on (load1 vs cpu count). The
// banner at the top reflects the highest severity across host metrics
// PLUS the container health column, so a restart-looping postgres
// surfaces even when host metrics look fine.
//
// No backend tests cover this page; the verification is "open it on
// prod and confirm the numbers match `df -h /` + `free -m` +
// `docker compose ps`".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clientApi } from "@/lib/api-client";

// ── Data shapes (mirror services/api/src/modules/admin/monitoring.ts) ──
interface HostSnapshot {
  uptimeSec: number;
  cpuCount: number;
  loadAvg: { m1: number; m5: number; m15: number };
  cpuPct: number | null;
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPct: number;
  };
  swap: { totalBytes: number; usedBytes: number; usedPct: number };
  disk: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPct: number;
  };
}

interface ContainerSnapshot {
  name: string;
  image: string;
  state: string;
  status: string;
  health: "healthy" | "unhealthy" | "starting" | "none";
  createdAt: number;
}

interface CollectorSnapshot {
  ts: number;
  host: HostSnapshot;
  containers: ContainerSnapshot[];
}

interface SampleRow {
  ts: number;
  diskPct: number;
  memPct: number;
  swapPct: number;
  cpuPct: number | null;
  load1: number;
  containersHealthy: number;
  containersTotal: number;
}

interface HistoryResponse {
  samples: SampleRow[];
}

// ── Severity ────────────────────────────────────────────────────────────

type Severity = "ok" | "warn" | "danger";

// Thresholds informed by the disk-full + build-OOM + load-pegged
// incidents we've actually had on the box. Tighten over time as
// real signals emerge.
const THRESHOLDS = {
  diskPct: { warn: 70, danger: 85 },
  memPct: { warn: 75, danger: 90 },
  swapPct: { warn: 25, danger: 50 },
  cpuPct: { warn: 80, danger: 95 },
  loadPerCpu: { warn: 1.0, danger: 2.0 },
} as const;

function severity(value: number, t: { warn: number; danger: number }): Severity {
  if (value >= t.danger) return "danger";
  if (value >= t.warn) return "warn";
  return "ok";
}

function maxSeverity(...severities: Severity[]): Severity {
  if (severities.includes("danger")) return "danger";
  if (severities.includes("warn")) return "warn";
  return "ok";
}

const SEVERITY_TONE: Record<Severity, string> = {
  ok: "var(--color-positive, #16a34a)",
  warn: "#d97706",
  danger: "var(--color-negative, #dc2626)",
};

// ── Formatting helpers ──────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b == null || !Number.isFinite(b)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatUptime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "—";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

function formatRelative(unixSec: number): string {
  const delta = Math.floor(Date.now() / 1000) - unixSec;
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86_400)}d ago`;
}

// ── Component ───────────────────────────────────────────────────────────

const SNAPSHOT_INTERVAL_MS = 5_000;
const HISTORY_INTERVAL_MS = 60_000;

export function MonitoringDashboard() {
  const [snapshot, setSnapshot] = useState<CollectorSnapshot | null>(null);
  const [history, setHistory] = useState<SampleRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // Hold the last successful snapshot timestamp so the "last update"
  // line keeps reporting truthfully across transient errors.
  const lastSuccessRef = useRef<number | null>(null);

  const refreshSnapshot = useCallback(async () => {
    try {
      const s = await clientApi<CollectorSnapshot>(
        "/admin/monitoring/snapshot",
      );
      setSnapshot(s);
      setError(null);
      lastSuccessRef.current = s.ts;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const r = await clientApi<HistoryResponse>(
        "/admin/monitoring/history?hours=24",
      );
      setHistory(r.samples ?? []);
    } catch {
      // Don't clobber the snapshot error message; charts just stay
      // empty until next tick succeeds.
    }
  }, []);

  useEffect(() => {
    void refreshSnapshot();
    void refreshHistory();
    const s = setInterval(refreshSnapshot, SNAPSHOT_INTERVAL_MS);
    const h = setInterval(refreshHistory, HISTORY_INTERVAL_MS);
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(s);
      clearInterval(h);
      clearInterval(t);
    };
  }, [refreshSnapshot, refreshHistory]);

  const overallSeverity = useMemo<Severity>(() => {
    if (!snapshot) return "ok";
    const host = snapshot.host;
    const loadPerCpu = host.loadAvg.m1 / Math.max(1, host.cpuCount);
    const hostSev = maxSeverity(
      severity(host.disk.usedPct, THRESHOLDS.diskPct),
      severity(host.memory.usedPct, THRESHOLDS.memPct),
      severity(host.swap.usedPct, THRESHOLDS.swapPct),
      host.cpuPct == null ? "ok" : severity(host.cpuPct, THRESHOLDS.cpuPct),
      severity(loadPerCpu, THRESHOLDS.loadPerCpu),
    );
    const containerSev: Severity = snapshot.containers.some(
      (c) => c.state === "restarting" || c.health === "unhealthy",
    )
      ? "danger"
      : snapshot.containers.some(
            (c) => c.state !== "running" && c.state !== "exited",
          )
        ? "warn"
        : "ok";
    return maxSeverity(hostSev, containerSev);
  }, [snapshot]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Performance</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Host metrics + container health for the Oddzilla server. Polled live; thresholds tuned to the box's actual incident history.
          </p>
        </div>
      </div>

      <StatusBanner
        snapshot={snapshot}
        severity={overallSeverity}
        error={error}
        lastSuccessTs={lastSuccessRef.current}
        nowMs={now}
      />

      {snapshot && (
        <>
          <KpiGrid host={snapshot.host} containers={snapshot.containers} />
          <ChartsGrid history={history} />
          <ContainerTable containers={snapshot.containers} />
        </>
      )}
    </div>
  );
}

// ── Banner ──────────────────────────────────────────────────────────────

function StatusBanner({
  snapshot,
  severity: sev,
  error,
  lastSuccessTs,
  nowMs,
}: {
  snapshot: CollectorSnapshot | null;
  severity: Severity;
  error: string | null;
  lastSuccessTs: number | null;
  nowMs: number;
}) {
  const tone = SEVERITY_TONE[sev];
  let title: string;
  let detail: string;
  if (error && !snapshot) {
    title = "Metrics unavailable";
    detail = error;
  } else if (sev === "ok") {
    title = "All systems normal";
    detail = "Disk, memory, CPU, load and container health are within thresholds.";
  } else {
    title = sev === "danger" ? "Critical pressure" : "Approaching threshold";
    detail = summariseAlerts(snapshot);
  }
  const stale = lastSuccessTs && nowMs / 1000 - lastSuccessTs > 30;
  return (
    <section
      className="mt-6 flex items-start gap-3 rounded-[14px] border bg-[var(--color-bg-card)] p-4"
      style={{ borderColor: tone }}
    >
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          marginTop: 6,
          borderRadius: 999,
          background: tone,
          flexShrink: 0,
        }}
      />
      <div className="flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-base font-medium" style={{ color: tone }}>
            {title}
          </div>
          {snapshot && (
            <div className="text-xs text-[var(--color-fg-subtle)] mono">
              Updated {formatRelative(lastSuccessTs ?? snapshot.ts)}
              {stale ? " (stale)" : ""}
            </div>
          )}
        </div>
        <div className="mt-1 text-sm text-[var(--color-fg-muted)]">{detail}</div>
        {error && snapshot && (
          <div className="mt-2 text-xs text-[var(--color-negative)] mono">
            Last poll error: {error}
          </div>
        )}
      </div>
    </section>
  );
}

function summariseAlerts(s: CollectorSnapshot | null): string {
  if (!s) return "Waiting for first sample.";
  const parts: string[] = [];
  const host = s.host;
  const diskSev = severity(host.disk.usedPct, THRESHOLDS.diskPct);
  if (diskSev !== "ok") parts.push(`Disk ${formatPct(host.disk.usedPct)}`);
  const memSev = severity(host.memory.usedPct, THRESHOLDS.memPct);
  if (memSev !== "ok") parts.push(`Memory ${formatPct(host.memory.usedPct)}`);
  const swapSev = severity(host.swap.usedPct, THRESHOLDS.swapPct);
  if (swapSev !== "ok") parts.push(`Swap ${formatPct(host.swap.usedPct)}`);
  if (host.cpuPct != null) {
    const cpuSev = severity(host.cpuPct, THRESHOLDS.cpuPct);
    if (cpuSev !== "ok") parts.push(`CPU ${formatPct(host.cpuPct)}`);
  }
  const loadPerCpu = host.loadAvg.m1 / Math.max(1, host.cpuCount);
  const loadSev = severity(loadPerCpu, THRESHOLDS.loadPerCpu);
  if (loadSev !== "ok")
    parts.push(`Load ${host.loadAvg.m1.toFixed(2)} / ${host.cpuCount} cpu`);
  for (const c of s.containers) {
    if (c.state === "restarting") parts.push(`${c.name} restarting`);
    else if (c.health === "unhealthy") parts.push(`${c.name} unhealthy`);
    else if (c.state === "exited") parts.push(`${c.name} exited`);
  }
  if (parts.length === 0) return "All metrics within thresholds.";
  return parts.join(" · ");
}

// ── KPI Grid ────────────────────────────────────────────────────────────

function KpiGrid({
  host,
  containers,
}: {
  host: HostSnapshot;
  containers: ContainerSnapshot[];
}) {
  const loadPerCpu = host.loadAvg.m1 / Math.max(1, host.cpuCount);
  const diskSev = severity(host.disk.usedPct, THRESHOLDS.diskPct);
  const memSev = severity(host.memory.usedPct, THRESHOLDS.memPct);
  const swapSev = severity(host.swap.usedPct, THRESHOLDS.swapPct);
  const cpuSev =
    host.cpuPct == null ? "ok" : severity(host.cpuPct, THRESHOLDS.cpuPct);
  const loadSev = severity(loadPerCpu, THRESHOLDS.loadPerCpu);

  const healthy = containers.filter(
    (c) => c.state === "running" && (c.health === "healthy" || c.health === "none"),
  ).length;
  const total = containers.length;
  const containerSev: Severity =
    containers.some((c) => c.state === "restarting" || c.health === "unhealthy")
      ? "danger"
      : healthy < total
        ? "warn"
        : "ok";

  return (
    <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        label="Disk"
        value={formatPct(host.disk.usedPct, 1)}
        subtitle={`${formatBytes(host.disk.usedBytes)} of ${formatBytes(
          host.disk.totalBytes,
        )} used · ${formatBytes(host.disk.freeBytes)} free`}
        severity={diskSev}
      />
      <Kpi
        label="Memory"
        value={formatPct(host.memory.usedPct, 1)}
        subtitle={`${formatBytes(host.memory.usedBytes)} of ${formatBytes(
          host.memory.totalBytes,
        )} used`}
        severity={memSev}
      />
      <Kpi
        label="Swap"
        value={
          host.swap.totalBytes === 0 ? "—" : formatPct(host.swap.usedPct, 1)
        }
        subtitle={
          host.swap.totalBytes === 0
            ? "Not configured"
            : `${formatBytes(host.swap.usedBytes)} of ${formatBytes(
                host.swap.totalBytes,
              )} swapped`
        }
        severity={host.swap.totalBytes === 0 ? "ok" : swapSev}
      />
      <Kpi
        label="CPU"
        value={host.cpuPct == null ? "—" : formatPct(host.cpuPct, 1)}
        subtitle={
          host.cpuPct == null
            ? "Awaiting first sample"
            : `${host.cpuCount} cpu${host.cpuCount === 1 ? "" : "s"}`
        }
        severity={cpuSev}
      />
      <Kpi
        label="Load (1m)"
        value={host.loadAvg.m1.toFixed(2)}
        subtitle={`5m ${host.loadAvg.m5.toFixed(2)} · 15m ${host.loadAvg.m15.toFixed(2)} · ${host.cpuCount} cpu`}
        severity={loadSev}
      />
      <Kpi
        label="Containers"
        value={`${healthy}/${total}`}
        subtitle={
          containerSev === "ok"
            ? "All healthy"
            : containers
                .filter(
                  (c) =>
                    c.state !== "running" || c.health === "unhealthy",
                )
                .slice(0, 3)
                .map((c) =>
                  c.state === "restarting"
                    ? `${shortName(c.name)} restarting`
                    : c.health === "unhealthy"
                      ? `${shortName(c.name)} unhealthy`
                      : `${shortName(c.name)} ${c.state}`,
                )
                .join(" · ") || "Mixed states"
        }
        severity={containerSev}
      />
      <Kpi
        label="Uptime"
        value={formatUptime(host.uptimeSec)}
        subtitle={`Booted ${formatRelative(
          Math.floor(Date.now() / 1000) - host.uptimeSec,
        )}`}
      />
      <Kpi
        label="Free disk"
        value={formatBytes(host.disk.freeBytes)}
        subtitle="Headroom before postgres restart-loops"
        severity={diskSev}
      />
    </section>
  );
}

function Kpi({
  label,
  value,
  subtitle,
  severity: sev = "ok",
}: {
  label: string;
  value: string;
  subtitle?: string;
  severity?: Severity;
}) {
  const tone = SEVERITY_TONE[sev];
  return (
    <div
      className="rounded-[14px] border bg-[var(--color-bg-card)] p-4"
      style={{ borderColor: sev === "ok" ? "var(--color-border)" : tone }}
    >
      <div className="text-xs uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
        {label}
      </div>
      <div
        className="mt-1 text-2xl font-semibold tabular-nums"
        style={{ color: sev === "ok" ? "var(--color-fg)" : tone }}
      >
        {value}
      </div>
      {subtitle && (
        <div className="mt-1 text-xs text-[var(--color-fg-muted)]">{subtitle}</div>
      )}
    </div>
  );
}

// ── Charts ──────────────────────────────────────────────────────────────

function ChartsGrid({ history }: { history: SampleRow[] }) {
  return (
    <section className="mt-10">
      <header className="flex items-baseline justify-between">
        <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
          Last 24 hours
        </h2>
        <span className="text-xs text-[var(--color-fg-subtle)]">
          {history.length} samples
        </span>
      </header>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <ChartCard
          title="Disk usage"
          unit="%"
          values={history.map((s) => s.diskPct)}
          times={history.map((s) => s.ts)}
          thresholds={THRESHOLDS.diskPct}
          domainMin={0}
          domainMax={100}
        />
        <ChartCard
          title="Memory usage"
          unit="%"
          values={history.map((s) => s.memPct)}
          times={history.map((s) => s.ts)}
          thresholds={THRESHOLDS.memPct}
          domainMin={0}
          domainMax={100}
        />
        <ChartCard
          title="Load (1m)"
          unit=""
          values={history.map((s) => s.load1)}
          times={history.map((s) => s.ts)}
          thresholds={undefined}
          domainMin={0}
          domainMax={undefined}
        />
      </div>
    </section>
  );
}

function ChartCard({
  title,
  unit,
  values,
  times,
  thresholds,
  domainMin,
  domainMax,
}: {
  title: string;
  unit: string;
  values: number[];
  times: number[];
  thresholds?: { warn: number; danger: number };
  domainMin?: number;
  domainMax?: number;
}) {
  const last = values.length > 0 ? values[values.length - 1] : null;
  return (
    <div className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
          {title}
        </div>
        <div className="text-sm tabular-nums text-[var(--color-fg)]">
          {last == null ? "—" : `${last.toFixed(unit === "%" ? 1 : 2)}${unit}`}
        </div>
      </div>
      <LineChart
        values={values}
        times={times}
        thresholds={thresholds}
        domainMin={domainMin}
        domainMax={domainMax}
      />
    </div>
  );
}

// Pure-SVG line chart. Auto-scales y unless explicit domain is given;
// draws warn/danger horizontal bands when thresholds supplied. Empty
// data renders an empty plot box rather than collapsing — admins read
// "no samples yet" more easily than a missing chart.
function LineChart({
  values,
  times,
  thresholds,
  domainMin,
  domainMax,
}: {
  values: number[];
  times: number[];
  thresholds?: { warn: number; danger: number };
  domainMin?: number;
  domainMax?: number;
}) {
  const W = 360;
  const H = 120;
  const PAD_L = 32;
  const PAD_R = 6;
  const PAD_T = 6;
  const PAD_B = 18;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  if (values.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ display: "block", maxWidth: "100%" }}
        role="img"
        aria-label="No samples yet"
      >
        <rect
          x={PAD_L}
          y={PAD_T}
          width={plotW}
          height={plotH}
          fill="transparent"
          stroke="var(--color-border)"
        />
        <text
          x={W / 2}
          y={H / 2}
          textAnchor="middle"
          fontSize={11}
          fill="var(--color-fg-subtle)"
        >
          No samples yet
        </text>
      </svg>
    );
  }

  const minTs = Math.min(...times);
  const maxTs = Math.max(...times);
  const tsSpan = Math.max(1, maxTs - minTs);

  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  let yMin = domainMin ?? Math.max(0, dataMin - (dataMax - dataMin) * 0.1);
  let yMax =
    domainMax ?? dataMax + Math.max(0.1, (dataMax - dataMin) * 0.1);
  if (yMax <= yMin) yMax = yMin + 1;
  const ySpan = yMax - yMin;

  const xOf = (t: number) => PAD_L + ((t - minTs) / tsSpan) * plotW;
  const yOf = (v: number) => PAD_T + (1 - (v - yMin) / ySpan) * plotH;

  const points = values
    .map((v, i) => `${xOf(times[i] ?? 0).toFixed(1)},${yOf(v).toFixed(1)}`)
    .join(" ");

  // Severity bands behind the line (warn yellow, danger red).
  let bands: { y1: number; y2: number; fill: string }[] = [];
  if (thresholds) {
    const warnY = yOf(thresholds.warn);
    const dangerY = yOf(thresholds.danger);
    bands = [
      { y1: dangerY, y2: warnY, fill: "rgba(217, 119, 6, 0.08)" },
      { y1: PAD_T, y2: dangerY, fill: "rgba(220, 38, 38, 0.10)" },
    ].filter((b) => b.y2 > b.y1);
  }

  // Y axis labels: 0, mid, max (or 100 if domain pinned to %).
  const ticks = [yMin, (yMin + yMax) / 2, yMax];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      style={{ display: "block", maxWidth: "100%", marginTop: 8 }}
      role="img"
    >
      {/* Severity bands */}
      {bands.map((b, i) => (
        <rect
          key={i}
          x={PAD_L}
          y={b.y1}
          width={plotW}
          height={b.y2 - b.y1}
          fill={b.fill}
        />
      ))}

      {/* Plot frame */}
      <rect
        x={PAD_L}
        y={PAD_T}
        width={plotW}
        height={plotH}
        fill="transparent"
        stroke="var(--color-border)"
      />

      {/* Y ticks */}
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={PAD_L}
            x2={PAD_L + plotW}
            y1={yOf(t)}
            y2={yOf(t)}
            stroke="var(--color-border)"
            strokeDasharray="2 3"
            opacity={0.4}
          />
          <text
            x={PAD_L - 4}
            y={yOf(t) + 3}
            textAnchor="end"
            fontSize={9}
            fill="var(--color-fg-subtle)"
          >
            {t.toFixed(thresholds ? 0 : 2)}
          </text>
        </g>
      ))}

      {/* Series */}
      <polyline
        points={points}
        fill="none"
        stroke="var(--color-fg, #2a2520)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* X axis: start + end labels */}
      <text
        x={PAD_L}
        y={H - 4}
        fontSize={9}
        fill="var(--color-fg-subtle)"
      >
        {fmtClock(minTs)}
      </text>
      <text
        x={PAD_L + plotW}
        y={H - 4}
        textAnchor="end"
        fontSize={9}
        fill="var(--color-fg-subtle)"
      >
        {fmtClock(maxTs)}
      </text>
    </svg>
  );
}

function fmtClock(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ── Container table ─────────────────────────────────────────────────────

function ContainerTable({ containers }: { containers: ContainerSnapshot[] }) {
  if (containers.length === 0) {
    return (
      <section className="mt-10">
        <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
          Containers
        </h2>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
          No containers reported. Check that the metrics-collector has access to /var/run/docker.sock.
        </p>
      </section>
    );
  }
  return (
    <section className="mt-10">
      <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
        Containers ({containers.length})
      </h2>
      <div className="mt-4 overflow-x-auto rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
              <th className="px-4 py-3 text-left font-normal">Container</th>
              <th className="px-4 py-3 text-left font-normal">State</th>
              <th className="px-4 py-3 text-left font-normal">Health</th>
              <th className="px-4 py-3 text-left font-normal">Status</th>
              <th className="px-4 py-3 text-left font-normal">Image</th>
            </tr>
          </thead>
          <tbody>
            {containers.map((c) => {
              const sev: Severity =
                c.state === "restarting" || c.health === "unhealthy"
                  ? "danger"
                  : c.state !== "running"
                    ? "warn"
                    : c.health === "starting"
                      ? "warn"
                      : "ok";
              const tone = SEVERITY_TONE[sev];
              return (
                <tr
                  key={c.name}
                  className="border-b border-[var(--color-border)] last:border-b-0"
                >
                  <td className="px-4 py-3 mono text-[var(--color-fg)]">
                    {shortName(c.name)}
                  </td>
                  <td className="px-4 py-3 mono">
                    <span style={{ color: tone, fontWeight: 600 }}>
                      {c.state}
                    </span>
                  </td>
                  <td className="px-4 py-3 mono">
                    {c.health === "none" ? (
                      <span className="text-[var(--color-fg-subtle)]">—</span>
                    ) : (
                      <span style={{ color: tone, fontWeight: 600 }}>
                        {c.health}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                    {c.status}
                  </td>
                  <td className="px-4 py-3 mono text-[var(--color-fg-subtle)]">
                    {c.image}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// shortName trims the compose project prefix ("oddzilla-") and the
// trailing replica index ("-1") so the container column doesn't
// dominate the row width.
function shortName(name: string): string {
  return name.replace(/^oddzilla-/, "").replace(/-\d+$/, "");
}
