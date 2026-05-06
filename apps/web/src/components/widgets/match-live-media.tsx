"use client";

// Combines the match's live stream embed (Twitch / YouTube) with the
// Oddin Disir live scoreboard widget into one media surface.
//
// Desktop: stream on top; live widget directly below it.
// Mobile:  pill switcher at the top toggles between stream and stats,
//          only one mounts at a time so we don't pay for two iframes.
//
// The live widget URL is generated even before data exists; the
// underlying DisirWidget component hides the iframe until DATA: true
// arrives. We additionally hide the entire stats card on mobile until
// availability resolves to "available", so the user isn't presented
// with an empty pill that does nothing.

import { useState } from "react";
import {
  MatchStreams,
  type MatchStream,
} from "@/components/match/match-streams";
import { DisirWidget, type WidgetAvailability } from "./disir-widget";
import { supportsLiveWidget } from "./supported-sports";

interface Props {
  matchId: string;
  sportSlug: string;
  homeTeam: string;
  awayTeam: string;
  streams: MatchStream[];
  parentHost: string | null;
  isLive: boolean;
}

type MobileTab = "stream" | "stats";

export function MatchLiveMedia({
  matchId,
  sportSlug,
  homeTeam,
  awayTeam,
  streams,
  parentHost,
  isLive,
}: Props) {
  const [statsAvailable, setStatsAvailable] = useState<WidgetAvailability>("loading");
  const [mobileTab, setMobileTab] = useState<MobileTab>(streams.length > 0 ? "stream" : "stats");

  // If a sport doesn't support live widgets at all, skip the whole
  // dance and fall back to streams-only (or render nothing if no
  // streams either). Same shape as the storefront when this component
  // didn't exist.
  const sportHasLiveWidget = supportsLiveWidget(sportSlug);
  const renderStats = isLive && sportHasLiveWidget;

  // No streams + no live stats = render nothing, matching the old behaviour.
  if (streams.length === 0 && !renderStats) return null;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Mobile pill switcher: only renders when both stream + stats
          could plausibly show. On desktop, the same buttons stay hidden
          and both panels render stacked. */}
      {streams.length > 0 && renderStats ? (
        <div
          className="oz-live-media-tabs"
          role="tablist"
          aria-label="Live media"
          style={{
            display: "none",
            gap: 4,
            padding: 3,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 999,
            alignSelf: "flex-start",
          }}
        >
          <PillBtn
            label="Stream"
            active={mobileTab === "stream"}
            onClick={() => setMobileTab("stream")}
          />
          <PillBtn
            label="Stats"
            active={mobileTab === "stats"}
            onClick={() => setMobileTab("stats")}
          />
        </div>
      ) : null}

      {streams.length > 0 ? (
        <div
          className="oz-live-media-stream"
          data-active={mobileTab === "stream" ? "true" : "false"}
        >
          <MatchStreams streams={streams} parentHost={parentHost} />
        </div>
      ) : null}

      {renderStats ? (
        <div
          className="oz-live-media-stats"
          data-active={mobileTab === "stats" ? "true" : "false"}
        >
          <LiveStatsHeader sportSlug={sportSlug} availability={statsAvailable} />
          <DisirWidget
            variant="live-scoreboard"
            id={matchId}
            theme="dark"
            title={`Live stats — ${homeTeam} vs ${awayTeam}`}
            onAvailabilityChange={setStatsAvailable}
            minHeight={200}
            // The DisirWidget hides itself until DATA: true; we keep the
            // header visible so the user knows the stats panel exists
            // before data arrives.
          />
        </div>
      ) : null}
    </section>
  );
}

function LiveStatsHeader({
  sportSlug,
  availability,
}: {
  sportSlug: string;
  availability: WidgetAvailability;
}) {
  const status =
    availability === "available"
      ? "Live"
      : availability === "unavailable"
        ? "Waiting for data"
        : availability === "error"
          ? "Unavailable"
          : "Loading";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        marginBottom: 8,
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11,
          color: "var(--fg-muted)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        Live stats
      </span>
      <span
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--fg-dim)",
        }}
      >
        {sportSlug} · {status}
      </span>
    </div>
  );
}

function PillBtn({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="mono"
      style={{
        padding: "5px 14px",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        background: active ? "var(--fg)" : "transparent",
        color: active ? "var(--bg)" : "var(--fg-muted)",
        border: 0,
        borderRadius: 999,
        cursor: active ? "default" : "pointer",
        fontFamily: "var(--font-mono)",
      }}
    >
      {label}
    </button>
  );
}
