"use client";

import { useCallback, useEffect, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";

// Mirrors GET /admin/feed/fonbet-status (services/api/src/modules/admin/feed.ts).
export interface FonbetFeedStatus {
  switch: {
    // null = never switched from the backoffice; the FONBET_ENABLED env
    // default applies.
    enabled: boolean | null;
    switchedUnix: number | null;
    switchedBy: string | null;
    appliedEnabled: boolean | null;
    appliedUnix: number | null;
  };
  service: {
    online: boolean;
    heartbeatUnix: number | null;
    envDefault: boolean | null;
    effectiveEnabled: boolean | null;
    switchSource: string | null;
    running: boolean;
    catalogSuspended: boolean;
    settleEnabled: boolean;
    matches: number | null;
    outcomes: number | null;
    lastSnapshotUnix: number | null;
    lastError: string | null;
    lastErrorUnix: number | null;
  };
}

const POLL_MS = 5000;

export function FonbetFeedCard() {
  const [status, setStatus] = useState<FonbetFeedStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await clientApi<FonbetFeedStatus>("/admin/feed/fonbet-status");
      setStatus(s);
      setError(null);
    } catch {
      setError("Could not load Fonbet feed status.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const feed = describeFeed(status);

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
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>Fonbet feed (traditional sports)</h2>
        <span
          className="mono"
          style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-fg-muted)" }}
        >
          refreshes every {POLL_MS / 1000}s
        </span>
      </div>

      <FonbetSwitch status={status} onChanged={load} />

      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--color-fg-muted)" }}>
        The second odds provider: fonbet-ingester polls the public Fonbet KZ line every 5 s and
        writes football, tennis, hockey, basketball and the other traditional sports into the same
        catalog Oddin&apos;s esports use. <strong>Off</strong> suspends every Fonbet market at once
        (prices are kept but nothing is bettable or listed), stops polling Fonbet and pauses
        results-based settlement, so tickets on Fonbet markets stay open until the feed is on again
        or settled by hand. <strong>On</strong> boots the feed and re-activates whatever Fonbet still
        quotes within one cycle. The position is stored in Postgres and survives restarts and
        deploys; until it is set here the <code>FONBET_ENABLED</code> value from <code>.env</code>{" "}
        applies. Settlement additionally needs <code>FONBET_SETTLE_ENABLED=true</code> — see
        docs/FONBET.md &quot;Before enabling settlement&quot;.
      </p>

      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--negative, #f87171)" }}>
          {error}
        </p>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <Tile label="Service" value={describeService(status).value} tone={describeService(status).tone} hint={describeService(status).hint} />
        <Tile label="Feed" value={feed.value} tone={feed.tone} hint={feed.hint} />
        <Tile
          label="Matches on offer"
          value={fmtNum(status?.service.matches)}
          hint={status?.service.outcomes != null ? `${fmtNum(status.service.outcomes)} priced outcomes` : undefined}
        />
        <Tile
          label="Last snapshot"
          value={status?.service.lastSnapshotUnix ? ago(status.service.lastSnapshotUnix) : "—"}
          hint={
            status?.service.settleEnabled
              ? "results-based settlement on"
              : status?.service.online
                ? "settlement off (FONBET_SETTLE_ENABLED)"
                : undefined
          }
        />
      </div>

      {status?.service.lastError ? (
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
            last error{status.service.lastErrorUnix ? ` · ${ago(status.service.lastErrorUnix)}` : ""}
          </span>
          <div style={{ marginTop: 4, wordBreak: "break-word" }}>{status.service.lastError}</div>
        </div>
      ) : null}
    </div>
  );
}

