import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { type ListMatch } from "@/components/match/match-row";
import {
  MatchListTabs,
  type ListMatchEnriched,
} from "@/components/match/match-list-tabs";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { LogoMark } from "@/components/ui/logo-mark";
import { I } from "@/components/ui/icons";
import { shortName } from "@/lib/sport-order";
import { getTranslations } from "@/lib/i18n/server";
import { SportViewTracker } from "@/lib/zillapass-track";

interface SportResponse {
  sport: { id: number; slug: string; name: string };
  filteredTeam: { id: number; name: string } | null;
  // Set when ?category= resolved to a real category under this sport.
  // Null for an id that doesn't belong here, which is what keeps a
  // hand-typed URL from rendering an empty chip over an empty list.
  filteredCategory: { id: number; name: string } | null;
  // Resolved server-side rather than read off a match row, so the chip
  // still names itself when the tournament currently has nothing on
  // offer. Carries the mark the chip renders in place of a kind label.
  filteredTournament: { id: number; name: string; logoUrl: string | null } | null;
  matches: ListMatch[];
}

function enrich(
  m: ListMatch,
  sportSlug: string,
  sportShort: string,
): ListMatchEnriched {
  return {
    ...m,
    _sportSlug: sportSlug,
    _sportShort: sportShort,
  };
}

