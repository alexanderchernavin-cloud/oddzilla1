"use client";

// Combines the match's live stream embed (Twitch / YouTube) with the
// Oddin Disir live scoreboard widget into one media surface.
//
// Desktop: stream on top; live widget directly below it.
// Mobile:  pill switcher at the top toggles between stream and stats,
//          only one mounts at a time so we don't pay for two iframes.
//
// The live widget URL is generated even before data exists. We let
// Oddin's iframe render its own "Live stats not available" empty
// state if data hasn't arrived — per the Disir doc, "If the Widgets
// are not initially available for an event, the DATA notification
// will not be sent", so a hide-until-DATA strategy means an invisible
// widget area on every match without immediate stats.

import { useState } from "react";
import {
  MatchStreams,
  type MatchStream,
} from "@/components/match/match-streams";
import { useLiveMatchStatus } from "@/lib/use-live-odds";
import { useOddinVideo } from "@/lib/use-oddin-video";
import { DisirWidget } from "./disir-widget";
import { supportsLiveWidget } from "./supported-sports";
import { useTranslations } from "@/lib/i18n";

type MatchStatus = "not_started" | "live" | "closed" | "cancelled" | "suspended";

interface Props {
  matchId: string;
  sportSlug: string;
  homeTeam: string;
  awayTeam: string;
  streams: MatchStream[];
  parentHost: string | null;
  initialStatus: MatchStatus;
}

type MobileTab = "stream" | "stats";

export function MatchLiveMedia({
  matchId,
  sportSlug,
  homeTeam,
  awayTeam,
  streams,
  parentHost,
  initialStatus,
}: Props) {
  const t = useTranslations("matchWidgets");
  const tMatch = useTranslations("match");
  // Subscribe to live lifecycle ticks so the live-stats widget hides
  // the moment the match finishes — otherwise the iframe stays mounted
  // showing its final state until the bettor reloads.
  const liveStatus = useLiveMatchStatus(matchId);
  const status = liveStatus?.status ?? initialStatus;
  const isLive = status === "live";
  const [mobileTab, setMobileTab] = useState<MobileTab>("stream");

  // Oddin's first-party stream, when it carries one for this match. Only
  // worth asking about while the match could still be watched — a closed or
  // cancelled fixture has nothing to play, and the catalog drops it anyway.
  const { availability: oddinVideo } = useOddinVideo(
    matchId,
    status === "not_started" || status === "live",
  );

  // If a sport doesn't support live widgets at all, skip the whole
  // dance and fall back to streams-only (or render nothing if no
  // streams either). Same shape as the storefront when this component
  // didn't exist.
  const sportHasLiveWidget = supportsLiveWidget(sportSlug);
  const renderStats = isLive && sportHasLiveWidget;

  // The stream pane earns its place if EITHER a broadcaster URL came off the
  // fixture or Oddin carries its own stream — a match can have the latter
  // with an empty tv_channels block, which is the common case.
  // `signInRequired` counts: watching is signed-in-only, and the pane then
  // holds the sign-in prompt rather than a player.
  const renderStream =
    streams.length > 0 || oddinVideo.available || oddinVideo.signInRequired;

  // Nothing to stream + no live stats = render nothing, as before.
  if (!renderStream && !renderStats) return null;

  // The mobile switcher has one pill per available pane, so force the tab
  // onto whichever pane exists when only one does. Needed because Oddin
  // availability lands a round-trip after mount: a match with no
  // tv_channels starts with no stream pane and gains one.
  const activeTab: MobileTab = !renderStats
    ? "stream"
    : !renderStream
      ? "stats"
      : mobileTab;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Mobile pill switcher: only renders when both stream + stats
          could plausibly show. On desktop, the same buttons stay hidden
          and both panels render stacked. */}
      {renderStream && renderStats ? (
        <div
          className="oz-live-media-tabs"
          role="tablist"
          aria-label={t("liveMedia.aria")}
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
            label={tMatch("stream")}
            active={activeTab === "stream"}
            onClick={() => setMobileTab("stream")}
          />
          <PillBtn
            label={tMatch("stats")}
            active={activeTab === "stats"}
            onClick={() => setMobileTab("stats")}
          />
        </div>
      ) : null}

      {renderStream ? (
        <div
          className="oz-live-media-stream"
          data-active={activeTab === "stream" ? "true" : "false"}
        >
          <MatchStreams
            streams={streams}
            parentHost={parentHost}
            oddinVideo={oddinVideo}
          />
        </div>
      ) : null}

      {renderStats ? (
        <div
          className="oz-live-media-stats"
          data-active={activeTab === "stats" ? "true" : "false"}
        >
          <LiveStatsHeader sportSlug={sportSlug} />
          <DisirWidget
            variant="live-scoreboard"
            id={matchId}
            title={t("liveMedia.liveStatsTitle", {
              home: homeTeam,
              away: awayTeam,
            })}
            minHeight={200}
            // hideUntilData defaults off so Oddin's iframe renders its
            // own "Live stats not available" empty state when data
            // isn't ready — better UX than an invisible widget.
            // theme prop omitted: DisirWidget tracks <html data-theme>
            // and re-fetches the upstream URL when the user toggles.
          />
        </div>
      ) : null}
    </section>
  );
}

function LiveStatsHeader({
  sportSlug,
}: {
  sportSlug: string;
}) {
  const t = useTranslations("matchWidgets");
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
        {t("liveMedia.liveStats")}
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
        {sportSlug}
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
