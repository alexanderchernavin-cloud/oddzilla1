import Link from "next/link";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { LiveMarkets, type MarketGroup, type MarketSnapshot } from "./live-markets";
import { LiveScoreboard } from "./live-scoreboard";
import { Pill, LiveDot } from "@/components/ui/primitives";
import { TierMark } from "@/components/ui/tier-mark";
import { I } from "@/components/ui/icons";
import { type MatchStream } from "@/components/match/match-streams";
import { MatchLiveMedia } from "@/components/widgets/match-live-media";
import { MatchPrematchMobile } from "@/components/widgets/match-prematch-mobile";
import { ZillaFactsCards } from "@/components/match/zillafacts-cards";
import { MatchPageRegistrar } from "@/lib/match-page-context";
import { type LiveScore } from "@/lib/live-score";
import { getSessionUser } from "@/lib/auth";

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

export default async function MatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [data, viewer] = await Promise.all([
    serverApi<MatchResponse>(`/catalog/matches/${id}`),
    getSessionUser(),
  ]);
  if (!data) notFound();

  const { match, markets, marketGroups } = data;
  const streams = match.streams ?? [];
  const parentHost = await resolveEmbedHost();
  const isLive = match.status === "live";
  const initialLiveScore = match.liveScore ?? null;

  // For the analyses section CTA, "logged in" presence-checks the access
  // cookie rather than round-tripping /auth/me. Server stays authoritative
  // — a publish attempt with an invalid cookie still hits the api's
  // requireAuth and gets rejected; this is purely a UI-gating signal so
  // anonymous viewers see "log in to publish" instead of the Write button.
  const cookieStore = await cookies();
  const loggedIn = Boolean(cookieStore.get("oddzilla_access"));

  const whenLabel = match.scheduledAt
    ? new Date(match.scheduledAt).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Time TBD";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 24,
        padding: "28px 32px 60px",
        maxWidth: 1000,
      }}
    >
      <Link
        href={`/sport/${match.sport.slug}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          alignSelf: "flex-start",
          color: "var(--fg-muted)",
          textDecoration: "none",
          fontSize: 12.5,
        }}
      >
        <span style={{ transform: "rotate(180deg)", display: "inline-flex" }}>
          <I.Arrow size={13} />
        </span>
        Back to {match.sport.name}
      </Link>

      <div
        className="card"
        style={{
          padding: "clamp(14px, 4vw, 24px)",
          borderRadius: "var(--r-lg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 18,
            flexWrap: "wrap",
          }}
        >
          {isLive ? (
            <Pill tone="live">
              <LiveDot size={6} /> LIVE
            </Pill>
          ) : (
            <Pill>Upcoming · {whenLabel}</Pill>
          )}
          {(match.tournament.riskTier === 1 || match.tournament.riskTier === 2) && (
            <TopPill />
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

      {/* ZillaFacts surfaces hard, consecutive-from-newest streaks on
          the open match: a team has won its last N matches on the
          same (market, outcome) signature, with the tier glow scaled
          by streak × ln(currentOdds). Collapses to zero height when
          no streak on the match clears ZILLAFACT_MIN_STREAK, so the
          page layout is unchanged for matches without strong
          patterns. Sits between the stream and the markets-tabs
          strip so it reads as an "insights" lead-in. */}
      <ZillaFactsCards matchId={String(match.id)} />

      <MatchPrematchMobile
        matchId={String(match.id)}
        sportSlug={match.sport.slug}
        homeTeam={match.homeTeam}
        awayTeam={match.awayTeam}
      />

      <MatchPageRegistrar
        matchId={String(match.id)}
        sportSlug={match.sport.slug}
        sportName={match.sport.name}
        homeTeam={match.homeTeam}
        awayTeam={match.awayTeam}
        matchStatus={match.status}
        viewerId={viewer ? viewer.id : null}
        loggedIn={loggedIn}
      />

      {/* Always mount LiveMarkets — even when the SSR snapshot has zero
          markets — so the WebSocket subscription is up and ready. The
          previous early-return rendered a static placeholder with no
          subscription, so when markets re-activated mid-game (a common
          basketball / hockey pattern between possessions) the user
          needed a hard refresh to see them. The empty-state copy now
          lives inside LiveMarkets and disappears the moment any market
          appears in the merged tree.

          Chat + Analyses no longer render below markets — they live
          in the right rail's Match panel (RailMatchPanel), tabbed
          alongside the Disir Match Insights widget. The registrar
          above passes matchStatus + viewer auth state through context
          so the rail can render the correct default tab and CTAs. */}
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
  );
}

// Twitch's iframe player only loads when its `parent=` query param matches
// the embedding hostname (any Host or X-Forwarded-Host header it sees from
// the browser). Reading from the same place Next.js does keeps prod
// (oddzilla.cc) and `pnpm dev` (localhost) working without env config.
async function resolveEmbedHost(): Promise<string | null> {
  const h = await headers();
  const raw = h.get("x-forwarded-host") ?? h.get("host");
  if (!raw) return null;
  const host = raw.split(":")[0]?.toLowerCase() ?? "";
  return host || null;
}

// TopPill renders a filled gold "TOP" chip in the match-detail header
// for any tournament Oddin marks risk_tier 1 or 2. Mono-uppercase to
// match the LIVE/Upcoming pills next to it.
function TopPill() {
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--accent-fg)",
        background: "var(--tier-gold)",
        border: "1px solid var(--tier-gold)",
      }}
      title="Top tournament"
    >
      Top
    </span>
  );
}
