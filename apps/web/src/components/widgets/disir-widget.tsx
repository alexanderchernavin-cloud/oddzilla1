"use client";

// Generic Oddin Disir widget. Fetches the iframe URL from our /widgets
// API proxy (which asks api-disir.oddin.gg for it, or builds the same
// URL itself when api-disir is down — see
// services/api/src/modules/widgets/disir-url.ts), renders the iframe,
// and adapts to its postMessage events:
//
//   LOADED  → mark loaded, hide the skeleton
//   RESIZE  → resize the iframe to the height the widget reports
//   DATA    → live widgets only — toggle visibility based on data.available
//   CLOSE   → bubble to parent via onClose (when allowClose=true upstream)
//
// Nothing in a widget URL expires — it is a deterministic URL whose only
// time-bound part is a cache-buster. We still re-fetch on remount
// because the theme and tab are part of the URL, and the proxy's cache
// makes the refetch cheap.
//
// A widget that never reports LOADED is collapsed after LOAD_TIMEOUT_MS.
// The widget host answers a 403 page INSIDE the iframe when it refuses
// the brand token or the embedding domain, and that page sends no
// postMessage at all — without the timeout the skeleton would sit there
// for as long as the match page is open.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { clientApi, ApiFetchError, apiAssetBase } from "@/lib/api-client";
import { useDocumentTheme } from "@/lib/use-theme";
import { useTranslations } from "@/lib/i18n";
import { BifrostMatchFrame } from "./bifrost-match-frame";

type Variant = "prematch-match" | "prematch-tournament" | "live-scoreboard";

// Generous on purpose: a healthy widget reports LOADED within a few
// seconds, but a phone on a slow link must not have a working widget
// hidden from under it. Too short hides; too long only delays the
// collapse of a widget that was never going to load.
const LOAD_TIMEOUT_MS = 20_000;

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
  // When our brand token is refused (no LOADED within LOAD_TIMEOUT_MS, or
  // api-disir answers 401), try the whitelisting-independent proxy before
  // giving up: the api serves the REAL Disir widget from our own origin
  // with MaxBet's token (see services/api/src/modules/widgets/disir-proxy.ts).
  // It renders the same widget as the primary path — same postMessage
  // events, all variants including the tournament — so it is preferred
  // over the Bifrost frame. Only if the proxy ALSO fails do we fall to
  // Bifrost (match) or collapse.
  proxyFallback?: boolean;
  // Last resort: when the widget host refuses our brand token (no LOADED
  // within LOAD_TIMEOUT_MS, or api-disir answers 401 with no backup token),
  // render Oddin's own Bifrost match frame in this widget's place instead
  // of nothing — see bifrost-match-frame.tsx. Match variants only; the
  // tournament widget has no Bifrost counterpart.
  bifrostFallback?: boolean;
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
    proxyFallback = false,
    bifrostFallback = false,
    className,
    style,
  } = props;
  const canFallBackToBifrost = bifrostFallback && variant !== "prematch-tournament";

  const t = useTranslations("matchWidgets");
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
  // "primary" = the widget URL from /widgets/*; "proxy" = the same-origin
  // proxy document (MaxBet's token) we switch to when the primary fails.
  const [phase, setPhase] = useState<"primary" | "proxy">("primary");

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
    setPhase("primary");
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

  // Collapse a widget that never reports LOADED (see the header comment:
  // a widget-host 403 renders inside the iframe and says nothing). The
  // parent hides its section exactly as it does for `widget_not_available`.
  // The timer restarts on every new URL and is cancelled the moment
  // LOADED arrives.
  useEffect(() => {
    if (!url || loaded) return;
    const timer = setTimeout(() => {
      setError("timeout");
      // With the Bifrost fallback the panel is about to be filled again,
      // and the frame reports its own availability.
      if (!canFallBackToBifrost && !proxyFallback) onAvailabilityChange?.("unavailable");
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [url, loaded, onAvailabilityChange, canFallBackToBifrost, proxyFallback]);

  // The primary widget failed in a way the proxy can rescue (token
  // refused → api-disir 401, or a widget-host 403 that shows up as the
  // LOADED timeout). Fetch the same-origin proxy document and hand the
  // iframe to it. If the proxy is not configured or is itself down, mark
  // the phase exhausted so the Bifrost / collapse branch takes over.
  const proxyPending =
    proxyFallback &&
    phase === "primary" &&
    (error === "timeout" || error === "widget_provider_unauthorized");
  useEffect(() => {
    if (!proxyPending) return;
    let cancelled = false;
    (async () => {
      try {
        const qp = new URLSearchParams(querySig.startsWith("?") ? querySig.slice(1) : querySig);
        if (variant === "live-scoreboard") qp.set("kind", "live");
        const suffix = qp.toString();
        const base =
          variant === "prematch-tournament"
            ? `/widgets/tournament/${encodeURIComponent(id)}/disir-proxy`
            : `/widgets/match/${encodeURIComponent(id)}/disir-proxy`;
        const res = await clientApi<{ url: string }>(
          `${base}${suffix ? `?${suffix}` : ""}`,
        );
        if (cancelled) return;
        setPhase("proxy");
        setLoaded(false);
        setError(null);
        setDataAvailable(!hideUntilData);
        // res.url is a same-origin path (`/widgets/disir-app/...`); the api
        // base turns it into the URL the iframe loads.
        setUrl(`${apiAssetBase}${res.url}`);
      } catch {
        if (cancelled) return;
        // Proxy unavailable too — leave the terminal error, moved to the
        // proxy phase so the render no longer treats it as pending.
        setPhase("proxy");
        setError("timeout");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [proxyPending, variant, id, querySig, hideUntilData]);

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

  // The widget host refused our token (a 403 page inside the iframe posts
  // nothing, so it shows up as the LOADED timeout) or api-disir did — and
  // the proxy (if enabled) has already been tried and failed. Hand the
  // panel to Bifrost's frame. While a proxy switch is pending we keep the
  // skeleton up instead, so this waits until the proxy phase is exhausted.
  if (
    canFallBackToBifrost &&
    !proxyPending &&
    (error === "timeout" || error === "widget_provider_unauthorized")
  ) {
    return (
      <BifrostMatchFrame
        matchId={id}
        theme={props.theme}
        language={props.language}
        height={variant === "live-scoreboard" ? 560 : 640}
        title={title}
        className={className}
        style={style}
        onAvailabilityChange={onAvailabilityChange}
      />
    );
  }

  // Disabled, no data, or never loaded — render nothing. Parent decides
  // whether to show an empty state via the onAvailabilityChange callback.
  // A timeout with a proxy switch still pending is NOT terminal — keep the
  // skeleton (below) while the proxy document loads.
  if (error === "disabled" || error === "not_available") return null;
  if (error === "timeout" && !proxyPending) return null;

  if (!url && error && !proxyPending) {
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
        {t("widget.loadError")}
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
          {t("widget.loading")}
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
          title={title ?? t("widget.fallbackTitle")}
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
