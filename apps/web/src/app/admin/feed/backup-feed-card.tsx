"use client";

import { useCallback, useEffect, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export type FeedSource = "auto" | "prod" | "backup";

// Mirrors GET /admin/feed/backup-status (services/api/src/modules/admin/feed.ts).
export interface BackupFeedStatus {
  online: boolean;
  heartbeatUnix: number | null;
  mode: string | null;
  defaultMode: string | null;
  waitingForFlush: boolean;
  source: {
    requested: FeedSource;
    switchedUnix: number | null;
    switchedBy: string | null;
    appliedByIngester: string | null;
    flushedUnix: number | null;
  };
  active: boolean;
  sinceUnix: number | null;
  connected: boolean;
  clientId: number | null;
  clientName: string | null;
  trackedMatches: number | null;
  frames: number | null;
  reconnects: number | null;
  oddsChanges: number | null;
  settlements: number | null;
  settledMarkets: number | null;
  fixtureChanges: number | null;
  lastFrameUnix: number | null;
  lastPublishUnix: number | null;
  lastResyncUnix: number | null;
  lastError: string | null;
  lastErrorUnix: number | null;
  takeoverAfterSeconds: number | null;
  gateTransitions: number | null;
  primaryLastMessageUnix: number | null;
  primaryStaleSeconds: number | null;
}

const POLL_MS = 5000;

export function BackupFeedCard() {
  const [status, setStatus] = useState<BackupFeedStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await clientApi<BackupFeedStatus>("/admin/feed/backup-status");
      setStatus(s);
      setError(null);
    } catch {
      setError("Could not load backup feed status.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const primary = describePrimary(status);
  const backup = describeBackup(status);

  return (
    <div
      className="card"
      style={{
        padding: 20,
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        maxWidth: 680,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>Feed source</h2>
        <span
          className="mono"
          style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-fg-muted)" }}
        >
          refreshes every {POLL_MS / 1000}s
        </span>
      </div>

      <SourceSwitch status={status} onChanged={load} />

      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--color-fg-muted)" }}>
        Prod Oddin is the AMQP feed. Backup Oddin is bifrost-feed re-synthesising odds, scores
        and settlements from Oddin&apos;s Bifrost GraphQL API through the normal ingest path.
        In Auto the backup takes over after the AMQP feed has been silent past the threshold
        and stands down the moment it resumes. Forcing Backup suspends the catalogue once,
        stops applying AMQP odds, and re-feeds everything from Bifrost within seconds;
        switching back replays from Oddin. Settlement always consumes both sources (apply-once
        dedup); cancel and rollback messages exist only on AMQP. See docs/BIFROST_BACKUP_FEED.md.
      </p>

      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--negative, #f87171)" }}>
          {error}
        </p>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <Tile label="Primary feed (AMQP)" value={primary.value} tone={primary.tone} hint={primary.hint} />
        <Tile label="Backup service" value={backup.value} tone={backup.tone} hint={backup.hint} />
        <Tile
          label="Bifrost socket"
          value={status?.connected ? "connected" : status?.online ? "disconnected" : "—"}
          tone={status?.connected ? "ok" : status?.online ? "warn" : "muted"}
          hint={status?.clientName ? `as ${status.clientName} (client ${status.clientId ?? "?"})` : undefined}
        />
        <Tile
          label="Tracked matches"
          value={fmtNum(status?.trackedMatches)}
          hint={status?.lastFrameUnix ? `last frame ${ago(status.lastFrameUnix)}` : undefined}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <Tile label="Odds changes published" value={fmtNum(status?.oddsChanges)} />
        <Tile
          label="Settlements published"
          value={fmtNum(status?.settlements)}
          hint={status?.settledMarkets != null ? `${status.settledMarkets} markets` : undefined}
        />
        <Tile label="Fixture changes published" value={fmtNum(status?.fixtureChanges)} />
        <Tile
          label="Last publish"
          value={status?.lastPublishUnix ? ago(status.lastPublishUnix) : "—"}
          hint={status?.lastResyncUnix ? `resync ${ago(status.lastResyncUnix)}` : undefined}
        />
      </div>

      {status?.lastError ? (
        <div
          style={{
            padding: 10,
            borderRadius: 8,
            background: "var(--surface-2)",
            fontSize: 12,
            lineHeight: 1.45,
            color: "var(--color-fg-muted)",
          }}
        >
          <span className="mono" style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            last error{status.lastErrorUnix ? ` · ${ago(status.lastErrorUnix)}` : ""}
          </span>
          <div style={{ marginTop: 4, wordBreak: "break-word" }}>{status.lastError}</div>
        </div>
      ) : null}
    </div>
  );
}

const SOURCE_OPTIONS: { value: FeedSource; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Prod Oddin, backup takes over on AMQP silence" },
  { value: "prod", label: "Prod Oddin only", hint: "Backup never publishes" },
  { value: "backup", label: "Backup Oddin", hint: "Force Bifrost; AMQP odds ignored" },
];

function SourceSwitch({ status, onChanged }: { status: BackupFeedStatus | null; onChanged: () => void }) {
  const [pendingTarget, setPendingTarget] = useState<FeedSource | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = status?.source.requested ?? "auto";

  async function apply(target: FeedSource) {
    setSubmitting(true);
    setError(null);
    try {
      await clientApi("/admin/feed/source", {
        method: "PUT",
        body: JSON.stringify({
          source: target,
          ...(target === "backup" ? { confirm: "switch-feed-source" } : {}),
        }),
      });
      setPendingTarget(null);
      onChanged();
    } catch (err) {
      setError(
        err instanceof ApiFetchError
          ? err.body.message ?? err.body.error ?? "Switch failed."
          : "Could not reach the server.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function pick(target: FeedSource) {
    if (target === current || submitting) return;
    if (target === "backup") {
      setPendingTarget(target);
      return;
    }
    void apply(target);
  }

  const applied = status?.source.appliedByIngester ?? null;
  const applying = status != null && applied != null && applied !== current;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        role="radiogroup"
        aria-label="Feed source"
        style={{
          display: "inline-flex",
          alignSelf: "flex-start",
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {SOURCE_OPTIONS.map((opt) => {
          const selected = opt.value === current;
          const danger = opt.value === "backup";
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              title={opt.hint}
              disabled={submitting || status == null}
              onClick={() => pick(opt.value)}
              style={{
                height: 38,
                padding: "0 16px",
                border: "none",
                borderRight: "1px solid var(--border)",
                background: selected
                  ? danger
                    ? "var(--negative, #f87171)"
                    : "var(--color-fg)"
                  : "transparent",
                color: selected ? "var(--color-bg)" : "var(--color-fg-muted)",
                fontWeight: selected ? 600 : 500,
                fontSize: 13,
                cursor: selected || submitting ? "default" : "pointer",
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div style={{ fontSize: 12, color: "var(--color-fg-muted)", lineHeight: 1.5 }}>
        {status?.source.switchedUnix ? (
          <>
            Set {ago(status.source.switchedUnix)}
            {status.source.switchedBy ? ` by ${status.source.switchedBy.slice(0, 8)}` : ""}.{" "}
          </>
        ) : (
          <>Never switched; env default {status?.defaultMode ?? "auto"} applies. </>
        )}
        {applying ? (
          <span style={{ color: "var(--warning, #fbbf24)" }}>
            feed-ingester still applying (has {applied ?? "unknown"})…
          </span>
        ) : status?.waitingForFlush ? (
          <span style={{ color: "var(--warning, #fbbf24)" }}>
            Waiting for feed-ingester to suspend the catalogue before the backup re-feeds it…
          </span>
        ) : applied ? (
          <>feed-ingester applied: {applied}.</>
        ) : null}
      </div>

      {pendingTarget === "backup" ? (
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: "var(--surface-2)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          <span>
            Switch to <strong>Backup Oddin</strong>? Every active market is suspended once, AMQP
            odds are ignored until you switch back, and bifrost-feed re-feeds the catalogue
            from Bifrost within seconds. Cancel and rollback messages from Oddin are still
            applied by settlement, but nothing else from AMQP is.
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => void apply("backup")}
              disabled={submitting}
              style={{
                height: 34,
                padding: "0 14px",
                borderRadius: 8,
                border: "none",
                background: "var(--negative, #f87171)",
                color: "var(--color-bg)",
                fontWeight: 600,
                fontSize: 13,
                cursor: submitting ? "wait" : "pointer",
              }}
            >
              {submitting ? "Switching..." : "Yes, switch to backup"}
            </button>
            <button
              type="button"
              onClick={() => setPendingTarget(null)}
              disabled={submitting}
              style={{
                height: 34,
                padding: "0 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--color-fg-muted)",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--negative, #f87171)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

type Tone = "ok" | "warn" | "bad" | "muted";

function Tile({ label, value, tone = "muted", hint }: { label: string; value: string; tone?: Tone; hint?: string }) {
  const color =
    tone === "ok"
      ? "var(--positive, #4ade80)"
      : tone === "warn"
        ? "var(--warning, #fbbf24)"
        : tone === "bad"
          ? "var(--negative, #f87171)"
          : "var(--color-fg)";
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        background: "var(--surface-2)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span
        className="mono"
        style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-fg-muted)" }}
      >
        {label}
      </span>
      <span style={{ fontSize: 15, fontWeight: 500, color }}>{value}</span>
      {hint ? <span style={{ fontSize: 11.5, color: "var(--color-fg-muted)" }}>{hint}</span> : null}
    </div>
  );
}

function describePrimary(s: BackupFeedStatus | null): { value: string; tone: Tone; hint?: string } {
  if (!s) return { value: "…", tone: "muted" };
  if (s.primaryStaleSeconds == null) {
    return { value: "no heartbeat", tone: "warn", hint: "feed-ingester has not stamped the liveness key yet" };
  }
  const threshold = s.takeoverAfterSeconds ?? 45;
  if (s.primaryStaleSeconds >= threshold) {
    return { value: "SILENT", tone: "bad", hint: `last message ${fmtDuration(s.primaryStaleSeconds)} ago` };
  }
  if (s.primaryStaleSeconds >= 20) {
    return { value: "quiet", tone: "warn", hint: `last message ${fmtDuration(s.primaryStaleSeconds)} ago` };
  }
  return { value: "alive", tone: "ok", hint: `last message ${fmtDuration(s.primaryStaleSeconds)} ago` };
}

function describeBackup(s: BackupFeedStatus | null): { value: string; tone: Tone; hint?: string } {
  if (!s) return { value: "…", tone: "muted" };
  if (!s.online) return { value: "offline", tone: "warn", hint: "no status heartbeat in the last 2 min" };
  if (s.mode === "off") {
    return {
      value: "off",
      tone: "muted",
      hint: s.source.requested === "prod" ? "switch set to Prod Oddin only" : "BIFROST_MODE=off",
    };
  }
  if (s.waitingForFlush) {
    return { value: "arming", tone: "warn", hint: "waiting for the catalogue flush" };
  }
  if (s.active) {
    return {
      value: "ACTIVE",
      tone: s.mode === "active" ? "warn" : "bad",
      hint: `${s.mode === "active" ? "forced by switch" : "took over"}${s.sinceUnix ? ` ${ago(s.sinceUnix)}` : ""}`,
    };
  }
  return {
    value: "standby",
    tone: "ok",
    hint: `takes over after ${s.takeoverAfterSeconds ?? 45}s of AMQP silence`,
  };
}

function fmtNum(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

function ago(unix: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  return `${fmtDuration(s)} ago`;
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
