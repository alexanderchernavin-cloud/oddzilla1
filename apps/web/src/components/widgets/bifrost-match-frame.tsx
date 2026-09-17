"use client";

// Oddin's Bifrost front end, framed as the LAST-RESORT statistics
// surface for a match. DisirWidget swaps to this when the widget host
// refuses our brand token (see disir-widget.tsx); it is never the first
// choice, because it is Oddin's page in Oddin's layout.
//
// What it shows: Bifrost's non-betting match page — both teams with the
// per-map score, the Team / Players / Tournament statistics widget
// inline, a Stream tab and a Live stats tab. No markets, no bet slip.
// Why it renders when our own widgets do not: the Disir widget host
// checks the referring domain against the brand token, and inside this
// frame the referer is bifrost.oddin.gg, which is registered for the
// token Bifrost uses. The api composes the URL and the config message
// (services/api/src/modules/widgets/bifrost-embed.ts); this component
// only plays them back.
//
// The non-betting mode is switched on over postMessage AFTER the frame
// reports LOADED — the app validates `nonBetting` as a real boolean, so
// no URL parameter can set it. Until the app then reports the route
// change the frame stays invisible, so the betting page it boots on is
// never on screen. Bifrost posts no size, so the height is fixed and the
// page scrolls inside the frame.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { useDocumentTheme } from "@/lib/use-theme";
import type { WidgetAvailability } from "./disir-widget";

interface BifrostEmbed {
  url: string;
  configMessage: string;
  origin: string;
}

interface Props {
  // Numeric matches.id (string) or od:match URN — whatever the api's
  // resolveMatchUrn accepts.
  matchId: string;
  theme?: "dark" | "light";
  language?: string;
  height?: number;
  title?: string;
  className?: string;
  style?: CSSProperties;
  onAvailabilityChange?: (state: WidgetAvailability) => void;
}

// After the config message is posted the app navigates and reports the
// route change within a second or two; this is the ceiling before the
// frame is shown regardless, so a missed message costs a flash of the
// betting page rather than a blank panel forever.
const REVEAL_CEILING_MS = 4000;

export function BifrostMatchFrame({
  matchId,
  theme,
  language,
  height = 640,
  title,
  className,
  style,
  onAvailabilityChange,
}: Props) {
  const documentTheme = useDocumentTheme();
  const effectiveTheme: "dark" | "light" = theme ?? documentTheme;

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [embed, setEmbed] = useState<BifrostEmbed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const configSentRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setEmbed(null);
    setError(null);
    setRevealed(false);
    configSentRef.current = false;
    onAvailabilityChange?.("loading");
    const qs = new URLSearchParams();
    qs.set("theme", effectiveTheme);
    if (language) qs.set("language", language);
    (async () => {
      try {
        const res = await clientApi<BifrostEmbed>(
          `/widgets/match/${encodeURIComponent(matchId)}/bifrost?${qs.toString()}`,
        );
        if (!cancelled) setEmbed(res);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiFetchError ? err.body.error : "network");
        onAvailabilityChange?.("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [matchId, effectiveTheme, language, onAvailabilityChange]);

  useEffect(() => {
    if (!embed) return;
    let revealTimer: ReturnType<typeof setTimeout> | null = null;
    const reveal = () => {
      if (revealTimer) clearTimeout(revealTimer);
      revealTimer = null;
      setRevealed(true);
      onAvailabilityChange?.("available");
    };
    function handler(e: MessageEvent) {
      const iframe = iframeRef.current;
      if (!iframe || e.origin !== embed!.origin || e.source !== iframe.contentWindow) return;
      let type: string | null = null;
      try {
        const obj = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (obj && typeof obj.type === "string") type = obj.type;
      } catch {
        return;
      }
      if (type === "LOADED" && !configSentRef.current) {
        configSentRef.current = true;
        iframe.contentWindow?.postMessage(embed!.configMessage, embed!.origin);
        revealTimer = setTimeout(reveal, REVEAL_CEILING_MS);
      } else if (type === "ROUTE_CHANGE" && configSentRef.current) {
        reveal();
      }
    }
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      if (revealTimer) clearTimeout(revealTimer);
    };
  }, [embed, onAvailabilityChange]);

  if (error || !embed) return null;

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height,
        borderRadius: 10,
        overflow: "hidden",
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
        ...style,
      }}
    >
      <iframe
        ref={iframeRef}
        src={embed.url}
        title={title ?? "Match statistics"}
        allow="autoplay; fullscreen"
        loading="lazy"
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          border: 0,
          background: "transparent",
          visibility: revealed ? "visible" : "hidden",
        }}
      />
    </div>
  );
}
