import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import { type ListMatch } from "@/components/match/match-row";
import {
  MatchListTabs,
  type ListMatchEnriched,
} from "@/components/match/match-list-tabs";
import { SectionHeader } from "@/components/match/section-header";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { ThreeFoldCards } from "@/components/lobby/three-fold-cards";
import { TodayLabel } from "@/components/lobby/today-label";
import { buildThreeFoldSuggestions } from "@/lib/three-fold-builder";
import {
  orderMatchesBySport,
  orderSportsForChips,
  shortName,
} from "@/lib/sport-order";
import { getTranslations } from "@/lib/i18n/server";

interface SportsResponse {
  sports: Array<{ id: number; slug: string; name: string; kind: string; active: boolean }>;
}

interface ListMatchWithSport extends ListMatch {
  sport: { slug: string; name: string };
}

interface CrossSportResponse {
  matches: ListMatchWithSport[];
}

function enrich(m: ListMatchWithSport): ListMatchEnriched {
  return {
    ...m,
    _sportSlug: m.sport.slug,
    _sportShort: shortName(m.sport.name),
  };
}

export default async function HomePage() {
  const [sportsRes, liveCountsRes, liveRes, upcomingRes, t, tMatch] = await Promise.all([
    serverApi<SportsResponse>("/catalog/sports"),
    serverApi<Record<string, number>>("/catalog/live-counts"),
    serverApi<CrossSportResponse>("/catalog/matches?status=live&limit=120"),
    serverApi<CrossSportResponse>("/catalog/matches?status=upcoming&limit=60"),
    getTranslations("home"),
    getTranslations("match"),
  ]);

  const sports = sportsRes?.sports ?? [];
  const liveCounts = liveCountsRes ?? {};
  const live = orderMatchesBySport(liveRes?.matches ?? []);
  const upcoming = orderMatchesBySport(upcomingRes?.matches ?? []);
  // Pass the translated "Match winner" label so the SSR-embedded slip
  // leg doesn't carry literal English through to the client (where the
  // bet-slip rail would re-render it on click).
  const threeFoldSuggestions = buildThreeFoldSuggestions(
    [...live, ...upcoming],
    tMatch("matchWinner"),
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
        const liveEnriched = live.map(enrich);
        const upcomingShown = upcoming.slice(0, 20).map(enrich);
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
                            kicker={t("liveKicker")}
                            title={t("inPlay")}
                            count={live.length}
                          />
                          <SectionHeader
                            kicker={t("nextKicker")}
                            title={t("upcoming")}
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
                    kicker={t("upcomingKicker")}
                    title={t("nextUpToday")}
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
          {t("empty")}
        </p>
      ) : null}
    </div>
  );
}

