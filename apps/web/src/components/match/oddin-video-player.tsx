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
   * Whether this is the source the viewer currently has selected. The player
   * stays MOUNTED when it isn't — tearing it down and back up on every tab
   * switch would re-resolve playback, fetch a fresh licence and restart from
   * the live edge — but it is paused, so a hidden player is not quietly
   * pulling a rights-metered stream in the background.
   */
  active: boolean;
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

// Low-latency is ON, targeting 4s behind the live edge. The history matters,
// because the obvious reading of this file is that LL should be off.
//
// Oddin's LL-HLS playlists are tight. A live 1080p60 playlist measured
// 2026-08-31 advertised:
//
//   #EXT-X-TARGETDURATION:2
//   #EXT-X-PART-INF:PART-TARGET=0.55
//   #EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.65
//
// carrying three 2s segments — the ENTIRE published window is ~6 seconds,
// the RFC 8216bis minimum. Delivery itself is fine: the window rolls in real
// time and a 2s segment fetches in 140-202ms (59-83 Mbit/s effective against
// a 6.1 Mbit/s rendition), so bandwidth was never the constraint.
//
// On that stream, playback died like this (measured in the page):
//
//   decoded: 0   dropped: 0   bufferAhead: -24.62   res: 1920x1080
//
// Zero decoded AND zero dropped rules out decode, GPU and compositing. The
// fault is the negative bufferAhead: currentTime had run 24.6s PAST the end
// of every buffered range, so there was nothing at the playhead to decode.
// hls.js does not recover from that — its gap jumping spans maxBufferHole
// (0.5s), not a 20s+ gulf.
//
// The trigger is NOT low-latency by itself. It is `autoplay: false` on a live
// LL stream, confirmed by reproduction on 2026-09-01: hls.js keeps nudging
// currentTime toward an advancing liveSyncPosition while a paused element
// never plays into the buffer, and the playhead is left stranded ahead of it.
// We ran LL off for a while, which also avoided it, but that cost ~3s of
// latency for the wrong reason.
//
// So LL is on, and the two things that make it safe are BOTH required:
//   - autoplay (muted), so the element is never sitting paused on a live edge
//   - the strand watchdog below, because autoplay is not guaranteed. Our own
//     Android WebView sets mediaPlaybackRequiresUserGesture = true and blocks
//     it outright, so that entire population starts paused.
//
// If you ever turn autoplay off again, turn LL off with it.
//
// 4s is ~2.4x PART-HOLD-BACK and two whole segments inside a 6s window. It
// can probably come down to ~2.5-3s now the watchdog exists, but do that
// deliberately and watch for strands. Going the other way, past ~6s, moves
// playback to the oldest segment in the window and risks eviction mid-fetch;
// cap ABR with `maxBitrate` instead.
const LIVE_LATENCY_TARGET_SECONDS = 4;

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

