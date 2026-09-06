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
import { ThreeFoldCards } from "@/components/lobby/three-fold-cards";
import { ZillaFlashRow } from "@/components/lobby/zillaflash-row";
import { ZillaBoostBanners } from "@/components/lobby/zillaboost-banners";
import { TodayLabel } from "@/components/lobby/today-label";
import { buildThreeFoldSuggestions } from "@/lib/three-fold-builder";
import {
  filterSportsForLobbyChips,
  orderMatchesBySport,
  shortName,
} from "@/lib/sport-order";
import { getTranslations } from "@/lib/i18n/server";

interface SportsResponse {
  sports: Array<{ id: number; slug: string; name: string; kind: string; active: boolean }>;
}

interface ListMatchWithSport extends ListMatch {
  // `displayOrder` is the operator's pin position for the sport
  // (migration 0103) — carried per match so the cross-sport lists
  // group in the same order the sidebar rail shows.
  sport: { slug: string; name: string; displayOrder?: number | null };
}

interface CrossSportResponse {
  matches: ListMatchWithSport[];
}

interface CombiBoostConfigResponse {
  enabled: boolean;
  minOdds: number;
  tiers: Array<{ minLegs: number; multiplier: number; label: string }>;
}

function enrich(m: ListMatchWithSport): ListMatchEnriched {
  return {
    ...m,
    _sportSlug: m.sport.slug,
    _sportShort: shortName(m.sport.name),
  };
}

export default async function HomePage() {
  const [
    sportsRes,
    liveCountsRes,
    liveRes,
    upcomingRes,
    combiBoostRes,
    user,
    t,
    tMatch,
  ] = await Promise.all([
    serverApi<SportsResponse>("/catalog/sports"),
    serverApi<Record<string, number>>("/catalog/live-counts"),
    serverApi<CrossSportResponse>("/catalog/matches?status=live&limit=120"),
    serverApi<CrossSportResponse>("/catalog/matches?status=upcoming&limit=60"),
    serverApi<CombiBoostConfigResponse>("/catalog/combi-boost-config"),
    // See live/page.tsx — we re-fetch the session user so the lobby
    // picks up the bettor's hidden_sports (migration 0072) for the
    // live + upcoming lists, the sport-chip strip, and the
    // CombiBoost three-fold suggestion builder.
    getSessionUser(),
    getTranslations("home"),
    getTranslations("match"),
  ]);

  const userHidden = user?.hiddenSports ?? null;
  // Drop hidden-sport rows from the catalog sport list so the lobby
  // chip strip + the live-counts strip don't include them. The
  // sidebar gets its own copy of the list (from the layout) so the
  // user can still un-hide them from the sidebar's edit mode.
  const hiddenSet = new Set(userHidden ?? []);
  const sports = (sportsRes?.sports ?? []).filter(
    (s) => !hiddenSet.has(s.slug),
  );
  const liveCounts = liveCountsRes ?? {};
  const live = orderMatchesBySport(liveRes?.matches ?? [], userHidden);
  const upcoming = orderMatchesBySport(upcomingRes?.matches ?? [], userHidden);
  // Pass the translated "Match winner" label so the SSR-embedded slip
  // leg doesn't carry literal English through to the client (where the
  // bet-slip rail would re-render it on click).
  //
  // ComboZilla feeds on PREMATCH-only matches (the brief calls for two
  // prematch combos in the carousel). Tier 1-3 filtering, same-sport
  // grouping, prematch enforcement, the per-sport card cap (only CS2 /
  // Dota 2 / LoL may hold more than one slot), and the per-leg Combi
  // Boost minimum-odds gate all happen inside the builder; passing the
  // live minOdds keeps the gate in sync with whatever the admin tuned
  // the boost to.
  const threeFoldSuggestions = buildThreeFoldSuggestions(
    upcoming,
    tMatch("matchWinner"),
    combiBoostRes?.minOdds ?? undefined,
  );

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
      {/*
        Lobby header. The global search now lives at the top of every
        page via the (main) layout (`.oz-shell-search`), so the lobby's
        own date+search row collapsed to just the date kicker.
      */}
      <header className="oz-lobby-header">
        <div className="oz-lobby-header-content">
          <TodayLabel />
        </div>
      </header>

      <ThreeFoldCards suggestions={threeFoldSuggestions} />

      <ZillaBoostBanners />

      <ZillaFlashRow />

      {/*
        Top sports. Operator-curated on /admin/sports (migration 0103) —
        pin a sport there and it appears here, in pin order. The heading
        exists because an unlabelled chip row reads as a filter bar
        rather than as a recommendation, which is what it is.
      */}
      <div
        className="mono"
        style={{
          fontSize: 11,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--fg-muted)",
          marginBottom: -4,
        }}
      >
        {t("topSports")}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {filterSportsForLobbyChips(sports).map((s) => (
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
        const liveEnriched = live.map(enrich);
        const upcomingShown = upcoming.slice(0, 20).map(enrich);
        const merged = [...liveEnriched, ...upcomingShown];
        const hasLive = liveEnriched.length > 0;
        return (
          <MatchListTabs
            matches={merged}
            groups={[
              ...(hasLive
                ? [
                    {
                      key: "live",
                      label: (
                        <SectionTabs
                          liveLabel={tMatch("live")}
                          prematchLabel={tMatch("prematch")}
                          liveCount={live.length}
                          prematchCount={upcoming.length}
                        />
                      ),
                      matches: liveEnriched,
                    },
                  ]
                : []),
              {
                key: "upcoming",
                // When live matches exist the top tabs already label
                // both sections — render the prematch cards directly
                // below the live cards with no second header. When the
                // page is prematch-only, promote the strip to the top
                // so the user still gets both clickable labels.
                label: hasLive ? null : (
                  <SectionTabs
                    liveLabel={tMatch("live")}
                    prematchLabel={tMatch("prematch")}
                    liveCount={live.length}
                    prematchCount={upcoming.length}
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
          {t("empty")}
        </p>
      ) : null}
    </div>
  );
}


