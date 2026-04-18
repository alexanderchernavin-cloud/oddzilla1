import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { LiveMarkets, type MarketGroup, type MarketSnapshot } from "./live-markets";
import { Pill, LiveDot, TeamMark } from "@/components/ui/primitives";
import { I } from "@/components/ui/icons";

interface MatchResponse {
  match: {
    id: string;
    homeTeam: string;
    awayTeam: string;
    scheduledAt: string | null;
    status: "not_started" | "live" | "closed" | "cancelled" | "suspended";
    bestOf: number | null;
    liveScore: { home?: number; away?: number } | null;
    tournament: { id: number; name: string };
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
  const data = await serverApi<MatchResponse>(`/catalog/matches/${id}`);
  if (!data) notFound();

  const { match, markets, marketGroups } = data;
  const isLive = match.status === "live";
  const homeScore = match.liveScore?.home ?? 0;
  const awayScore = match.liveScore?.away ?? 0;

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

      <div className="card" style={{ padding: 24, borderRadius: "var(--r-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          {isLive ? (
            <Pill tone="live">
              <LiveDot size={6} /> LIVE
            </Pill>
          ) : (
            <Pill>Upcoming · {whenLabel}</Pill>
          )}
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--fg-muted)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            {match.tournament.name}
            {match.bestOf ? ` · BO${match.bestOf}` : ""}
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr",
            gap: 24,
            alignItems: "center",
          }}
        >
          <TeamBlock name={match.homeTeam} score={homeScore} align="left" showScore={isLive} />
          <div style={{ textAlign: "center" }}>
            <div
              className="display"
              style={{
                fontSize: 11,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--fg-dim)",
              }}
            >
              Match
            </div>
            <div
              className="mono tnum"
              style={{
                fontSize: 22,
                fontWeight: 500,
                color: "var(--fg-muted)",
                margin: "4px 0",
              }}
            >
              {isLive ? `${homeScore} : ${awayScore}` : "vs"}
            </div>
          </div>
          <TeamBlock name={match.awayTeam} score={awayScore} align="right" showScore={isLive} />
        </div>
      </div>

      {markets.length === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          No markets from the feed yet. This page will update live when odds start
          flowing.
        </p>
      ) : (
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
      )}
    </div>
  );
}

function TeamBlock({
  name,
  score,
  align,
  showScore,
}: {
  name: string;
  score: number;
  align: "left" | "right";
  showScore: boolean;
}) {
  const tag = name
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w[0])
    .join("")
    .slice(0, 4);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        alignItems: align === "right" ? "flex-end" : "flex-start",
      }}
    >
      <TeamMark tag={tag} size={36} />
      <div
        className="display"
        style={{
          fontSize: 26,
          fontWeight: 500,
          letterSpacing: "-0.02em",
          textAlign: align,
        }}
      >
        {name}
      </div>
      {showScore && (
        <div
          className="mono tnum"
          style={{ fontSize: 32, fontWeight: 500, color: "var(--fg)", lineHeight: 1 }}
        >
          {score}
        </div>
      )}
    </div>
  );
}
