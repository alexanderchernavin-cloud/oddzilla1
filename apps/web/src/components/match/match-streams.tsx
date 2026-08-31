"use client";

import { useState } from "react";
import Link from "next/link";
import { I } from "@/components/ui/icons";
import { useTranslations } from "@/lib/i18n";
import type { OddinVideoAvailability } from "@oddzilla/types/video";
import { OddinVideoPlayer } from "./oddin-video-player";

export interface MatchStream {
  platform: "twitch" | "youtube" | "kick" | "gjirafa" | "vpplayer" | "other";
  embedId: string | null;
  url: string;
  name: string | null;
  language: string | null;
}

interface Props {
  streams: MatchStream[];
  // Twitch's iframe player insists on a `parent=<host>` query param matching
  // the embedding domain. Resolved server-side from the request headers and
  // passed in so the client doesn't have to guess at runtime (would be
  // wrong on first render anyway).
  parentHost: string | null;
  // Oddin's own stream for this match, when it carries one. Listed FIRST in
  // the source strip and selected by default: it is the rights-cleared
  // first-party feed, DRM-protected and low-latency, where the Twitch /
  // YouTube entries are whatever broadcaster URLs the fixture happened to
  // advertise. Null / unavailable leaves the strip exactly as it was before
  // this existed.
  oddinVideo?: OddinVideoAvailability | null;
}

/**
 * One selectable video source: Oddin's player, or a third-party iframe.
 * `embedIdx` is the stream's position among the embeddable streams, NOT in
 * this list — it feeds `streamLabel`'s "Twitch 1 / Twitch 2" fallback, which
 * would otherwise start counting at 2 whenever the Oddin source is present.
 */
type Source =
  | { kind: "oddin" }
  /** A stream exists but the viewer is anonymous — offer sign-in instead. */
  | { kind: "signin" }
  | { kind: "embed"; stream: MatchStream; embedIdx: number };

