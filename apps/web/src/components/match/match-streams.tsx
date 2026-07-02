"use client";

import { useState } from "react";
import { I } from "@/components/ui/icons";
import { useEmbedsAllowed, grantEmbedsConsent } from "@/lib/cookie-consent";
import { useTranslations } from "@/lib/i18n";

export interface MatchStream {
  platform: "twitch" | "youtube" | "kick" | "gjirafa" | "other";
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
}

export function MatchStreams({ streams, parentHost }: Props) {
  const embeddable = streams.filter(
    (s) =>
      (s.platform === "twitch" && s.embedId && parentHost) ||
      (s.platform === "youtube" && s.embedId) ||
      (s.platform === "kick" && s.embedId) ||
      (s.platform === "gjirafa" && s.embedId),
  );

  const [activeIdx, setActiveIdx] = useState(0);
  // Third-party players (Twitch / YouTube / Kick / Gjirafa) set their
  // own cookies the moment the iframe mounts — gated behind the cookie
  // banner's "third-party media" consent (GDPR / ePrivacy). Without
  // consent we render a click-to-enable placeholder instead; clicking
  // it IS an affirmative consent action and unblocks embeds site-wide.
  const embedsAllowed = useEmbedsAllowed();

  if (streams.length === 0) return null;

  const active = embeddable[activeIdx] ?? null;

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
          Live stream
        </span>
        {embeddable.length > 1 ? (
          <div role="tablist" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {embeddable.map((s, idx) => (
              <button
                key={s.url}
                role="tab"
                aria-selected={idx === activeIdx}
                onClick={() => setActiveIdx(idx)}
                style={{
                  background: idx === activeIdx ? "var(--surface-2)" : "transparent",
                  border: "1px solid var(--border)",
                  borderColor:
                    idx === activeIdx ? "var(--fg-muted)" : "var(--border)",
                  color: idx === activeIdx ? "var(--fg)" : "var(--fg-muted)",
                  borderRadius: 999,
                  padding: "4px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <PlatformDot platform={s.platform} />
                {streamLabel(s, idx)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {active ? (
        embedsAllowed ? (
          <StreamEmbed stream={active} parentHost={parentHost} />
        ) : (
          <EmbedConsentPlaceholder />
        )
      ) : (
        <FallbackCard stream={streams[0]!} />
      )}
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
  return "Stream";
}

function PlatformDot({ platform }: { platform: MatchStream["platform"] }) {
  const color =
    platform === "twitch"
      ? "#a970ff"
      : platform === "youtube"
        ? "#ff0033"
        : platform === "kick"
          ? "#53fc18"
          : platform === "gjirafa"
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
  let src: string | null = null;
  let title = "Live stream";
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

// Rendered in place of the player while third-party media consent is
// missing or declined. The button records embeds=true consent (an
// explicit, specific opt-in) and the player mounts immediately.
function EmbedConsentPlaceholder() {
  const t = useTranslations("cookieConsent");
  return (
    <div
      style={{
        width: "100%",
        aspectRatio: "16 / 9",
        borderRadius: "var(--r-md, 10px)",
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: 20,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        {t("embedsBlockedTitle")}
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--fg-muted)",
          lineHeight: 1.5,
          maxWidth: 380,
        }}
      >
        {t("embedsBlockedBody")}
      </div>
      <button
        type="button"
        onClick={grantEmbedsConsent}
        style={{
          marginTop: 4,
          padding: "8px 14px",
          fontSize: 12.5,
          fontWeight: 600,
          background: "var(--accent)",
          color: "var(--accent-fg)",
          border: "1px solid var(--accent)",
          borderRadius: 8,
          cursor: "pointer",
        }}
      >
        {t("embedsEnable")}
      </button>
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
