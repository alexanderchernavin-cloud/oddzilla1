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
//     string is ignored. `wl-` prefixed keys are widgetloader options
//     (wl-theme, wl-language), `adapter-` prefixed keys register an odds
//     adapter.
//   - it re-reads the hash on `hashchange`, so changing the match only
//     changes the src hash; the iframe does not reload.
// There is no cross-origin resize message, so the height is fixed.
//
// `matchId` is a SPORTRADAR match id, not an Oddin `od:match:N` or a
// Fonbet `fb:match:N`. Neither feed carries one, so the mapping is stored
// (migration 0100, `match_sportradar_ids`) and managed at
// /admin/sportradar. The caller passes an operator-CONFIRMED pair; this
// component never guesses.

import { useTranslations } from "@/lib/i18n";

interface Props {
  /** Sportradar (Betradar) match id, e.g. 72221238. */
  srMatchId: number;
  /** Sportradar sport id; soccer is 1. */
  sportId?: number;
  layout?: "single" | "double";
  /** Widget client alias in the standalone URL. `betradar` is the public one. */
  client?: string;
  /** Two-letter widget language. */
  language?: string;
  /** Fixed iframe height in px — the hosted page cannot report its size. */
  height?: number;
}

const HOST = "https://widgets.sir.sportradar.com";

export function buildLmtStandaloneUrl({
  srMatchId,
  sportId = 1,
  layout = "single",
  client = "betradar",
  language = "en",
}: Omit<Props, "height">): string {
  const hash = [
    `matchId=${srMatchId}`,
    `sportId=${sportId}`,
    `layout=${layout}`,
  ].join("&");
  return `${HOST}/${encodeURIComponent(client)}/${encodeURIComponent(language)}/standalone/match.lmtPlus#${hash}`;
}

export function SportradarLmt({ height = 620, ...rest }: Props) {
  const t = useTranslations("matchWidgets");
  const src = buildLmtStandaloneUrl(rest);

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
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
          }}
        >
          Sportradar
        </span>
      </div>
      <iframe
        src={src}
        title={t("lmt.title")}
        loading="lazy"
        style={{
          width: "100%",
          height,
          border: "1px solid var(--border)",
          borderRadius: 10,
          background: "var(--surface-2)",
          display: "block",
        }}
      />
    </section>
  );
}
