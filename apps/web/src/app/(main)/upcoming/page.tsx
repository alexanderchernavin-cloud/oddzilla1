import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import { getSessionUser } from "@/lib/auth";
import { type ListMatch } from "@/components/match/match-row";
import {
  MatchListTabs,
  type ListMatchEnriched,
} from "@/components/match/match-list-tabs";
import { I } from "@/components/ui/icons";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { TodayLabel } from "@/components/lobby/today-label";
import { ZillaFlashRow } from "@/components/lobby/zillaflash-row";
import { orderMatchesBySport, shortName } from "@/lib/sport-order";
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

interface PageProps {
  searchParams?: Promise<{ sport?: string | string[] }>;
}

export default async function UpcomingPage({ searchParams }: PageProps) {
  const resolved = (await searchParams) ?? {};
  const rawSport = resolved.sport;
  const selectedSport =
    typeof rawSport === "string" && rawSport.length > 0 ? rawSport : null;

  const [data, user, tMatch, tSport] = await Promise.all([
    serverApi<Response>("/catalog/matches?status=upcoming&limit=120"),
    // See live/page.tsx for why we re-fetch the session user — we
    // need the bettor's hidden_sports (migration 0072) to filter the
    // match list and Next.js doesn't share layout results with pages.
    getSessionUser(),
    // Use the "match" namespace so the heading reads "Pre-match" —
    // same label the lobby's LobbyTabLink uses for the prematch tab.
    // The page route stays /upcoming for link/bookmark stability.
    getTranslations("match"),
    getTranslations("sport"),
  ]);
  const ordered = orderMatchesBySport(
    data?.matches ?? [],
    user?.hiddenSports ?? null,
  );

  // Preserve insertion order from `ordered` so chips inherit the
  // CS2 -> Dota 2 -> LoL -> Valorant -> alphabetical ordering for free.
  // Mirrors /live page's chipMap exactly — same shape, same URLs except
  // /upcoming instead of /live.
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
      {/* TODAY kicker absorbs the `.oz-shell-search` collapsed row
          (margin-bottom: -58px) so the next sibling doesn't flow up
          into the search bar. Same pattern the lobby home page uses. */}
      <header className="oz-lobby-header">
        <div className="oz-lobby-header-content">
          <TodayLabel />
        </div>
      </header>

      {/* Prematch-only ZillaFlash boosts. Same engine, kind-filtered. */}
      <ZillaFlashRow kind="prematch" />

      {/* Sport-filter chips sit right above the match list — that's
          the slate they filter. ZillaFlash above isn't filtered by
          these chips (it rotates its own slot selection). */}
      {chipSports.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Chip
            href="/upcoming"
            label={tSport("all")}
            count={ordered.length}
            active={!selectedSport}
          />
          {chipSports.map((s) => (
            <Chip
              key={s.slug}
              href={`/upcoming?sport=${s.slug}`}
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
          {tSport("noMatches")}
        </p>
      ) : (
        // Page heading sits ON the MatchListTabs section-head row so it
        // shares a line with the cols toggle (same pattern /live uses).
        <MatchListTabs
          matches={visible.map(enrich)}
          groups={[
            {
              key: "upcoming",
              label: <UpcomingPageHeading label={tMatch("prematch")} count={visible.length} />,
              matches: visible.map(enrich),
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

// Sport-filter chip. Mirrors the /live page's Chip component byte for
// byte so the two pages render identical filter rows — same height,
// same icon size, same active-state styling.
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
