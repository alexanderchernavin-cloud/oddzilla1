import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import { getSessionUser } from "@/lib/auth";
import { type ListMatch } from "@/components/match/match-row";
import {
  MatchListTabs,
  type ListMatchEnriched,
} from "@/components/match/match-list-tabs";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { LiveDot } from "@/components/ui/primitives";
import { TodayLabel } from "@/components/lobby/today-label";
import { orderMatchesBySport, shortName } from "@/lib/sport-order";
import { getTranslations } from "@/lib/i18n/server";

// Traditional-sports tab: the same cross-sport live / upcoming lists the
// lobby shows, restricted to `sports.kind = 'traditional'` (the Fonbet
// feed). Esports keep the lobby / Live / Pre-match pages; this page gives
// football, tennis, hockey and the rest their own front door with a
// per-sport chip row.

interface ListMatchWithSport extends ListMatch {
  // `displayOrder` is the operator's pin position for the sport
  // (migration 0103) — carried per match so the cross-sport lists
  // group in the same order the sidebar rail shows.
  sport: { slug: string; name: string; displayOrder?: number | null };
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

interface PageProps {
  searchParams?: Promise<{ sport?: string | string[] }>;
}

export default async function SportsPage({ searchParams }: PageProps) {
  const resolved = (await searchParams) ?? {};
  const rawSport = resolved.sport;
  const selectedSport =
    typeof rawSport === "string" && rawSport.length > 0 ? rawSport : null;

  const [live, upcoming, user, tCommon, tSport, tShell] = await Promise.all([
    serverApi<Response>(
      "/catalog/matches?status=live&kind=traditional&limit=120",
    ),
    serverApi<Response>(
      "/catalog/matches?status=upcoming&kind=traditional&limit=120",
    ),
    getSessionUser(),
    getTranslations("common"),
    getTranslations("sport"),
    getTranslations("shell"),
  ]);
  const hidden = user?.hiddenSports ?? null;
  const liveOrdered = orderMatchesBySport(live?.matches ?? [], hidden);
  const upcomingOrdered = orderMatchesBySport(upcoming?.matches ?? [], hidden);

  // Chips: every sport present in either list, alphabetical (traditional
  // sports have no pinned order), with combined counts.
  const chipMap = new Map<string, { name: string; count: number }>();
  for (const m of [...liveOrdered, ...upcomingOrdered]) {
    const existing = chipMap.get(m.sport.slug);
    if (existing) existing.count += 1;
    else chipMap.set(m.sport.slug, { name: m.sport.name, count: 1 });
  }
  const chipSports = Array.from(chipMap.entries())
    .map(([slug, v]) => ({ slug, name: v.name, count: v.count }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const filter = (list: ListMatchWithSport[]) =>
    selectedSport ? list.filter((m) => m.sport.slug === selectedSport) : list;
  const liveVisible = filter(liveOrdered);
  const upcomingVisible = filter(upcomingOrdered);
  const total = liveVisible.length + upcomingVisible.length;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 20,
        padding: "28px 32px 60px",
      }}
    >
      <header className="oz-lobby-header">
        <div className="oz-lobby-header-content">
          <TodayLabel />
        </div>
      </header>

      {chipSports.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Chip
            href="/sports"
            label={tSport("all")}
            count={liveOrdered.length + upcomingOrdered.length}
            active={!selectedSport}
          />
          {chipSports.map((s) => (
            <Chip
              key={s.slug}
              href={`/sports?sport=${s.slug}`}
              label={s.name}
              count={s.count}
              active={selectedSport === s.slug}
              sportSlug={s.slug}
            />
          ))}
        </div>
      )}

      {total === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          {tSport("noMatches")}
        </p>
      ) : (
        <MatchListTabs
          matches={[...liveVisible, ...upcomingVisible].map(enrich)}
          groups={[
            {
              key: "live",
              label: (
                <Heading
                  label={tCommon("live")}
                  count={liveVisible.length}
                  live
                />
              ),
              matches: liveVisible.map(enrich),
            },
            {
              key: "upcoming",
              label: (
                <Heading
                  label={tShell("upcoming")}
                  count={upcomingVisible.length}
                />
              ),
              matches: upcomingVisible.map(enrich),
            },
          ].filter((g) => g.matches.length > 0)}
        />
      )}
    </div>
  );
}

function Heading({
  label,
  count,
  live,
}: {
  label: string;
  count: number;
  live?: boolean;
}) {
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
      {live && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            color: "var(--fg-muted)",
          }}
          aria-hidden
        >
          <LiveDot size={9} />
        </span>
      )}
      {label}
      <span
        className="mono tnum"
        style={{
          display: "inline-flex",
          alignItems: "center",
          fontSize: 11,
          fontWeight: 600,
          color: live ? "var(--live)" : "var(--fg-muted)",
          border: `1px solid ${live ? "var(--live)" : "var(--hairline)"}`,
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
        gap: 6,
        padding: "6px 12px",
        borderRadius: 999,
        border: `1px solid ${active ? "var(--fg)" : "var(--hairline)"}`,
        background: active ? "var(--fg)" : "var(--surface)",
        color: active ? "var(--bg)" : "var(--fg)",
        fontSize: 13,
        fontWeight: 500,
        textDecoration: "none",
      }}
    >
      {sportSlug && <SportGlyph sport={sportSlug} size={14} />}
      {label}
      <span className="mono tnum" style={{ fontSize: 11, opacity: 0.7 }}>
        {count}
      </span>
    </Link>
  );
}
