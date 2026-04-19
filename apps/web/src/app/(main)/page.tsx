import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import { MatchRow, type ListMatch } from "@/components/match/match-row";
import { SectionHeader } from "@/components/match/section-header";
import { SportGlyph } from "@/components/ui/sport-glyph";

interface SportsResponse {
  sports: Array<{ id: number; slug: string; name: string; kind: string; active: boolean }>;
}

interface SportDetail {
  sport: { id: number; slug: string; name: string };
  matches: ListMatch[];
}

const TOP_SPORTS = 4;

export default async function HomePage() {
  const [sportsRes, liveCountsRes] = await Promise.all([
    serverApi<SportsResponse>("/catalog/sports"),
    serverApi<Record<string, number>>("/catalog/live-counts"),
  ]);

  const sports = sportsRes?.sports ?? [];
  const liveCounts = liveCountsRes ?? {};

  // Top sports by live count, fall back to alphabetical order if no live
  // counts (e.g. all zero on a quiet morning).
  const topSports = sports
    .slice()
    .sort(
      (a, b) =>
        (liveCounts[b.slug] ?? 0) - (liveCounts[a.slug] ?? 0) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, TOP_SPORTS);

  const details = await Promise.all(
    topSports.map((s) => serverApi<SportDetail>(`/catalog/sports/${s.slug}?limit=8`)),
  );

  const allMatches: Array<{ match: ListMatch; sportSlug: string; sportShort: string }> = [];
  details.forEach((d, i) => {
    const s = topSports[i];
    if (!d || !s) return;
    const sportShort = shortName(s.name);
    for (const m of d.matches) {
      allMatches.push({ match: m, sportSlug: s.slug, sportShort });
    }
  });

  const live = allMatches.filter((x) => x.match.status === "live");
  const upcoming = allMatches.filter((x) => x.match.status === "not_started");

  const dayLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 32,
        padding: "28px 32px 60px",
        maxWidth: 1100,
      }}
    >
      <header>
        <div
          className="mono"
          style={{
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
          }}
        >
          Today · {dayLabel}
        </div>
        <h1
          className="display"
          style={{
            margin: "6px 0 0",
            fontSize: "clamp(26px, 6.5vw, 40px)",
            fontWeight: 500,
            letterSpacing: "-0.025em",
            lineHeight: 1.05,
          }}
        >
          {live.length === 0 ? (
            <>
              No live matches right now.
              <br />
              <span style={{ color: "var(--fg-muted)" }}>
                {upcoming.length} coming up today.
              </span>
            </>
          ) : (
            <>
              {live.length} {live.length === 1 ? "match" : "matches"} live now.
              <br />
              <span style={{ color: "var(--fg-muted)" }}>
                {upcoming.length} more coming up.
              </span>
            </>
          )}
        </h1>
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {orderSportsForChips(sports).slice(0, 10).map((s) => (
          <Link
            key={s.slug}
            href={`/sport/${s.slug}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              height: 34,
              padding: "0 14px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 999,
              textDecoration: "none",
              color: "var(--fg)",
              fontSize: 12.5,
            }}
          >
            <SportGlyph sport={s.slug} size={14} />
            {s.name}
            {liveCounts[s.slug] ? (
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>
                {liveCounts[s.slug]}
              </span>
            ) : null}
          </Link>
        ))}
      </div>

      {live.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <SectionHeader kicker="Live" title="In play" count={live.length} />
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--gap, 12px)" }}>
            {live.map((x) => (
              <MatchRow
                key={x.match.id}
                match={x.match}
                sportSlug={x.sportSlug}
                sportShort={x.sportShort}
              />
            ))}
          </div>
        </section>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <SectionHeader kicker="Upcoming" title="Next up today" count={upcoming.length} />
        {upcoming.length === 0 ? (
          <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
            Nothing scheduled in the top sports. Check individual sport pages for the
            full slate.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--gap, 12px)" }}>
            {upcoming.slice(0, 20).map((x) => (
              <MatchRow
                key={x.match.id}
                match={x.match}
                sportSlug={x.sportSlug}
                sportShort={x.sportShort}
              />
            ))}
          </div>
        )}
      </section>
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

// Mirror the sidebar ordering: flagship esports pinned first, remainder
// alphabetical by display name, bot leagues hidden defensively.
const TOP_SPORT_SLUGS = ["cs2", "dota2", "lol", "valorant"] as const;
const HIDDEN_SPORT_SLUGS = new Set<string>(["efootballbots", "ebasketballbots"]);

function orderSportsForChips<T extends { slug: string; name: string }>(
  items: T[],
): T[] {
  const visible = items.filter((s) => !HIDDEN_SPORT_SLUGS.has(s.slug));
  const rank = (slug: string) => {
    const i = (TOP_SPORT_SLUGS as readonly string[]).indexOf(slug);
    return i === -1 ? TOP_SPORT_SLUGS.length : i;
  };
  return [...visible].sort((a, b) => {
    const ra = rank(a.slug);
    const rb = rank(b.slug);
    if (ra !== rb) return ra - rb;
    if (ra === TOP_SPORT_SLUGS.length) return a.name.localeCompare(b.name);
    return 0;
  });
}
