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

interface SportResponse {
  sport: { id: number; slug: string; name: string };
  topConfigured: boolean;
  filteredTeam: { id: number; name: string } | null;
  matches: ListMatch[];
}

function enrich(
  m: ListMatch,
  sportSlug: string,
  sportShort: string,
  topConfigured: boolean,
): ListMatchEnriched {
  return {
    ...m,
    _sportSlug: sportSlug,
    _sportShort: sportShort,
    _topConfigured: topConfigured,
  };
}

export default async function SportPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tournament?: string; team?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const tournamentId = sp.tournament && /^\d+$/.test(sp.tournament) ? sp.tournament : null;
  const teamId = sp.team && /^\d+$/.test(sp.team) ? sp.team : null;
  const qs = new URLSearchParams({ limit: "100" });
  if (tournamentId) qs.set("tournament", tournamentId);
  if (teamId) qs.set("team", teamId);
  const data = await serverApi<SportResponse>(
    `/catalog/sports/${slug}?${qs.toString()}`,
  );
  if (!data) notFound();

  const filteredTournamentName = tournamentId
    ? data.matches.find((m) => String(m.tournament.id) === tournamentId)?.tournament.name ?? null
    : null;
  const filteredTeamName = data.filteredTeam?.name ?? null;
  const clearTeamHref = tournamentId
    ? `/sport/${slug}?tournament=${tournamentId}`
    : `/sport/${slug}`;
  const clearTournamentHref = teamId
    ? `/sport/${slug}?team=${teamId}`
    : `/sport/${slug}`;

  const sportShort = shortName(data.sport.name);
  const enriched = data.matches.map((m) =>
    enrich(m, slug, sportShort, !!data.topConfigured),
  );
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
            Sport
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
        </div>
        <div className="mono tnum" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          {data.matches.length} {data.matches.length === 1 ? "match" : "matches"}
        </div>
      </header>

      {(tournamentId || teamId) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            alignSelf: "flex-start",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          {tournamentId && (
            <FilterChip
              label="Tournament"
              value={filteredTournamentName ?? "Filtered"}
              clearHref={clearTournamentHref}
              clearAriaLabel="Clear tournament filter"
            />
          )}
          {teamId && (
            <FilterChip
              label="Team"
              value={filteredTeamName ?? "Filtered"}
              clearHref={clearTeamHref}
              clearAriaLabel="Clear team filter"
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
                      Live · {live.length}
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
                Upcoming · {upcoming.length}
              </div>
            ),
            matches: upcoming,
          },
        ]}
      />
      {upcoming.length === 0 && live.length === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          No matches scheduled.
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
