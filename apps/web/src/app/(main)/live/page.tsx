import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import { getSessionUser } from "@/lib/auth";
import { type ListMatch } from "@/components/match/match-row";
import {
  MatchListTabs,
  type ListMatchEnriched,
} from "@/components/match/match-list-tabs";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { SectionTabs } from "@/components/lobby/section-tabs";
import { TodayLabel } from "@/components/lobby/today-label";
import { ZillaFlashRow } from "@/components/lobby/zillaflash-row";
import { orderMatchesBySport, shortName } from "@/lib/sport-order";
import { getTranslations } from "@/lib/i18n/server";

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

export default async function LivePage({ searchParams }: PageProps) {
  const resolved = (await searchParams) ?? {};
  const rawSport = resolved.sport;
  const selectedSport =
    typeof rawSport === "string" && rawSport.length > 0 ? rawSport : null;

  const [data, siblingData, user, tMatch, tSport] = await Promise.all([
    serverApi<Response>("/catalog/matches?status=live&limit=120"),
    // The Pre-match tab renders here too (see SectionTabs) and carries a
    // count, so we fetch the sibling list. Same limit /upcoming uses for
    // itself, so the number on the tab is the number you get on landing.
    serverApi<Response>("/catalog/matches?status=upcoming&limit=120"),
    // /auth/me is small + already in the SSR fan-out for the layout;
    // we call it again here so the page picks up the bettor's
    // hidden_sports (migration 0072) and can filter the match list
    // accordingly. There is no Next.js-supported way to share the
    // layout's getSessionUser() result with a nested page, hence the
    // second call. Cost is one cookie-forwarded fetch to api:3001
    // resolved in parallel with /catalog/matches.
    getSessionUser(),
    // The "match" namespace carries both tab labels ("Live" /
    // "Pre-match") — the lobby strip reads the same two keys.
    getTranslations("match"),
    getTranslations("sport"),
  ]);
  const ordered = orderMatchesBySport(
    data?.matches ?? [],
    user?.hiddenSports ?? null,
  );
  // Sibling count for the Pre-match tab, filtered exactly the way the
  // visible list is (hidden sports + the chip's sport), so the two
  // numbers on the strip are comparable and clicking through keeps the
  // filter the bettor set.
  const siblingOrdered = orderMatchesBySport(
    siblingData?.matches ?? [],
    user?.hiddenSports ?? null,
  );

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
  const siblingCount = selectedSport
    ? siblingOrdered.filter((m) => m.sport.slug === selectedSport).length
    : siblingOrdered.length;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 20,
        padding: "28px 32px 60px",
      }}
    >
      {/* TODAY kicker absorbs the `.oz-shell-search` collapsed row
          (margin-bottom: -58px) so the next sibling — the chips row
          or the section-head — doesn't flow up into the search bar.
          Same pattern the lobby home page uses. */}
      <header className="oz-lobby-header">
        <div className="oz-lobby-header-content">
          <TodayLabel />
        </div>
      </header>

      {/* Live-only ZillaFlash boosts — the hook polls the same single
          /catalog/zillaflash endpoint as the lobby, but we filter to
          just the LIVE slots since prematch offers are out of context
          on a page that's specifically a live-status listing. */}
      <ZillaFlashRow kind="live" />

      {/* Sport-filter chips sit right above the match list — that's the
          slate they filter, and putting them adjacent to it makes the
          relationship obvious. The ZillaFlash promo above isn't filtered
          by these chips (it rotates its own slot selection), so chips
          would be misleading sitting on top of it. */}
      {chipSports.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Chip href="/live" label={tSport("all")} count={ordered.length} active={!selectedSport} />
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
        // The strip renders here too — an empty live list must still
        // offer the way over to Pre-match instead of being a dead end.
        <>
          <SectionTabs
            liveLabel={tMatch("live")}
            prematchLabel={tMatch("prematch")}
            liveCount={0}
            prematchCount={siblingCount}
            selected="live"
            sport={selectedSport}
          />
          <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
            {tSport("noMatches")}
          </p>
        </>
      ) : (
        // The tab strip lives ON the match-list section-head row so it
        // shares a line with the cols toggle. MatchListTabs renders the
        // first labeled group's label on the left and the toggle on the
        // right via `.oz-match-list-section-head` (justify: space-between).
        <MatchListTabs
          matches={visible.map(enrich)}
          groups={[
            {
              key: "live",
              label: (
                <SectionTabs
                  liveLabel={tMatch("live")}
                  prematchLabel={tMatch("prematch")}
                  liveCount={visible.length}
                  prematchCount={siblingCount}
                  selected="live"
                  sport={selectedSport}
                />
              ),
              matches: visible.map(enrich),
            },
          ]}
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