function FonbetSwitch({ status, onChanged }: { status: FonbetFeedStatus | null; onChanged: () => void }) {
  const [confirmOn, setConfirmOn] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The position the operator has set, or the env default the service
  // reports when nothing was ever set from here.
  const explicit = status?.switch.enabled ?? null;
  const envDefault = status?.service.envDefault ?? null;
  const current: boolean | null = explicit ?? envDefault;
  const fromEnv = explicit == null;

  async function apply(enabled: boolean) {
    setSubmitting(true);
    setError(null);
    try {
      await clientApi("/admin/feed/fonbet", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      setConfirmOn(false);
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

  function pick(enabled: boolean) {
    if (submitting || (current === enabled && !fromEnv)) return;
    if (enabled) {
      // Starting a provider that publishes prices to the storefront gets
      // a second click; Off is the emergency brake and stays one click.
      setConfirmOn(true);
      return;
    }
    void apply(false);
  }

  const applied = status?.switch.appliedEnabled ?? null;
  const applying =
    status != null && status.service.online && current != null && applied != null && applied !== current;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        role="radiogroup"
        aria-label="Fonbet feed"
        style={{
          display: "inline-flex",
          alignSelf: "flex-start",
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {[
          { value: true, label: "On", hint: "Poll the Fonbet line and publish its markets" },
          { value: false, label: "Off", hint: "Suspend every Fonbet market and stop polling" },
        ].map((opt) => {
          const selected = current === opt.value && !fromEnv;
          const envSelected = current === opt.value && fromEnv;
          return (
            <button
              key={String(opt.value)}
              type="button"
              role="radio"
              aria-checked={selected}
              title={opt.hint}
              disabled={submitting || status == null}
              onClick={() => pick(opt.value)}
              style={{
                height: 38,
                padding: "0 18px",
                border: "none",
                borderRight: "1px solid var(--border)",
                background: selected
                  ? opt.value
                    ? "var(--positive, #4ade80)"
                    : "var(--color-fg)"
                  : envSelected
                    ? "var(--surface-2)"
                    : "transparent",
                color: selected ? "var(--color-bg)" : "var(--color-fg-muted)",
                fontWeight: selected || envSelected ? 600 : 500,
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
        {status?.switch.switchedUnix ? (
          <>
            Set {status.switch.enabled ? "On" : "Off"} {ago(status.switch.switchedUnix)}
            {status.switch.switchedBy ? ` by ${status.switch.switchedBy.slice(0, 8)}` : ""}.{" "}
          </>
        ) : (
          <>
            Never switched here; env default{" "}
            <code>FONBET_ENABLED={envDefault == null ? "?" : envDefault ? "true" : "false"}</code> applies.{" "}
          </>
        )}
        {!status?.service.online ? (
          <span style={{ color: "var(--warning, #fbbf24)" }}>
            fonbet-ingester is offline — the position is stored and applies when it starts.
          </span>
        ) : applying ? (
          <span style={{ color: "var(--warning, #fbbf24)" }}>
            fonbet-ingester still applying (has {applied ? "on" : "off"})…
          </span>
        ) : applied != null ? (
          <>
            fonbet-ingester applied: {applied ? "on" : "off"}
            {status?.switch.appliedUnix ? ` ${ago(status.switch.appliedUnix)}` : ""}.
          </>
        ) : null}
      </div>

      {confirmOn ? (
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
            Turn the Fonbet feed <strong>On</strong>? fonbet-ingester starts polling the Fonbet KZ
            line; within one cycle its markets are re-activated and listed under Sports with live
            prices. The first cycle after a long pause re-asserts the whole line (~200k prices,
            paced against odds-publisher).
            {status?.service.settleEnabled
              ? " Results-based settlement is ON for this service, so finished matches will be graded and paid automatically."
              : " Results-based settlement is OFF (FONBET_SETTLE_ENABLED), so finished matches stay open for manual settlement."}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => void apply(true)}
              disabled={submitting}
              style={{
                height: 34,
                padding: "0 14px",
                borderRadius: 8,
                border: "none",
                background: "var(--positive, #4ade80)",
                color: "var(--color-bg)",
                fontWeight: 600,
                fontSize: 13,
                cursor: submitting ? "wait" : "pointer",
              }}
            >
              {submitting ? "Switching..." : "Yes, turn the feed on"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmOn(false)}
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

function describeService(s: FonbetFeedStatus | null): { value: string; tone: Tone; hint?: string } {
  if (!s) return { value: "…", tone: "muted" };
  if (!s.service.online) {
    return { value: "offline", tone: "warn", hint: "no status heartbeat in the last 2 min" };
  }
  return {
    value: "online",
    tone: "ok",
    hint: s.service.heartbeatUnix ? `heartbeat ${ago(s.service.heartbeatUnix)}` : undefined,
  };
}

function describeFeed(s: FonbetFeedStatus | null): { value: string; tone: Tone; hint?: string } {
  if (!s) return { value: "…", tone: "muted" };
  if (!s.service.online) return { value: "—", tone: "muted" };
  if (!s.service.running) {
    return {
      value: "off",
      tone: "muted",
      hint: s.service.switchSource === "admin" ? "switched off here" : "FONBET_ENABLED=false, never switched here",
    };
  }
  if (s.service.catalogSuspended) {
    return { value: "suspended", tone: "bad", hint: "no snapshot from Fonbet past the staleness threshold" };
  }
  const stale =
    s.service.lastSnapshotUnix != null ? Math.floor(Date.now() / 1000) - s.service.lastSnapshotUnix : null;
  if (stale != null && stale > 30) {
    return { value: "running, quiet", tone: "warn", hint: `last snapshot ${fmtDuration(stale)} ago` };
  }
  return {
    value: "RUNNING",
    tone: "ok",
    hint: s.service.switchSource === "admin" ? "switched on here" : "FONBET_ENABLED=true",
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