export function OddinVideoPlayer({ availability, active, onUnavailable }: Props) {
  const t = useTranslations("matchWidgets");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [drmUnsupported, setDrmUnsupported] = useState(false);

  const { matchUrn, baseUrl, apiKey, status, startsAt } = availability;

  // Held in a ref so the effect doesn't re-run — and tear the player down —
  // just because the parent re-rendered with a new callback identity.
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  // Same reasoning for `active`: the create effect reads it once to decide
  // whether to autoplay, and a separate effect below handles later changes.
  // Putting `active` in the create effect's deps would rebuild the player on
  // every tab switch.
  const activeRef = useRef(active);
  activeRef.current = active;

  // Lets the play/pause effect reach the player without re-creating it.
  const playerRef = useRef<Player | null>(null);

  useEffect(() => {
    if (!matchUrn || !baseUrl || !apiKey) return;
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let player: Player | null = null;
    let strandTimer: ReturnType<typeof setInterval> | null = null;

    setDrmUnsupported(false);

    // `?oddinLowLatency=1` restores the ORIGINAL failing configuration for a
    // single page load so the playback fault documented in docs/ODDIN.md can
    // be reproduced on demand.
    //
    // Now that low-latency is on in production too, this flag restores the
    // one remaining difference: autoplay off. The first cut flipped only lowLatency and
    // consequently never reproduced anything — by then muted autoplay had
    // shipped, and `autoplay: false` turns out to be the trigger: hls.js
    // keeps nudging currentTime toward an advancing liveSyncPosition while a
    // paused element never plays into the buffer, so currentTime ends up past
    // buffered.end (measured: bufferAhead -24.62). Confirmed by reproduction
    // 2026-09-01 — with autoplay off the picture advances one frame every
    // 5-6 seconds.
    //
    // The seek-to-live snap stays ON here, matching production, so this
    // differs from the shipped config in exactly those two settings.
    //
    // Opt-in, per page load, affects nobody who does not type it. Remove once
    // Oddin has closed the report.
    const reproMode =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("oddinLowLatency");

    // Ours to create and ours to remove — see the header note on why this
    // element must not come from React.
    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;
    // Deliberately no `preload="none"`. hls.js owns loading through MSE, so
    // it buys nothing here, and on a stream this tight it is one more reason
    // for the element to sit idle instead of filling its buffer.
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
          // Autoplay MUTED, the way every sportsbook plays a live match feed:
          // the picture is up the moment the page is, and the viewer unmutes
          // if they want sound. Browsers permit muted autoplay without a
          // gesture; if one blocks it anyway the SDK emits `autoplayblocked`
          // and `statusOverlays` puts a play CTA over the poster, so the
          // no-gesture case degrades to exactly the old behaviour.
          //
          // Only autoplays when this is the selected source — see the
          // play/pause effect below, which also pauses it on a tab switch so
          // a hidden player never pulls a rights-metered stream.
          // Repro mode restores autoplay:false, the original setting and the
          // suspected cause. Otherwise autoplay when this is the live tab.
          autoplay: reproMode ? false : activeRef.current,
          muted: true,
          controls: "custom",
          statusOverlays: true,
          theme: PLAYER_THEME,
          liveLatencyTarget: LIVE_LATENCY_TARGET_SECONDS,
          // Low-latency on. It is safe here because autoplay is on and the
          // strand watchdog below is a continuous recovery — see both notes.
          lowLatency: true,
          // Oddin's QoE beacon endpoint does not send CORS headers:
          //   POST https://beacons-dev.oddin-video.gg/v1/beacons
          //   blocked by CORS policy: no Access-Control-Allow-Origin
          // Every flush fails preflight, so no telemetry reaches them either
          // way — this only stops the console noise and the dead requests.
          // Re-enable once Oddin allow-lists the origin on that host.
          analytics: false,
          // Arm on an upcoming match. `kickoffAt` widens the poll cadence
          // when the viewer is armed long before the start.
          waitForLive: startsAt ? { kickoffAt: startsAt } : true,
        });

        if (disposed) {
          created.destroy();
          return;
        }
        player = created;
        playerRef.current = created;

        // Snap to the live edge the first time the viewer actually presses
        // play.
        //
        // hls.js pins its start position when it attaches. With autoplay off
        // the player sits armed while the live edge keeps advancing, so a
        // viewer who opens the page and presses play a minute later resumes
        // a minute behind live and has to hit the SDK's GO LIVE button to
        // catch up. Nobody wants to watch a live match on a delay they did
        // not ask for.
        //
        // First play only: a later pause/resume is a deliberate act and we
        // leave the GO LIVE control to handle it, rather than yanking the
        // viewer forward every time they come back.
        // Active in repro mode too, deliberately. Leaving it on keeps repro
        // mode differing from production in exactly two settings
        // (lowLatency + autoplay) instead of three, and answers a question
        // worth answering: does an explicit seek to the live edge rescue a
        // stranded playhead, or does it strand again straight after? Both
        // outcomes are informative — the first says the state is escapable,
        // the second that it is not.
        let snapped = false;
        created.on("playing", () => {
          if (snapped) return;
          snapped = true;
          try {
            created.seekToLive();
          } catch {
            // Non-fatal: worst case the viewer starts slightly behind and
            // the GO LIVE button is right there.
          }
        });

        // Strand watchdog.
        //
        // The failure mode this integration hit: currentTime ends up PAST the
        // end of every buffered range, so there is nothing at the playhead to
        // decode and playback dies without erroring (measured: decoded 0,
        // dropped 0, bufferAhead -24.62). hls.js does not recover — its gap
        // jumping spans maxBufferHole, 0.5s, not a 20s+ gulf.
        //
        // Confirmed trigger is a paused element on a live LL-HLS stream, so
        // the seek-to-live on first play covers the common case. It fires
        // ONCE though, and our own Android app sets
        // mediaPlaybackRequiresUserGesture = true, which blocks autoplay
        // outright — every Android viewer therefore starts paused and depends
        // on that single rescue. A second strand later in the session would
        // have nothing left to save it.
        //
        // So: check periodically, and seek to live whenever the playhead is
        // outside the buffer while we are supposed to be playing. Cheap (two
        // property reads), idempotent, and self-limiting via SEEK_COOLDOWN so
        // a genuinely broken stream cannot become a seek loop.
        const STRAND_TOLERANCE_S = 1;
        const SEEK_COOLDOWN_MS = 5000;
        let lastRescueAt = 0;
        strandTimer = setInterval(() => {
          if (video.paused || video.seeking) return;
          const ranges = video.buffered;
          if (ranges.length === 0) return;
          const end = ranges.end(ranges.length - 1);
          if (video.currentTime <= end + STRAND_TOLERANCE_S) return;
          const now = Date.now();
          if (now - lastRescueAt < SEEK_COOLDOWN_MS) return;
          lastRescueAt = now;
          try {
            created.seekToLive();
          } catch {
            // Nothing useful to do; the next tick will try again.
          }
        }, 3000);

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
      if (strandTimer) {
        clearInterval(strandTimer);
        strandTimer = null;
      }
      try {
        player?.destroy();
      } catch {
        // A half-initialised player can throw on teardown; nothing useful
        // to do about it, and it must not break unmount.
      }
      player = null;
      playerRef.current = null;
      container.replaceChildren();
    };
  }, [matchUrn, baseUrl, apiKey, startsAt]);

  // Follow the source selection. The player is kept alive behind a hidden
  // container so switching back is instant, which means it would otherwise
  // keep streaming while the viewer watches Twitch — pause it instead.
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    if (active) {
      void p.play().catch(() => {
        // Autoplay policy, or a race with teardown. The SDK's own play
        // control is on screen either way.
      });
    } else {
      p.pause();
    }
  }, [active]);

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
