import { serverApi } from "@/lib/server-fetch";
import { MatchRow, type ListMatch } from "@/components/match/match-row";

interface ListMatchWithSport extends ListMatch {
  sport: { slug: string; name: string };
}

interface Response {
  matches: ListMatchWithSport[];
}

export default async function LivePage() {
  const data = await serverApi<Response>("/catalog/matches?status=live&limit=120");
  const matches = orderBySport(data?.matches ?? []);

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
          Live now
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
          Nothing live right now. Check back soon.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {matches.map((m) => (
            <MatchRow
              key={m.id}
              match={m}
              sportSlug={m.sport.slug}
              sportShort={shortName(m.sport.name)}
            />
          ))}
        </div>
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

// Mirror the sidebar's sport ordering: flagship esports pinned on top,
// everything else alphabetical by display name. Keep the API's inner
// sort (newest first) stable within each sport group.
const TOP_SPORTS = ["cs2", "dota2", "lol", "valorant"] as const;

function orderBySport(matches: ListMatchWithSport[]): ListMatchWithSport[] {
  const rank = (slug: string) => {
    const i = (TOP_SPORTS as readonly string[]).indexOf(slug);
    return i === -1 ? TOP_SPORTS.length : i;
  };
  return [...matches].sort((a, b) => {
    const ra = rank(a.sport.slug);
    const rb = rank(b.sport.slug);
    if (ra !== rb) return ra - rb;
    if (ra === TOP_SPORTS.length) {
      const byName = a.sport.name.localeCompare(b.sport.name);
      if (byName !== 0) return byName;
    }
    return 0;
  });
}