export default async function SportPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    tournament?: string;
    team?: string;
    category?: string;
  }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const tournamentId = sp.tournament && /^\d+$/.test(sp.tournament) ? sp.tournament : null;
  const teamId = sp.team && /^\d+$/.test(sp.team) ? sp.team : null;
  const categoryId = sp.category && /^\d+$/.test(sp.category) ? sp.category : null;
  const qs = new URLSearchParams({ limit: "100" });
  if (tournamentId) qs.set("tournament", tournamentId);
  if (teamId) qs.set("team", teamId);
  if (categoryId) qs.set("category", categoryId);
  const [data, t, tShell, tCommon] = await Promise.all([
    serverApi<SportResponse>(`/catalog/sports/${slug}?${qs.toString()}`),
    getTranslations("sport"),
    getTranslations("shell"),
    getTranslations("common"),
  ]);
  if (!data) notFound();

  const filteredTournamentName = data.filteredTournament?.name ?? null;
  const filteredTournamentLogoUrl = data.filteredTournament?.logoUrl ?? null;
  const filteredTeamName = data.filteredTeam?.name ?? null;
  const filteredCategoryName = data.filteredCategory?.name ?? null;

  // Dropping one chip keeps the others. Built from the live set instead
  // of hand-listing combinations — two filters were already six branches
  // of ternary, and this adds a third.
  const clearHref = (drop: "tournament" | "team" | "category") => {
    const rest = new URLSearchParams();
    if (tournamentId && drop !== "tournament") rest.set("tournament", tournamentId);
    if (teamId && drop !== "team") rest.set("team", teamId);
    if (categoryId && drop !== "category") rest.set("category", categoryId);
    const query = rest.toString();
    return query ? `/sport/${slug}?${query}` : `/sport/${slug}`;
  };

  const sportShort = shortName(data.sport.name);
  const enriched = data.matches.map((m) => enrich(m, slug, sportShort));

  // Group on the server's `featured` flag, NOT on status.
  //
  // The API sorts one tier-ordered region at the top of every list —
  // everything live, plus prematch matches inside their tier's hoist
  // window — and only then falls back to chronological order (see
  // `matchListOrder` in the catalog routes). Splitting that region by
  // status here undid the whole thing: on 2026-09-06 the nine Premier
  // League / La Liga / Ligue 1 fixtures the rule had promoted to
  // positions 1-9 were re-sorted underneath 91 live youth and women's
  // games, which is the opposite of what the ordering decided.
  //
  // Rows arrive in server order and `filter` is stable, so the tier
  // ordering survives this partition untouched.
  const featured = enriched.filter((m) => m.featured);
  const rest = enriched.filter((m) => !m.featured);
  const featuredLive = featured.filter((m) => m.status === "live").length;
  const featuredSoon = featured.length - featuredLive;

  // Name the top section after what is actually in it. It usually holds
  // both kinds, but a sport between fixtures can be all-prematch and a
  // sport with nothing imminent all-live, and a header that claims
  // "Live" over a list led by kickoff times is worse than no header.
  const featuredLabel =
    featuredSoon === 0
      ? tCommon("live")
      : featuredLive === 0
        ? t("startingSoon")
        : t("liveAndSoon");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 20,
        padding: "28px 32px 60px",
        maxWidth: 1100,
      }}
    >
      <SportViewTracker sportSlug={slug} />
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <SportGlyph sport={slug} size={28} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--fg-dim)",
            }}
          >
            {tShell("sports")}
          </div>
          <h1
            className="display"
            style={{
              margin: 0,
              fontSize: "clamp(22px, 5.5vw, 32px)",
              fontWeight: 500,
              letterSpacing: "-0.02em",
              overflowWrap: "anywhere",
            }}
          >
            {data.sport.name}
          </h1>
          {/* Match count sits under the title (left side) — the right
              edge of this header is reserved for the sticky ZillaPass
              chip in `.oz-shell-search`, which uses a negative bottom
              margin to overlap into this row. */}
          <div
            className="mono tnum"
            style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 4 }}
          >
            {t("matchCount", { count: data.matches.length })}
          </div>
        </div>
      </header>

      {(tournamentId || teamId || categoryId) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            alignSelf: "flex-start",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          {categoryId && filteredCategoryName && (
            <FilterChip
              value={filteredCategoryName}
              clearHref={clearHref("category")}
              clearAriaLabel={t("clearFilter")}
            />
          )}
          {tournamentId && filteredTournamentName && (
            <FilterChip
              logoUrl={filteredTournamentLogoUrl}
              value={filteredTournamentName}
              clearHref={clearHref("tournament")}
              clearAriaLabel={t("clearFilter")}
            />
          )}
          {teamId && filteredTeamName && (
            <FilterChip
              value={filteredTeamName}
              clearHref={clearHref("team")}
              clearAriaLabel={t("clearFilter")}
            />
          )}
        </div>
      )}

      <MatchListTabs
        matches={enriched}
        groups={[
          ...(featured.length > 0
            ? [
                {
                  key: "featured",
                  label: (
                    <SectionLabel text={featuredLabel} count={featured.length} />
                  ),
                  matches: featured,
                },
              ]
            : []),
          {
            key: "upcoming",
            label: <SectionLabel text={t("upcoming")} count={rest.length} />,
            matches: rest,
          },
        ]}
      />
      {rest.length === 0 && featured.length === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          {t("noMatches")}
        </p>
      ) : null}
    </div>
  );
}

/** The small uppercase kicker above each match-list section. */
function SectionLabel({ text, count }: { text: string; count: number }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 10.5,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--fg-dim)",
        fontWeight: 600,
      }}
    >
      {text} · {count}
    </div>
  );
}

/**
 * A dismissible filter chip.
 *
 * The chip used to lead with the KIND of filter — the literal word
 * "TOURNAMENT" before "England. Premier League. Season 26/27". That
 * label told the reader nothing they could not see, and on a chip whose
 * value is already a full competition name it was pure noise. The mark
 * goes there instead, and when there is no mark the slot collapses
 * rather than falling back to the word.
 */
function FilterChip({
  logoUrl,
  value,
  clearHref,
  clearAriaLabel,
}: {
  logoUrl?: string | null;
  value: string;
  clearHref: string;
  clearAriaLabel: string;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 6px 6px 12px",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 999,
        fontSize: 12.5,
        color: "var(--fg)",
      }}
    >
      <LogoMark logoUrl={logoUrl} name={value} />
      <span>{value}</span>
      <Link
        href={clearHref}
        aria-label={clearAriaLabel}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          borderRadius: 999,
          color: "var(--fg-muted)",
          textDecoration: "none",
        }}
      >
        <I.Close size={13} />
      </Link>
    </div>
  );
}
