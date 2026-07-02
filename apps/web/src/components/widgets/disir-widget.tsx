"use client";

// Generic Oddin Disir widget. Fetches the iframe URL from our /widgets
// API proxy (which talks to api-disir.oddin.gg with the brand token),
// renders the iframe, and adapts to its postMessage events:
//
//   LOADED  → mark loaded, hide the skeleton
//   RESIZE  → resize the iframe to the height the widget reports
//   DATA    → live widgets only — toggle visibility based on data.available
//   CLOSE   → bubble to parent via onClose (when allowClose=true upstream)
//
// The widget URL is short-lived for live, stable for prematch; we still
// re-fetch on remount because the API proxy caches with a 2-minute TTL
// and a stale URL during a token rotation would be hard to debug.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { useDocumentTheme } from "@/lib/use-theme";

type Variant = "prematch-match" | "prematch-tournament" | "live-scoreboard";

interface DisirWidgetProps {
  variant: Variant;
  // For prematch-match / live-scoreboard: numeric matches.id (string).
  // For prematch-tournament: numeric tournaments.id (string).
  id: string;
  // When omitted, the widget tracks the storefront's current theme
  // via <html data-theme> (see useDocumentTheme) and re-fetches the
  // upstream URL whenever the user toggles between light and dark.
  // Pass an explicit value to lock the widget to one theme.
  theme?: "dark" | "light";
  // Tab/timeframe — prematch-match only.
  tab?: "teams" | "players" | "tournament" | "stats" | "ranking";
  timeframe?: "ONE_MONTH" | "TWO_MONTHS" | "THREE_MONTHS";
  language?: string;
  // When true, the widget renders a Close button in its header that
  // emits a CLOSE postMessage. Useful for modal / drawer placement.
  allowClose?: boolean;
  onClose?: () => void;
  // When true, the wrapping div is `display:none` until a `DATA:
  // {available: true}` postMessage arrives. Per the Disir doc, "If the
  // Widgets are not initially available for an event, the DATA
  // notification will not be sent" — so for live widgets this would
  // mean hiding the iframe forever whenever the upstream data hasn't
  // landed yet. Default off; the iframe renders Oddin's own
  // "Live stats not available" empty state when data is missing,
  // which is more discoverable than an invisible widget.
  hideUntilData?: boolean;
  // Container className/style for layout integration (e.g. fixed-aspect
  // wrapper around the iframe).
  className?: string;
  style?: CSSProperties;
  // Initial iframe height before the first RESIZE event.
  minHeight?: number;
  title?: string;
  // Reports load + data-availability state to the parent so it can
  // hide a wrapping container when the widget has nothing to show.
  // Called with `null` while loading the URL, `true` after LOADED (and
  // for live widgets DATA: true), `false` if DATA: false arrives.
  onAvailabilityChange?: (state: WidgetAvailability) => void;
}

export type WidgetAvailability = "loading" | "available" | "unavailable" | "error";

interface DisirIframeMessage {
  type: "LOADED" | "DATA" | "CLOSE" | "RESIZE" | "SCROLL_TOP";
  height?: number;
  available?: boolean;
}

function widgetPath(variant: Variant, id: string): string {
  switch (variant) {
    case "prematch-match":
      return `/widgets/match/${encodeURIComponent(id)}/prematch`;
    case "prematch-tournament":
      return `/widgets/tournament/${encodeURIComponent(id)}/prematch`;
    case "live-scoreboard":
      return `/widgets/match/${encodeURIComponent(id)}/live`;
  }
}

function buildQuery(
  props: DisirWidgetProps,
  effectiveTheme: "dark" | "light",
): string {
  const qs = new URLSearchParams();
  qs.set("theme", effectiveTheme);
  if (props.language) qs.set("language", props.language);
  if (props.allowClose) qs.set("allowClose", "true");
  if (props.variant === "prematch-match") {
    if (props.tab) qs.set("tab", props.tab);
    if (props.timeframe) qs.set("timeframe", props.timeframe);
  }
  const s = qs.toString();
  return s.length > 0 ? `?${s}` : "";
}

