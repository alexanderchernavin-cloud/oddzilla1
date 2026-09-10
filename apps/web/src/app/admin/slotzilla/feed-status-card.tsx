"use client";

import { useCallback, useEffect, useState } from "react";
import { clientApi } from "@/lib/api-client";
import { normaliseFeedStatus, type SlotzillaFeedStatusDto } from "./slotzilla-admin-types";
import { formatRelativeSeconds } from "./format";
import { useInterval } from "./use-interval";
import { Chip, OnlineDot, monoMuted } from "./ui";

const POLL_MS = 10_000;

/** With no explicit `online`, a heartbeat older than this is offline. */
const HEARTBEAT_STALE_SECONDS = 90;

function isOnline(s: SlotzillaFeedStatusDto, nowMs: number): boolean {
  if (typeof s.online === "boolean") return s.online;
  if (s.updatedUnix === null) return false;
  return nowMs / 1000 - s.updatedUnix < HEARTBEAT_STALE_SECONDS;
}

/**
 * The service's own heartbeat (Redis hash `slotzilla:feed:status`) plus
 * the counts the api adds. Offline is a normal state — the service idles
 * when the config is disabled — so it is a grey fact, not an alert; the
 * last error is what deserves the red.
 */
export function FeedStatusCard({ initial }: { initial: unknown }) {
  const [status, setStatus] = useState<SlotzillaFeedStatusDto | null>(() => normaliseFeedStatus(initial));
  const [failed, setFailed] = useState(initial === null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const raw = await clientApi<unknown>("/admin/slotzilla/status");
      setStatus(normaliseFeedStatus(raw));
      setFailed(false);
    } catch {
      setFailed(true);
    }
    setNowMs(Date.now());
  }, []);

  useInterval(() => void refresh(), POLL_MS);
  useEffect(() => {
    if (initial === null) void refresh();
  }, [initial, refresh]);

  const online = status ? isOnline(status, nowMs) : false;

  return (
    <section
      aria-label="SlotZilla feed status"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 18,
        padding: "12px 18px",
        background: "var(--color-bg-subtle, var(--surface-2))",
        border: "1px solid var(--color-border, var(--border))",
        borderRadius: 10,
        fontSize: 13,
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 10, fontWeight: 600 }}>
        <OnlineDot online={online} />
        {status ? (online ? "Feed worker online" : "Feed worker offline") : failed ? "Status unavailable" : "Loading status…"}
      </span>
      {status ? (
        <>
          <Stat label="Games" value={status.games} />
          <Stat label="Live" value={status.liveGames} />
          <Stat label="Open spins" value={status.openSpins} />
          <Stat label="Heartbeat" value={formatRelativeSeconds(status.updatedUnix, nowMs)} />
          <Stat label="Last fetch" value={formatRelativeSeconds(status.lastFetchUnix, nowMs)} />
          {status.pollMs !== null ? <Stat label="Poll" value={`${status.pollMs} ms`} /> : null}
          <span style={{ flex: 1 }} />
          {status.lastError ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, maxWidth: 420 }}>
              <Chip tone="negative">last error</Chip>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--negative, #dc2626)", wordBreak: "break-word" }}>
                {status.lastError}
              </span>
            </span>
          ) : (
            <Chip tone="muted">no errors</Chip>
          )}
        </>
      ) : failed ? (
        <span style={monoMuted}>Couldn&apos;t reach /admin/slotzilla/status; retrying every 10 s.</span>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 1 }}>
      <span
        className="mono"
        style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-fg-subtle, var(--fg-dim))" }}
      >
        {label}
      </span>
      <span className="mono" style={{ fontSize: 13 }}>
        {value}
      </span>
    </span>
  );
}
