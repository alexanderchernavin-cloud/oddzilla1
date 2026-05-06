import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import { type ListMatch } from "@/components/match/match-row";
import {
  MatchListTabs,
  type ListMatchEnriched,
} from "@/components/match/match-list-tabs";
import { SectionHeader } from "@/components/match/section-header";
import { SportGlyph } from "@/components/ui/sport-glyph";

interface SportsResponse {
  sports: Array<{ id: number; slug: string; name: string; kind: string; active: boolean }>;
}

interface ListMatchWithSport extends ListMatch {
  sport: { slug: string; name: string };
}

interface CrossSportResponse {
  matches: ListMatchWithSport[];
  topConfiguredSports?: Record<string, boolean>;
}

function enrich(
  m: ListMatchWithSport,
  topConfigured: Record<string, boolean>,
): ListMatchEnriched {
  return {
    ...m,
    _sportSlug: m.sport.slug,
    _sportShort: shortName(m.sport.name),
    _topConfigured: !!topConfigured[m.sport.slug],
  };
}

export default async function HomePage() {
  const [sportsRes, liveCountsRes, liveRes, upcomingRes] = await Promise.all([
    serverApi<SportsResponse>("/catalog/sports"),
    serverApi<Record<string, number>>("/catalog/live-counts"),
    serverApi<CrossSportResponse>("/catalog/matches?status=live&limit=120"),
    serverApi<CrossSportResponse>("/catalog/matches?status=upcoming&limit=60"),
  ]);

  const sports = sportsRes?.sports ?? [];
  const liveCounts = liveCountsRes ?? {};
  const live = orderMatchesBySport(liveRes?.matches ?? []);
  const upcoming = orderMatchesBySport(upcomingRes?.matches ?? []);

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

      {(() => {
        const topConfig: Record<string, boolean> = {
          ...(liveRes?.topConfiguredSports ?? {}),
          ...(upcomingRes?.topConfiguredSports ?? {}),
        };
        const liveEnriched = live.map((m) => enrich(m, topConfig));
        const upcomingShown = upcoming.slice(0, 20).map((m) => enrich(m, topConfig));
        const merged = [...liveEnriched, ...upcomingShown];
        return (
          <MatchListTabs
            matches={merged}
            groups={[
              ...(liveEnriched.length > 0
                ? [
                    {
                      key: "live",
                      label: (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            gap: 28,
                            flexWrap: "wrap",
                          }}
                        >
                          <SectionHeader
                            kicker="Live"
                            title="In play"
                            count={live.length}
                          />
                          <SectionHeader
                            kicker="Next"
                            title="Upcoming"
                            count={upcoming.length}
                          />
                        </div>
                      ),
                      matches: liveEnriched,
                    },
                  ]
                : []),
              {
                key: "upcoming",
                label: (
                  <SectionHeader
                    kicker="Upcoming"
                    title="Next up today"
                    count={upcoming.length}
                  />
                ),
                matches: upcomingShown,
              },
            ]}
          />
        );
      })()}
      {upcoming.length === 0 && live.length === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          Nothing scheduled. Check individual sport pages for the full slate.
        </p>
      ) : null}
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

function sportRank(slug: string): number {
  const i = (TOP_SPORT_SLUGS as readonly string[]).indexOf(slug);
  return i === -1 ? TOP_SPORT_SLUGS.length : i;
}

function orderSportsForChips<T extends { slug: string; name: string }>(
  items: T[],
): T[] {
  const visible = items.filter((s) => !HIDDEN_SPORT_SLUGS.has(s.slug));
  return [...visible].sort((a, b) => {
    const ra = sportRank(a.slug);
    const rb = sportRank(b.slug);
    if (ra !== rb) return ra - rb;
    if (ra === TOP_SPORT_SLUGS.length) return a.name.localeCompare(b.name);
    return 0;
  });
}

function orderMatchesBySport(
  items: ListMatchWithSport[],
): ListMatchWithSport[] {
  const visible = items.filter((m) => !HIDDEN_SPORT_SLUGS.has(m.sport.slug));
  return [...visible].sort((a, b) => {
    const ra = sportRank(a.sport.slug);
    const rb = sportRank(b.sport.slug);
    if (ra !== rb) return ra - rb;
    if (ra === TOP_SPORT_SLUGS.length) {
      const byName = a.sport.name.localeCompare(b.sport.name);
      if (byName !== 0) return byName;
    }
    return 0;
  });
}
