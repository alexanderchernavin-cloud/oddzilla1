"use client";

// Sportradar Live Match Tracker (LMT Plus), embedded through Sportradar's
// HOSTED standalone widget page rather than the `SIR('addWidget', ...)`
// widgetloader snippet.
//
// Why the iframe: the widgetloader licenses per EMBEDDING ORIGIN. The loader
// calls `/<clientId>/licensing`, which keys on the page's origin, and the LMT
// data feed carries an origin-bound signed token, so the check is end to end.
// Until Sportradar issues Oddzilla's own Client ID, the public `betradar`
// client is licensed only for localhost and Sportradar's own hosts — a direct
// integration on oddzilla.cc gets `No packages licensed for "oddzilla.cc"`.
// The standalone page at
//   https://widgets.sir.sportradar.com/<client>/<lang>/standalone/<widget>
// runs ON a licensed origin and is served without `frame-ancestors`, so it
// embeds from any domain (the demo page, by contrast, is locked to Sportradar
// frame ancestors). Sportradar confirmed this interim path in writing
// (2026-09-04). When the Client ID arrives: swap `betradar` for it, get
// oddzilla.cc whitelisted, and optionally move to the direct loader for
// theming, odds adapters and `onSizeChange` auto-height.
//
// Two things about the standalone page's contract (read from its source):
//   - widget props ride in the URL HASH, `key=value&key=value` — the query
//     string is ignored. Values are JSON.parse'd where they parse, so
//     `expanded=true` arrives as a boolean. `wl-` prefixed keys are
//     widgetloader options (wl-theme, wl-language), `adapter-` prefixed keys
//     register an odds adapter.
//   - it re-reads the hash on `hashchange`, so changing a prop only changes
//     the src hash; the iframe does not reload.
// There is no cross-origin resize message, so the height is ours to pick —
// see the collapse handling below.
//
// `matchId` is a SPORTRADAR match id, not an Oddin `od:match:N` or a
// Fonbet `fb:match:N`. Neither feed carries one, so the mapping is stored
// (migration 0100, `match_sportradar_ids`) and managed at
// /admin/sportradar. The caller passes an operator-CONFIRMED pair; this
// component never guesses.

import { useEffect, useState } from "react";
import { useTranslations } from "@/lib/i18n";

interface Props {
  /** Sportradar (Betradar) match id, e.g. 72221238. */
  srMatchId: number;
  /** Sportradar sport id; soccer is 1. */
  sportId?: number;
  layout?: "single" | "double" | "topdown";
  /** Widget client alias in the standalone URL. `betradar` is the public one. */
  client?: string;
  /** Two-letter widget language. */
  language?: string;
  /** Fixed iframe height in px — the hosted page cannot report its size. */
  height?: number;
}

const HOST = "https://widgets.sir.sportradar.com";

// Sportradar's Virtualised LMT — the 3D/bird's-eye pitch rendered from
// skeletal tracking data — covers soccer and basketball only (read from
// the demo bundle's `WIDGETS_LIST` for demo.vlmt / demo.vlmt-light,
// 2026-09-05). We enable the LIGHT variant, which is the bird's-eye
// build meant for lower-end devices and the only one that takes a pitch
// view; `vlmtLightPitchView` is that setting, and the operator asked for
// the top-down view. On a fixture without tracking data the widget falls
// back to the ordinary LMT pitch on its own.
const VLMT_SPORT_IDS = new Set([1, 2]);

// The mobile breakpoint the rest of the shell uses (globals.css swaps the
// compact scoreboard variables at the same width).
const MOBILE_MAX_WIDTH = 1099;

// Heights. The hosted page can't tell us how tall it is, so these are
// chosen to fit the two states rather than measured: collapsed shows the
// scoreboard plus the momentum strip (what `collapseTo=momentum` leaves
// behind), expanded shows the pitch and the tab strip under it.
const COLLAPSED_HEIGHT = 260;

export function buildLmtStandaloneUrl({
  srMatchId,
  sportId = 1,
  layout = "single",
  client = "betradar",
  language = "en",
  expanded = true,
}: Omit<Props, "height"> & { expanded?: boolean }): string {
  const parts = [
    `matchId=${srMatchId}`,
    `sportId=${sportId}`,
    `layout=${layout}`,
    // Collapsing leaves the scoreboard + momentum strip visible, which is
    // the compact state the operator picked in Sportradar's configurator.
    `collapseTo=momentum`,
    `expanded=${expanded ? "true" : "false"}`,
  ];
  if (VLMT_SPORT_IDS.has(sportId)) {
    parts.push(
      "enableVirtualised=true",
      "enableVirtualisedLight=true",
      "vlmtLightPitchView=top",
    );
  }
  return `${HOST}/${encodeURIComponent(client)}/${encodeURIComponent(language)}/standalone/match.lmtPlus#${parts.join("&")}`;
}

export function SportradarLmt({ height = 620, ...rest }: Props) {
  const t = useTranslations("matchWidgets");

  // Desktop opens expanded, mobile opens collapsed. Resolved after mount
  // rather than in the initializer so SSR and hydration agree on the same
  // markup; the hash change that follows on a phone is same-document, so
  // the iframe re-reads its props without reloading.
  const [isMobile, setIsMobile] = useState(false);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
    const apply = (matches: boolean) => {
      setIsMobile(matches);
      setExpanded(!matches);
    };
    apply(mq.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const src = buildLmtStandaloneUrl({ ...rest, expanded });
  // The widget carries its own expand control, but it lives inside the
  // iframe and cannot tell us it was used — so on mobile we drive the
  // state from outside, where we can also give the frame the height the
  // new state needs. On desktop the widget starts expanded and the
  // in-frame control is enough.
  const frameHeight = expanded ? height : COLLAPSED_HEIGHT;

  return (
    <section
      data-oz-track="sportradar-lmt"
      style={{ display: "flex", flexDirection: "column" }}
    >
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
          {t("lmt.title")}
        </span>
        {isMobile ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mono"
            style={{
              marginLeft: "auto",
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--fg-muted)",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 999,
              padding: "3px 10px",
              cursor: "pointer",
            }}
          >
            {expanded ? t("lmt.collapse") : t("lmt.expand")}
          </button>
        ) : null}
      </div>
      <iframe
        src={src}
        title={t("lmt.title")}
        loading="lazy"
        style={{
          width: "100%",
          height: frameHeight,
          border: "1px solid var(--border)",
          borderRadius: 10,
          background: "var(--surface-2)",
          display: "block",
        }}
      />
    </section>
  );
}
