// Shell-less match-detail page mounted inside the side-panel iframes
// (see `components/shell/side-panels.tsx`). Lives outside the (main)
// route group so the storefront's top bar / sidebar / bet-slip rail
// don't render around it — the iframe sits in the empty band flanking
// the centered shell on ultra-wide viewports, so the chrome would just
// be cropped clutter.
//
// Reuses the same data-fetch + body components as the canonical match
// page; only the surrounding layout differs. Clicking an outcome here
// adds to the BetSlipProvider in the iframe's own React tree — the
// parent shell's slip rail picks it up via the cross-document storage
// event sync added to BetSlipProvider.

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { getTranslations } from "@/lib/i18n/server";
import { LocalDateTime } from "@/components/match/local-datetime";
import {
  LiveMarkets,
  type MarketGroup,
  type MarketSnapshot,
} from "@/app/(main)/match/[id]/live-markets";
import { LiveScoreboard } from "@/app/(main)/match/[id]/live-scoreboard";
import { Pill, LiveDot } from "@/components/ui/primitives";
import { TierMark } from "@/components/ui/tier-mark";
import { type MatchStream } from "@/components/match/match-streams";
import { MatchLiveMedia } from "@/components/widgets/match-live-media";
import { ZillaFactsCards } from "@/components/match/zillafacts-cards";
import { type LiveScore } from "@/lib/live-score";

interface MatchResponse {
  match: {
    id: string;
    homeTeam: string;
    awayTeam: string;
    homeLogoUrl?: string | null;
    awayLogoUrl?: string | null;
    homeBrandColor?: string | null;
    awayBrandColor?: string | null;
    scheduledAt: string | null;
    status: "not_started" | "live" | "closed" | "cancelled" | "suspended";
    bestOf: number | null;
    liveScore: LiveScore | null;
    streams?: MatchStream[];
    tournament: { id: number; name: string; riskTier?: number | null };
    sport: { id: number; slug: string; name: string };
  };
  markets: MarketSnapshot[];
  marketGroups: MarketGroup[];
}

export default async function EmbedMatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await serverApi<MatchResponse>(`/catalog/matches/${id}`);
  if (!data) notFound();

  const { match, markets: _markets, marketGroups } = data;
  const streams = match.streams ?? [];
  const parentHost = await resolveEmbedHost();
  const isLive = match.status === "live";
  const initialLiveScore = match.liveScore ?? null;

  const [tMatch, tHome] = await Promise.all([
    getTranslations("match"),
    getTranslations("home"),
  ]);

  return (
    <div className="oz-embed-root">
      <div className="oz-embed-inner">
        <div
          className="card"
          style={{
            padding: "clamp(14px, 4vw, 20px)",
            borderRadius: "var(--r-lg)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 14,
              flexWrap: "wrap",
            }}
          >
            {isLive ? (
              <Pill tone="live">
                <LiveDot size={6} /> {tMatch("live")}
              </Pill>
            ) : (
              <Pill>
                {tHome("upcoming")}
                {" · "}
                <LocalDateTime iso={match.scheduledAt} mode="match-detail" />
              </Pill>
            )}
            <span
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--fg-muted)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <TierMark tier={match.tournament.riskTier ?? null} size={11} />
              {match.tournament.name}
              {match.bestOf ? ` · BO${match.bestOf}` : ""}
            </span>
          </div>

          <LiveScoreboard
            matchId={match.id}
            homeTeam={match.homeTeam}
            awayTeam={match.awayTeam}
            homeLogoUrl={match.homeLogoUrl ?? null}
            awayLogoUrl={match.awayLogoUrl ?? null}
            bestOf={match.bestOf}
            initialLiveScore={initialLiveScore}
            isLive={isLive}
            sportSlug={match.sport.slug}
          />
        </div>

        <MatchLiveMedia
          matchId={String(match.id)}
          sportSlug={match.sport.slug}
          homeTeam={match.homeTeam}
          awayTeam={match.awayTeam}
          streams={streams}
          parentHost={parentHost}
          isLive={isLive}
        />

        <ZillaFactsCards
          matchId={String(match.id)}
          homeTeam={match.homeTeam}
          awayTeam={match.awayTeam}
          sportSlug={match.sport.slug}
        />

        <LiveMarkets
          matchId={match.id}
          match={{
            id: match.id,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            sportSlug: match.sport.slug,
          }}
          initialGroups={marketGroups}
        />
      </div>
    </div>
  );
}

async function resolveEmbedHost(): Promise<string | null> {
  const h = await headers();
  const raw = h.get("x-forwarded-host") ?? h.get("host");
  if (!raw) return null;
  const host = raw.split(":")[0]?.toLowerCase() ?? "";
  return host || null;
}
