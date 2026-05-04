import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import { type ListMatch } from "@/components/match/match-row";
import {
  MatchListTabs,
  type ListMatchEnriched,
} from "@/components/match/match-list-tabs";
import { SportGlyph } from "@/components/ui/sport-glyph";

interface ListMatchWithSport extends ListMatch {
  sport: { slug: string; name: string };
}

interface Response {
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

interface PageProps {
  searchParams?: Promise<{ sport?: string | string[] }>;
}

export default async function LivePage({ searchParams }: PageProps) {
  const resolved = (await searchParams) ?? {};
  const rawSport = resolved.sport;
  const selectedSport =
    typeof rawSport === "string" && rawSport.length > 0 ? rawSport : null;

  const data = await serverApi<Response>("/catalog/matches?status=live&limit=120");
  const ordered = orderBySport(data?.matches ?? []);

  // Preserve insertion order from `ordered` so chips inherit the
  // CS2 -> Dota 2 -> LoL -> Valorant -> alphabetical ordering for free.
  const chipMap = new Map<string, { name: string; count: number }>();
  for (const m of ordered) {
    const existing = chipMap.get(m.sport.slug);
    if (existing) existing.count += 1;
    else chipMap.set(m.sport.slug, { name: m.sport.name, count: 1 });
  }
  const chipSports = Array.from(chipMap.entries()).map(([slug, v]) => ({
    slug,
    name: v.name,
    count: v.count,
  }));

  const visible = selectedSport
    ? ordered.filter((m) => m.sport.slug === selectedSport)
    : ordered;

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
          {visible.length} {visible.length === 1 ? "match" : "matches"}
        </div>
      </header>

      {chipSports.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Chip href="/live" label="All" count={ordered.length} active={!selectedSport} />
          {chipSports.map((s) => (
            <Chip
              key={s.slug}
              href={`/live?sport=${s.slug}`}
              label={s.name}
              count={s.count}
              active={selectedSport === s.slug}
              sportSlug={s.slug}
            />
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          {selectedSport
            ? "No live matches in this sport right now."
            : "Nothing live right now. Check back soon."}
        </p>
      ) : (
        <MatchListTabs
          matches={visible.map((m) =>
            enrich(m, data?.topConfiguredSports ?? {}),
          )}
        />
      )}
    </div>
  );
}

function Chip({
  href,
  label,
  count,
  active,
  sportSlug,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
  sportSlug?: string;
}) {
  return (
    <Link
      href={href}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        height: 34,
        padding: "0 14px",
        background: active ? "var(--fg)" : "var(--surface)",
        border: `1px solid ${active ? "var(--fg)" : "var(--border)"}`,
        borderRadius: 999,
        textDecoration: "none",
        color: active ? "var(--bg)" : "var(--fg)",
        fontSize: 12.5,
        transition: "background 140ms var(--ease), color 140ms var(--ease)",
      }}
    >
      {sportSlug ? <SportGlyph sport={sportSlug} size={14} /> : null}
      {label}
      {count > 0 ? (
        <span
          className="mono tnum"
          style={{
            fontSize: 10.5,
            color: active ? "var(--bg)" : "var(--fg-dim)",
            opacity: active ? 0.75 : 1,
          }}
        >
          {count}
        </span>
      ) : null}
    </Link>
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