export function DisirWidget(props: DisirWidgetProps) {
  const {
    variant,
    id,
    minHeight = variant === "live-scoreboard" ? 220 : 480,
    title,
    onAvailabilityChange,
    onClose,
    hideUntilData = false,
    className,
    style,
  } = props;

  // Follow the storefront theme unless the caller pinned one explicitly.
  // The hook returns a fresh value whenever <html data-theme> changes,
  // so toggling theme triggers a new querySig → re-fetch → new iframe URL.
  const documentTheme = useDocumentTheme();
  const effectiveTheme: "dark" | "light" = props.theme ?? documentTheme;

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number>(minHeight);
  const [loaded, setLoaded] = useState<boolean>(false);
  // For live widgets we hide the iframe until DATA: true. Prematch
  // widgets are visible from the start.
  const [dataAvailable, setDataAvailable] = useState<boolean>(!hideUntilData);

  // Stable query string so the URL fetch effect only refires on real
  // dependency changes.
  const querySig = useMemo(() => buildQuery(props, effectiveTheme), [
    effectiveTheme,
    props.language,
    props.allowClose,
    props.tab,
    props.timeframe,
    props.variant,
  ]);

  // Fetch the iframe URL whenever the (variant, id, query) tuple
  // changes. The endpoint is rate-limited and Redis-cached server-side,
  // so a quick remount during navigation is cheap.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setUrl(null);
    setError(null);
    setLoaded(false);
    setDataAvailable(!hideUntilData);
    onAvailabilityChange?.("loading");

    (async () => {
      try {
        const res = await clientApi<{ url: string }>(
          `${widgetPath(variant, id)}${querySig}`,
        );
        if (!cancelled) setUrl(res.url);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiFetchError) {
          // 503 widget_disabled = brand token missing in this env. Treat
          // as "unavailable" so the parent can render nothing instead
          // of an error message — feature gracefully off.
          if (err.body.error === "widget_disabled") {
            setError("disabled");
            onAvailabilityChange?.("unavailable");
            return;
          }
          if (err.body.error === "widget_not_available") {
            setError("not_available");
            onAvailabilityChange?.("unavailable");
            return;
          }
          setError(err.body.error);
        } else {
          setError("network");
        }
        onAvailabilityChange?.("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [variant, id, querySig, hideUntilData, onAvailabilityChange]);

  // Subscribe to the widget's postMessage events. Filter to messages
  // sourced from the rendered iframe so other iframes on the page
  // (e.g. the Twitch player) don't bleed events in.
  useEffect(() => {
    function handler(e: MessageEvent) {
      const iframe = iframeRef.current;
      if (!iframe || e.source !== iframe.contentWindow) return;
      if (typeof e.data !== "string") return;
      let parsed: DisirIframeMessage | null = null;
      try {
        const obj = JSON.parse(e.data) as DisirIframeMessage;
        if (obj && typeof obj.type === "string") parsed = obj;
      } catch {
        return;
      }
      if (!parsed) return;
      switch (parsed.type) {
        case "LOADED":
          setLoaded(true);
          if (!hideUntilData) onAvailabilityChange?.("available");
          break;
        case "RESIZE":
          if (typeof parsed.height === "number" && parsed.height > 0) {
            setHeight(Math.max(minHeight, Math.round(parsed.height)));
          }
          break;
        case "DATA":
          if (typeof parsed.available === "boolean") {
            setDataAvailable(parsed.available);
            onAvailabilityChange?.(
              parsed.available ? "available" : "unavailable",
            );
          }
          break;
        case "CLOSE":
          onClose?.();
          break;
        case "SCROLL_TOP":
          if (typeof window !== "undefined") {
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
          break;
      }
    }
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [minHeight, hideUntilData, onClose, onAvailabilityChange]);

  // Disabled or broken — render nothing. Parent decides whether to show
  // an empty state via the onAvailabilityChange callback.
  if (error === "disabled" || error === "not_available") return null;

  if (!url && error) {
    return (
      <div
        role="alert"
        style={{
          padding: 12,
          fontSize: 12,
          color: "var(--fg-muted)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          background: "var(--surface-2)",
          ...style,
        }}
        className={className}
      >
        Could not load widget. Please try again later.
      </div>
    );
  }

  const visible = !hideUntilData || dataAvailable;
  const showSkeleton = !loaded || !url;

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        minHeight,
        // Hide the live widget container fully when there's no data to
        // show — the iframe stays mounted underneath so we can flip the
        // state back on without a re-fetch when DATA: true arrives.
        display: visible ? "block" : "none",
        ...style,
      }}
    >
      {showSkeleton ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, var(--surface) 0%, var(--surface-2) 100%)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-dim)",
            fontSize: 12,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Loading widget…
        </div>
      ) : null}
      {url ? (
        <iframe
          ref={iframeRef}
          src={url}
          // Doc-recommended referrer policy: lets Disir's CDN see our
          // origin (required for parent-frame whitelisting) without
          // leaking full URLs.
          referrerPolicy="no-referrer-when-downgrade"
          // Sandbox is intentionally absent — the iframe needs full
          // capabilities (scripts, same-origin to api-disir.oddin.gg)
          // and the parent page CSP frame-src already restricts the
          // domains a widget URL can resolve to.
          allow="autoplay; clipboard-read; clipboard-write"
          loading="lazy"
          title={title ?? "Match widget"}
          style={{
            display: "block",
            width: "100%",
            height,
            border: 0,
            background: "transparent",
            // Disir prematch widgets ship their own card chrome; we
            // wrap with a subtle border so the panel doesn't look
            // floating against the rail/page.
            borderRadius: 10,
          }}
        />
      ) : null}
    </div>
  );
}
