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
import { SlotzillaLive } from "@/components/lobby/slotzilla-live";
import { TodayLabel } from "@/components/lobby/today-label";
import { buildThreeFoldSuggestions } from "@/lib/three-fold-builder";
import {
  filterSportsForLobbyChips,
  orderMatchesBySport,
  visibleMatches,
  shortName,
} from "@/lib/sport-order";
import { getTranslations } from "@/lib/i18n/server";
import type { ComboZillaPoolResponse } from "@oddzilla/types/combozilla";

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
    matchesRes,
    combiBoostRes,
    comboPoolRes,
    user,
    t,
    tMatch,
  ] = await Promise.all([
    serverApi<SportsResponse>("/catalog/sports"),
    serverApi<Record<string, number>>("/catalog/live-counts"),
    // ONE cross-status fetch, because the ordering the API applies is
    // one region spanning both: everything live plus prematch matches
    // inside their tier's hoist window, tier-ordered, then a
    // chronological tail (`matchListOrder`). Two status-scoped requests
    // cannot express that — neither can see the other's rows — so the
    // lobby fetched live and prematch separately and lost it. 200 is the
    // endpoint's cap and comfortable headroom: measured on production
    // 2026-09-07, 126 matches were in the promoted region (96 live + 30
    // hoisted) against 2 771 in the tail.
    serverApi<CrossSportResponse>("/catalog/matches?status=all&limit=200"),
    serverApi<CombiBoostConfigResponse>("/catalog/combi-boost-config"),
    // ComboZilla's candidate pool. The api applies the operator's policy
    // (eligible risk tiers + allow / block rules, /admin/combozilla) and
    // caps the pool per sport; the builder below only assembles combos.
    serverApi<ComboZillaPoolResponse>("/catalog/combozilla-pool"),
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
  // Group on the server's `featured` flag, NOT on status, and do not
  // re-sort by sport — the same two rules the sport page follows, for the
  // same reason. `visibleMatches` only drops hidden sports; `filter` is
  // stable, so the API's tier ordering survives the partition untouched.
  // Sorting by sport here is what broke this: it is a sort on a key the
  // ordering deliberately ignores, so it buried every promoted fixture
  // under whichever sport happens to rank first (production 2026-09-07:
  // Football's live list led with Egypt and Slovenia U19).
  const allMatches = visibleMatches(matchesRes?.matches ?? [], userHidden);
  const featured = allMatches.filter((m) => m.featured);
  const rest = allMatches.filter((m) => !m.featured);
  // Pass the translated "Match winner" label so the SSR-embedded slip
  // leg doesn't carry literal English through to the client (where the
  // bet-slip rail would re-render it on click).
  //
  // ComboZilla feeds on the PREMATCH pool the api resolved from the
  // operator's policy (which risk tiers qualify, plus allow / block rules
  // on sports, categories and tournaments — edited at /admin/combozilla).
  // Same-sport grouping, prematch enforcement, the per-sport card cap
  // (the operator's `multiCardSportSlugs`), and the per-leg Combi Boost
  // minimum-odds gate happen inside the builder; passing the live minOdds
  // keeps the gate in sync with whatever the admin tuned the boost to.
  // The bettor's own hidden sports are dropped here, like every other
  // lobby surface — a hidden sport must not come back as a card.
  const comboPool = orderMatchesBySport(comboPoolRes?.matches ?? [], userHidden);
  const threeFoldSuggestions = buildThreeFoldSuggestions(
    comboPool,
    tMatch("matchWinner"),
    {
      boostMinOdds: combiBoostRes?.minOdds ?? undefined,
      multiCardSportSlugs: comboPoolRes?.multiCardSportSlugs,
    },
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

      <SlotzillaLive />

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
        // The promoted region in full, then a short chronological tail —
        // the lobby is a "what's on" page, not a full prematch browse
        // (that is /upcoming, one click away on the strip below).
        const featuredEnriched = featured.map(enrich);
        const restShown = rest.slice(0, 20).map(enrich);
        const merged = [...featuredEnriched, ...restShown];
        const hasFeatured = featuredEnriched.length > 0;
        return (
          <MatchListTabs
            matches={merged}
            // Mirrors the server-side fallback below for the case it
            // can't reach: every row on the page going terminal under an
            // open tab. Vanishingly unlikely on the lobby's 120 live +
            // 20 prematch rows, passed for consistency with the other
            // three list surfaces.
            emptyMessage={t("empty")}
            groups={[
              ...(hasFeatured
                ? [
                    {
                      key: "featured",
                      label: (
                        <SectionTabs
                          liveLabel={tMatch("live")}
                          prematchLabel={tMatch("prematch")}
                        />
                      ),
                      matches: featuredEnriched,
                    },
                  ]
                : []),
              {
                key: "upcoming",
                // When the promoted region has rows the top tabs already
                // label both sections — render the tail directly below it
                // with no second header. When nothing was promoted,
                // promote the strip to the top so the user still gets
                // both clickable labels.
                label: hasFeatured ? null : (
                  <SectionTabs
                    liveLabel={tMatch("live")}
                    prematchLabel={tMatch("prematch")}
                  />
                ),
                matches: restShown,
              },
            ]}
          />
        );
      })()}
      {allMatches.length === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          {t("empty")}
        </p>
      ) : null}
    </div>
  );
}


