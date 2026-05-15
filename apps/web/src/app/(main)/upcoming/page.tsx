import { serverApi } from "@/lib/server-fetch";
import { type ListMatch } from "@/components/match/match-row";
import {
  MatchListTabs,
  type ListMatchEnriched,
} from "@/components/match/match-list-tabs";
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
  const [data, t, tSport] = await Promise.all([
    serverApi<Response>("/catalog/matches?status=upcoming&limit=120"),
    getTranslations("shell"),
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
      <header style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h1
          className="display"
          style={{
            margin: 0,
            fontSize: 32,
            fontWeight: 500,
            letterSpacing: "-0.02em",
          }}
        >
          {t("upcoming")}
        </h1>
        <div
          className="mono tnum"
          style={{ fontSize: 12, color: "var(--fg-muted)" }}
        >
          {matches.length}
        </div>
      </header>

      {/* Prematch-only ZillaFlash boosts. Same engine, kind-filtered. */}
      <ZillaFlashRow kind="prematch" />

      {matches.length === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          {tSport("noMatches")}
        </p>
      ) : (
        <MatchListTabs matches={matches.map(enrich)} />
      )}
    </div>
  );
}

