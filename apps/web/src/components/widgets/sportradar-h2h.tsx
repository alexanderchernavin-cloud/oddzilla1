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
// origins. The panel is long (game pulse, averages, previous meetings,
// both teams' form tables), so the frame scrolls internally rather than
// pretending to fit — a rail this narrow could not show it all anyway.

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

export function SportradarHeadToHead({ height = 560, ...rest }: Props) {
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