export function MatchStreams({ streams, parentHost, oddinVideo }: Props) {
  const t = useTranslations("matchWidgets");
  const embeddable = streams.filter(
    (s) =>
      (s.platform === "twitch" && s.embedId && parentHost) ||
      (s.platform === "youtube" && s.embedId) ||
      (s.platform === "kick" && s.embedId) ||
      (s.platform === "gjirafa" && s.embedId) ||
      // vpplayer carries no embedId - the url IS the player page.
      s.platform === "vpplayer",
  );

  const [activeIdx, setActiveIdx] = useState(0);
  // Set when the SDK reports the stream is genuinely gone (404 / 410 / key
  // refused). The catalog behind `oddinVideo` is a 60s cache and can lead or
  // lag reality, so we drop the source rather than leave a dead tab.
  const [oddinDropped, setOddinDropped] = useState(false);

  const oddinReady =
    !oddinDropped && oddinVideo?.available === true ? oddinVideo : null;
  // Mutually exclusive with oddinReady: the api sets one or the other.
  const oddinSignIn = !oddinDropped && oddinVideo?.signInRequired === true;

  const sources: Source[] = [
    ...(oddinReady ? [{ kind: "oddin" } as const] : []),
    ...(oddinSignIn ? [{ kind: "signin" } as const] : []),
    ...embeddable.map(
      (stream, embedIdx) => ({ kind: "embed", stream, embedIdx }) as const,
    ),
  ];

  // No playable source and no advertised URL to link out to.
  if (sources.length === 0 && streams.length === 0) return null;

  // Clamp rather than reset: the Oddin source can appear a poll after mount
  // (or vanish on a terminal error), and an out-of-range index would blank
  // the pane. Selection shifting by one in that moment is the lesser evil.
  const idx = Math.min(activeIdx, Math.max(0, sources.length - 1));
  const active = sources[idx] ?? null;

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
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
          {t("streams.liveStream")}
        </span>
        {sources.length > 1 ? (
          <div role="tablist" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {sources.map((src, i) => {
              const selected = i === idx;
              return (
                <button
                  key={src.kind === "embed" ? src.stream.url : src.kind}
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveIdx(i)}
                  style={{
                    background: selected ? "var(--surface-2)" : "transparent",
                    border: "1px solid var(--border)",
                    borderColor: selected ? "var(--fg-muted)" : "var(--border)",
                    color: selected ? "var(--fg)" : "var(--fg-muted)",
                    borderRadius: 999,
                    padding: "4px 10px",
                    fontSize: 12,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <PlatformDot
                    platform={src.kind === "embed" ? src.stream.platform : "oddin"}
                  />
                  {src.kind === "embed"
                    ? streamLabel(src.stream, src.embedIdx)
                    : t("streams.oddinLabel")}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Mounted for the whole life of the section and hidden when another
          source is selected, so switching tabs and back does not tear the
          player down and re-arm it (which would re-resolve playback, fetch a
          fresh licence, and restart from the live edge). */}
      {oddinReady ? (
        <div style={{ display: active?.kind === "oddin" ? "block" : "none" }}>
          <OddinVideoPlayer
            availability={oddinReady}
            active={active?.kind === "oddin"}
            onUnavailable={() => setOddinDropped(true)}
          />
        </div>
      ) : null}

      {active?.kind === "signin" ? <SignInToWatch /> : null}

      {active?.kind === "embed" ? (
        <StreamEmbed stream={active.stream} parentHost={parentHost} />
      ) : null}

      {/* Nothing embeddable at all — link out to whatever the fixture
          advertised, as before. */}
      {sources.length === 0 && streams.length > 0 ? (
        <FallbackCard stream={streams[0]!} />
      ) : null}
    </section>
  );
}

function streamLabel(s: MatchStream, idx: number): string {
  if (s.name) return s.name;
  if (s.language) return `${platformName(s.platform)} · ${s.language.toUpperCase()}`;
  return `${platformName(s.platform)} ${idx + 1}`;
}

function platformName(p: MatchStream["platform"]): string {
  if (p === "twitch") return "Twitch";
  if (p === "youtube") return "YouTube";
  if (p === "kick") return "Kick";
  if (p === "gjirafa") return "Gjirafa";
  // Gjirafa white-label player host; Oddin still labels the channel
  // "Gjirafa", and stream.name wins over this when present.
  if (p === "vpplayer") return "Gjirafa";
  return "Stream";
}

function PlatformDot({
  platform,
}: {
  platform: MatchStream["platform"] | "oddin";
}) {
  const color =
    platform === "oddin"
      ? "var(--accent)"
      : platform === "twitch"
      ? "#a970ff"
      : platform === "youtube"
        ? "#ff0033"
        : platform === "kick"
          ? "#53fc18"
          : platform === "gjirafa" || platform === "vpplayer"
            ? "#f97316"
            : "var(--fg-muted)";
  return (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        display: "inline-block",
      }}
    />
  );
}

function StreamEmbed({
  stream,
  parentHost,
}: {
  stream: MatchStream;
  parentHost: string | null;
}) {
  const t = useTranslations("matchWidgets");
  let src: string | null = null;
  let title = t("streams.liveStream");
  if (stream.platform === "twitch" && stream.embedId && parentHost) {
    const params = new URLSearchParams({
      channel: stream.embedId,
      parent: parentHost,
      muted: "true",
      autoplay: "false",
    });
    src = `https://player.twitch.tv/?${params.toString()}`;
    title = `Twitch: ${stream.embedId}`;
  } else if (stream.platform === "youtube" && stream.embedId) {
    src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(
      stream.embedId,
    )}?rel=0&modestbranding=1`;
    title = `YouTube: ${stream.embedId}`;
  } else if (stream.platform === "kick" && stream.embedId) {
    src = `https://player.kick.com/${encodeURIComponent(
      stream.embedId,
    )}?muted=true&autoplay=false`;
    title = `Kick: ${stream.embedId}`;
  } else if (stream.platform === "gjirafa" && stream.embedId) {
    src = `https://video.gjirafa.com/embed/${encodeURIComponent(stream.embedId)}`;
    title = `Gjirafa: ${stream.embedId}`;
  } else if (stream.platform === "vpplayer") {
    // Already a player page (`host.vpplayer.tech/player/<a>/<v>.html`), so
    // it goes in verbatim. The api validated the host and path shape before
    // classifying it, which is what makes using the raw url here safe.
    src = stream.url;
    title = "Gjirafa";
  }

  if (!src) return <FallbackCard stream={stream} />;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "16 / 9",
        background: "#000",
        borderRadius: "var(--r-md, 10px)",
        overflow: "hidden",
        border: "1px solid var(--border)",
      }}
    >
      <iframe
        src={src}
        title={title}
        allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
        allowFullScreen
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          border: 0,
        }}
      />
    </div>
  );
}

/**
 * Shown in place of the player when Oddin carries a stream for this match
 * but the viewer is signed out. Deliberately keeps the same 16/9 black box
 * the player would occupy, so the layout doesn't jump when they come back
 * signed in.
 */
function SignInToWatch() {
  const t = useTranslations("matchWidgets");
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "16 / 9",
        background: "#0b0b0c",
        borderRadius: "var(--r-md, 10px)",
        overflow: "hidden",
        border: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 20,
        textAlign: "center",
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#9a9a98",
        }}
      >
        {t("oddinVideo.signInTitle")}
      </span>
      <Link
        href="/login"
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "8px 18px",
          borderRadius: 999,
          background: "#f2f1ec",
          color: "#0b0b0c",
          fontSize: 13,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        {t("oddinVideo.signInCta")}
      </Link>
    </div>
  );
}

function FallbackCard({ stream }: { stream: MatchStream }) {
  return (
    <a
      href={stream.url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 16px",
        borderRadius: "var(--r-md, 10px)",
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
        color: "var(--fg)",
        textDecoration: "none",
        gap: 12,
      }}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          minWidth: 0,
        }}
      >
        <PlatformDot platform={stream.platform} />
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {stream.name ?? platformName(stream.platform)}
          </span>
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--fg-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {stream.url}
          </span>
        </span>
      </span>
      <span style={{ color: "var(--fg-muted)", flexShrink: 0 }}>
        <I.Arrow size={14} />
      </span>
    </a>
  );
}
