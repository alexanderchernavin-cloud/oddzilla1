"use client";

// Sportradar Head to Head — form, previous meetings, per-team season
// stats and a win-probability split for one fixture.
//
// Same embedding story as the tracker next door (sportradar-lmt.tsx): the
// widgetloader licenses per embedding ORIGIN and oddzilla.cc is not on the
// public `betradar` client's list yet, so we frame Sportradar's own hosted
// standalone page, which runs on a licensed origin and ships without
// `frame-ancestors`. Props ride in the URL hash and the page re-reads them
// on `hashchange`.
//
// `layout=inline` renders the panel in the page flow. The widget's other
// layout, `overlay`, expects a host button to pop it open — that is the
// shape Bet Assist uses, not this one: here the rail IS the surface.
//
// Height is fixed because the hosted page cannot report its size across
// origins, and it is sized to the tab the widget OPENS on, not to its
// tallest one. That first tab (competition line, score, both crests,
// card chips) measured ~245px on two live fixtures with a ruler overlaid
// on the stretched frame at the rail's 348px width on production
// (2026-09-05), and the stats-comparison tab ~200px; the frame had been
// 560, which left ~315px of
// the hosted page's blank white under it — reported as "too much empty
// space". The other tabs (game pulse, lineups, season table, previous
// meetings) are taller and scroll inside the frame, which they did at
// 560 as well; a rail this narrow was never going to show a lineup
// whole. Erring tall costs a blank band on every visit; erring short
// costs a scrollbar on the tabs a bettor opens on purpose.

import { useTranslations } from "@/lib/i18n";

const HOST = "https://widgets.sir.sportradar.com";

interface Props {
  /** Sportradar match id from a CONFIRMED mapping row. */
  srMatchId: number;
  /** Sportradar sport id — picks the sport's stat set. */
  srSportId: number;
  client?: string;
  language?: string;
  height?: number;
}

export function buildHeadToHeadStandaloneUrl({
  srMatchId,
  srSportId,
  client = "betradar",
  language = "en",
}: Omit<Props, "height">): string {
  const hash = [
    `matchId=${srMatchId}`,
    `sportId=${srSportId}`,
    "layout=inline",
  ].join("&");
  return `${HOST}/${encodeURIComponent(client)}/${encodeURIComponent(language)}/standalone/headToHead.standalone#${hash}`;
}

export function SportradarHeadToHead({ height = 280, ...rest }: Props) {
  const t = useTranslations("matchWidgets");
  const src = buildHeadToHeadStandaloneUrl(rest);

  return (
    <section
      data-oz-track="sportradar-h2h"
      aria-label={t("h2h.title")}
      style={{
        borderTop: "1px solid var(--hairline)",
        padding: "14px 16px 4px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--fg-muted)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {t("h2h.title")}
        </span>
      </div>
      <iframe
        src={src}
        title={t("h2h.title")}
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
