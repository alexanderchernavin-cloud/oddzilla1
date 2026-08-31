"use client";

// OddinVideoPlayer — the first-party Oddin (Havik) stream for a match.
//
// Mode A of the SDK: the managed player. It owns the <video>, bundles hls.js,
// and wires LL-HLS + Widevine/FairPlay DRM itself. That's why we don't hand
// the manifest to a player of our own — the DRM licence URLs are pre-signed
// per session and have to be POSTed verbatim from the page.
//
// The SDK is dynamically imported so hls.js (the bulk of ~4 MB unpacked) lands
// in its own chunk and only downloads for matches that actually have a stream.
// Most matches don't.
//
// Three things here are load-bearing:
//
//   The <video> is created imperatively, not rendered by React. With
//   `controls: 'custom'` the SDK reparents the element it is given — it
//   inserts a `.havik-player` div as a sibling and moves the <video> inside
//   it (mountControls in the SDK bundle). A React-rendered <video> would then
//   sit somewhere React doesn't expect, and unmounting can throw
//   `NotFoundError: Failed to execute removeChild`. Keeping the element out of
//   React's tree removes the hazard entirely: React owns an empty container
//   and never reconciles its children.
//
//   waitForLive — a match scheduled to start isn't playable yet. Armed with
//   the kickoff time, the SDK waits on its push channel (SSE) and attaches the
//   instant the stream comes up, so a bettor who opens the page early doesn't
//   have to reload. Passing `kickoffAt` matters: without it a viewer armed
//   hours ahead polls /v1/playback on a tight cadence.
//
//   onUnavailable — a stream can turn out to be genuinely absent (the catalog
//   behind the availability check is a 60s cache and can lead or lag the
//   stream). On a terminal error we tell the parent so it drops the source
//   rather than leaving a dead tab in the strip.
//
// CSP: playback needs `connect-src https://*.oddin-video.gg` (manifest,
// segments, SSE, DRM licence, QoE beacons), `media-src blob:` for the MSE
// source, and `worker-src blob:` for the hls.js demuxer worker. All three are
// in apps/web/src/middleware.ts — playback fails without them.

import { useEffect, useRef, useState } from "react";
import type { Player, PlaybackError } from "@oddin-gg/havik-player";
import type { OddinVideoAvailability } from "@oddzilla/types/video";
import { useTranslations } from "@/lib/i18n";

interface Props {
  availability: OddinVideoAvailability;
  /**
   * Called when the stream is definitively not playable (Oddin says the match
   * is unknown / gone, or our key is refused). The parent should stop
   * offering it as a source.
   */
  onUnavailable?: () => void;
}

// The player chrome deliberately does NOT follow the site's light/dark
// toggle: it sits on top of moving video, and a cream control bar over a
// bright frame is unreadable. These mirror the dark block of globals.css so
// the player reads as the same brand in either theme. `radius` and
// `fontFamily` pass through as `var(...)` — they are custom-property values
// resolved on the element, so those two DO track the tokens.
//
// Keep in step with the [data-theme="dark"] block in globals.css.
const PLAYER_THEME = {
  accent: "#f2f1ec",
  accentText: "#0b0b0c",
  background: "#0b0b0c",
  surface: "#131314",
  surfaceMuted: "#1a1a1c",
  text: "#f2f1ec",
  textMuted: "#9a9a98",
  border: "#26262a",
  radius: "var(--r-sm, 6px)",
  fontFamily: "var(--font-sans, ui-sans-serif, system-ui, sans-serif)",
} as const;

// Errors that mean "there is nothing here to watch" rather than "try again".
// NETWORK / TIMEOUT / UNAVAILABLE / RATE_LIMITED are deliberately absent —
// those are transient, and the SDK's own status card offers a Retry.
const TERMINAL_CODES = new Set([
  "NOT_FOUND",
  "GONE",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID_URN",
]);

export function OddinVideoPlayer({ availability, onUnavailable }: Props) {
  const t = useTranslations("matchWidgets");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [drmUnsupported, setDrmUnsupported] = useState(false);

  const { matchUrn, baseUrl, apiKey, status, startsAt } = availability;

  // Held in a ref so the effect doesn't re-run — and tear the player down —
  // just because the parent re-rendered with a new callback identity.
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    if (!matchUrn || !baseUrl || !apiKey) return;
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let player: Player | null = null;

    setDrmUnsupported(false);

    // Ours to create and ours to remove — see the header note on why this
    // element must not come from React.
    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;
    video.preload = "none";
    container.appendChild(video);

    void (async () => {
      try {
        const sdk = await import("@oddin-gg/havik-player");
        // React can unmount before the chunk resolves, and StrictMode runs
        // the effect twice in dev — bail before creating anything.
        if (disposed) return;

        const created = await sdk.createPlayer({
          video,
          baseUrl,
          matchUrn,
          credential: { apiKey },
          // No autoplay: matches the Twitch / YouTube embeds beside it, and
          // avoids pulling a DRM stream for a bettor who opened the page to
          // look at odds. `statusOverlays` supplies the play CTA.
          autoplay: false,
          muted: true,
          controls: "custom",
          statusOverlays: true,
          theme: PLAYER_THEME,
          // Arm on an upcoming match. `kickoffAt` widens the poll cadence
          // when the viewer is armed long before the start.
          waitForLive: startsAt ? { kickoffAt: startsAt } : true,
        });

        if (disposed) {
          created.destroy();
          return;
        }
        player = created;

        created.on("error", (err: PlaybackError) => {
          if (err.code === "DRM_CLIENT") {
            // The browser/OS can't do the required DRM (Linux Chromium
            // without Widevine, a hardened profile, some in-app webviews).
            // Retrying will never help, so say so rather than show the
            // SDK's generic retryable error card.
            setDrmUnsupported(true);
            return;
          }
          if (TERMINAL_CODES.has(err.code)) onUnavailableRef.current?.();
        });
      } catch (err) {
        // createPlayer rejects on terminal resolution failures. Anything we
        // can't classify is treated as "no stream": with no player there is
        // no error card either, so a missing tab beats a black box.
        const code = (err as PlaybackError | undefined)?.code;
        if (code === "DRM_CLIENT") {
          if (!disposed) setDrmUnsupported(true);
          return;
        }
        if (!code || TERMINAL_CODES.has(code)) onUnavailableRef.current?.();
      }
    })();

    return () => {
      disposed = true;
      // destroy() unwinds the SDK's own wrapper (unmountControls puts the
      // <video> back where it found it), but don't rely on that having run
      // before clearing: emptying the container covers both paths.
      try {
        player?.destroy();
      } catch {
        // A half-initialised player can throw on teardown; nothing useful
        // to do about it, and it must not break unmount.
      }
      player = null;
      container.replaceChildren();
    };
  }, [matchUrn, baseUrl, apiKey, startsAt]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Empty as far as React is concerned. The <video> and the SDK's
          `.havik-player` wrapper are appended imperatively; sizing for both
          lives in globals.css under .oz-oddin-video. */}
      <div
        ref={containerRef}
        className="oz-oddin-video"
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          background: "#000",
          borderRadius: "var(--r-md, 10px)",
          overflow: "hidden",
          border: "1px solid var(--border)",
        }}
      />

      {drmUnsupported ? (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: "var(--fg-muted)",
            lineHeight: 1.5,
          }}
        >
          {t("oddinVideo.drmUnsupported")}
        </p>
      ) : status === "upcoming" ? (
        <p
          className="mono"
          style={{
            margin: 0,
            fontSize: 11,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
          }}
        >
          {t("oddinVideo.armed")}
        </p>
      ) : null}
    </div>
  );
}
