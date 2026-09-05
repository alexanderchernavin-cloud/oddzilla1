"use client";

// Sportradar Live Table — the competition's standings "as it stands",
// shown in the right rail while a tournament view is open.
//
// Same hosted-standalone embed as the tracker and Head to Head next door
// (the licensing story lives in sportradar-lmt.tsx): props ride in the
// URL hash, the page re-reads them on `hashchange`, and nothing about
// the frame's size crosses the origin boundary, so the height is ours.
//
// The id is a MATCH id on purpose. `season.liveTable` resolves its
// season from any one of `matchId | tournamentId | uniqueTournamentId |
// seasonId` (read from the widget's own async-prop definition, chunk
// `season.liveTable`, 2026-09-05), and of those four we hold exactly
// one: migration 0100 maps matches, and no feed carries Sportradar's
// tournament ids at all. So the server hands us a confirmed fixture
// from the tournament and the widget walks to the table from there —
// no second id space to map, review and keep true.

import { useTranslations } from "@/lib/i18n";

const HOST = "https://widgets.sir.sportradar.com";

// Sports whose competitions are played as a LEAGUE, and so have a table
// to stand in. Tennis, table tennis, badminton, padel, squash and darts
// are draw or ranking formats — Sportradar has no standings for them,
// and since the hosted frame cannot tell us it rendered nothing, gating
// by sport is the only way to avoid shipping a dead 620px box. Table
// tennis alone is our second-largest mapped sport, so this is not a
// hypothetical. Extend the set if a mapped sport turns out to have a
// real table.
const TABLE_SPORT_IDS = new Set([
  1, // soccer
  2, // basketball
  3, // baseball
  4, // ice hockey
  6, // handball
  12, // rugby
  16, // american football
  23, // volleyball
  29, // futsal
]);

/** True when this Sportradar sport plays a league with a standings table. */
export function liveTableCoversSport(srSportId: number): boolean {
  return TABLE_SPORT_IDS.has(srSportId);
}

interface Props {
  /** Sportradar match id of a confirmed fixture in this tournament. */
  srMatchId: number;
  /** Sportradar sport id — the table's shape differs per sport. */
  srSportId: number;
  client?: string;
  language?: string;
  height?: number;
}

export function buildLiveTableStandaloneUrl({
  srMatchId,
  srSportId,
  client = "betradar",
  language = "en",
}: Omit<Props, "height">): string {
  const hash = [`matchId=${srMatchId}`, `sportId=${srSportId}`].join("&");
  return `${HOST}/${encodeURIComponent(client)}/${encodeURIComponent(language)}/standalone/season.liveTable#${hash}`;
}

export function SportradarLiveTable({ height = 620, ...rest }: Props) {
  const t = useTranslations("matchWidgets");
  const src = buildLiveTableStandaloneUrl(rest);

  return (
    <section
      data-oz-track="sportradar-live-table"
      aria-label={t("liveTable.title")}
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
          {t("liveTable.title")}
        </span>
      </div>
      {/*
        Full-bleed: the frame cancels the section's 16px side padding to
        buy back 32px of table width. A ten-column league table needs
        every pixel the rail can give it, and unlike the bet slip above
        it this is a data grid, not a card — running it edge to edge
        reads as deliberate rather than broken. Rounding and the side
        borders go with the padding for the same reason.
      */}
      <iframe
        src={src}
        title={t("liveTable.title")}
        loading="lazy"
        style={{
          width: "calc(100% + 32px)",
          maxWidth: "none",
          marginInline: -16,
          height,
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface-2)",
          display: "block",
        }}
      />
    </section>
  );
}
