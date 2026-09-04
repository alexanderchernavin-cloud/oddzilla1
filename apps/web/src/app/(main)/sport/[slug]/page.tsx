import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { type ListMatch } from "@/components/match/match-row";
import {
  MatchListTabs,
  type ListMatchEnriched,
} from "@/components/match/match-list-tabs";
import { SportGlyph } from "@/components/ui/sport-glyph";
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

  const filteredTournamentName = tournamentId
    ? data.matches.find((m) => String(m.tournament.id) === tournamentId)?.tournament.name ?? null
    : null;
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
  const live = enriched.filter((m) => m.status === "live");
  const upcoming = enriched.filter((m) => m.status !== "live");

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
              label={t("filterKindCategory")}
              value={filteredCategoryName}
              clearHref={clearHref("category")}
              clearAriaLabel={t("clearFilter")}
            />
          )}
          {tournamentId && (
            <FilterChip
              label={t("filterKindTournament")}
              value={filteredTournamentName ?? ""}
              clearHref={clearHref("tournament")}
              clearAriaLabel={t("clearFilter")}
            />
          )}
          {teamId && (
            <FilterChip
              label={t("filterKindTeam")}
              value={filteredTeamName ?? ""}
              clearHref={clearHref("team")}
              clearAriaLabel={t("clearFilter")}
            />
          )}
        </div>
      )}

      <MatchListTabs
        matches={enriched}
        groups={[
          ...(live.length > 0
            ? [
                {
                  key: "live",
                  label: (
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
                      {tCommon("live")} · {live.length}
                    </div>
                  ),
                  matches: live,
                },
              ]
            : []),
          {
            key: "upcoming",
            label: (
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
                {t("upcoming")} · {upcoming.length}
              </div>
            ),
            matches: upcoming,
          },
        ]}
      />
      {upcoming.length === 0 && live.length === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          {t("noMatches")}
        </p>
      ) : null}
    </div>
  );
}

function FilterChip({
  label,
  value,
  clearHref,
  clearAriaLabel,
}: {
  label: string;
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
      <span
        className="mono"
        style={{
          fontSize: 10.5,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--fg-dim)",
        }}
      >
        {label}
      </span>
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
