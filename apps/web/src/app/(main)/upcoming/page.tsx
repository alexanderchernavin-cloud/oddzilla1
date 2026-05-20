import { serverApi } from "@/lib/server-fetch";
import { type ListMatch } from "@/components/match/match-row";
import {
  MatchListTabs,
  type ListMatchEnriched,
} from "@/components/match/match-list-tabs";
import { I } from "@/components/ui/icons";
import { ZillaFlashRow } from "@/components/lobby/zillaflash-row";
import { shortName } from "@/lib/sport-order";
import { getTranslations } from "@/lib/i18n/server";

interface ListMatchWithSport extends ListMatch {
  sport: { slug: string; name: string };
}

interface Response {
  matches: ListMatchWithSport[];
}

function enrich(m: ListMatchWithSport): ListMatchEnriched {
  return {
    ...m,
    _sportSlug: m.sport.slug,
    _sportShort: shortName(m.sport.name),
  };
}

export default async function UpcomingPage() {
  const [data, tMatch, tSport] = await Promise.all([
    serverApi<Response>("/catalog/matches?status=upcoming&limit=120"),
    // Use the "match" namespace so the heading reads "Pre-match" —
    // same label the lobby's LobbyTabLink uses for the prematch tab.
    // The page route stays /upcoming for link/bookmark stability.
    getTranslations("match"),
    getTranslations("sport"),
  ]);
  const matches = data?.matches ?? [];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 20,
        padding: "28px 32px 60px",
      }}
    >
      {/* Prematch-only ZillaFlash boosts. Same engine, kind-filtered. */}
      <ZillaFlashRow kind="prematch" />

      {matches.length === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          {tSport("noMatches")}
        </p>
      ) : (
        // Page heading sits ON the MatchListTabs section-head row so it
        // shares a line with the cols toggle (same pattern /live uses).
        <MatchListTabs
          matches={matches.map(enrich)}
          groups={[
            {
              key: "upcoming",
              label: <UpcomingPageHeading label={tMatch("prematch")} count={matches.length} />,
              matches: matches.map(enrich),
            },
          ]}
        />
      )}
    </div>
  );
}

// Page heading rendered inline with the MatchListTabs cols toggle on the
// section-head row. Visual mirror of the home lobby's LobbyTabLink for
// prematch (Clock icon, neutral count pill) — but as plain text since
// we're already on /upcoming (no navigation target).
function UpcomingPageHeading({ label, count }: { label: string; count: number }) {
  return (
    <h1
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        margin: 0,
        fontSize: 22,
        fontWeight: 500,
        letterSpacing: "-0.015em",
        lineHeight: 1.1,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          color: "var(--fg-muted)",
        }}
        aria-hidden
      >
        <I.Clock size={18} />
      </span>
      {label}
      <span
        className="mono tnum"
        style={{
          display: "inline-flex",
          alignItems: "center",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--fg-muted)",
          border: "1px solid var(--border)",
          borderRadius: 999,
          padding: "2px 8px",
          lineHeight: 1.2,
        }}
      >
        {count}
      </span>
    </h1>
  );
}

