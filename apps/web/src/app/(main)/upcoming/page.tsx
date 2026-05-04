import { serverApi } from "@/lib/server-fetch";
import { type ListMatch } from "@/components/match/match-row";
import { MatchListTabs } from "@/components/match/match-list-tabs";

interface ListMatchWithSport extends ListMatch {
  sport: { slug: string; name: string };
}

interface Response {
  matches: ListMatchWithSport[];
  topConfiguredSports?: Record<string, boolean>;
}

export default async function UpcomingPage() {
  const data = await serverApi<Response>(
    "/catalog/matches?status=upcoming&limit=120",
  );
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
          Upcoming
        </h1>
        <div
          className="mono tnum"
          style={{ fontSize: 12, color: "var(--fg-muted)" }}
        >
          {matches.length} {matches.length === 1 ? "match" : "matches"}
        </div>
      </header>

      {matches.length === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          No upcoming matches scheduled.
        </p>
      ) : (
        <MatchListTabs
          matches={matches}
          sportSlug={(m) => (m as ListMatchWithSport).sport.slug}
          sportShort={(m) => shortName((m as ListMatchWithSport).sport.name)}
          topConfigured={(m) =>
            !!data?.topConfiguredSports?.[(m as ListMatchWithSport).sport.slug]
          }
        />
      )}
    </div>
  );
}

function shortName(name: string): string {
  if (name === "Counter-Strike 2") return "CS2";
  if (name === "League of Legends") return "LoL";
  if (name === "Dota 2") return "Dota 2";
  if (name === "Rocket League") return "RL";
  return name;
}
