import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { LiveMarkets, type MarketGroup, type MarketSnapshot } from "./live-markets";
import { Pill, LiveDot, TeamMark } from "@/components/ui/primitives";
import { I } from "@/components/ui/icons";

// LiveScore mirrors the JSON shape feed-ingester writes to matches.live_score
// (see services/feed-ingester/internal/handler/livescore.go). Top-level
// home/away are the series score (number of maps won); `periods` is the
// per-map breakdown; `scoreboard` is the live state of the in-progress map.
interface LiveScorePeriod {
  number?: number;
  type?: string;
  matchStatusCode?: number;
  homeScore?: number;
  awayScore?: number;
  homeWonRounds?: number;
  awayWonRounds?: number;
  homeKills?: number;
  awayKills?: number;
  homeGoals?: number;
  awayGoals?: number;
  homeDestroyedTurrets?: number;
  awayDestroyedTurrets?: number;
  homeDestroyedTowers?: number;
  awayDestroyedTowers?: number;
  isLive?: boolean;
}

interface LiveScoreScoreboard {
  homeWonRounds?: number;
  awayWonRounds?: number;
  homeKills?: number;
  awayKills?: number;
  homeDestroyedTurrets?: number;
  awayDestroyedTurrets?: number;
  homeDestroyedTowers?: number;
  awayDestroyedTowers?: number;
  homeGold?: number;
  awayGold?: number;
  homeGoals?: number;
  awayGoals?: number;
  currentCtTeam?: number;
  currentDefTeam?: number;
  time?: string;
  gameTime?: number;
  remainingGameTime?: number;
}

interface LiveScore {
  home?: number;
  away?: number;
  status?: number;
  matchStatusCode?: number;
  currentMap?: number;
  scoreboard?: LiveScoreScoreboard;
  periods?: LiveScorePeriod[];
  updatedAt?: string;
}

interface MatchResponse {
  match: {
    id: string;
    homeTeam: string;
    awayTeam: string;
    scheduledAt: string | null;
    status: "not_started" | "live" | "closed" | "cancelled" | "suspended";
    bestOf: number | null;
    liveScore: LiveScore | null;
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
  const liveScore = match.liveScore ?? null;
  const homeScore = liveScore?.home ?? 0;
  const awayScore = liveScore?.away ?? 0;
  const showSeriesScore = isLive || (homeScore > 0 || awayScore > 0);

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
            gap: "clamp(10px, 3vw, 24px)",
            alignItems: "center",
          }}
        >
          <TeamBlock
            name={match.homeTeam}
            score={homeScore}
            align="left"
            showScore={showSeriesScore}
          />
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
              Series
            </div>
            <div
              className="mono tnum"
              style={{
                fontSize: "clamp(18px, 4vw, 22px)",
                fontWeight: 500,
                color: "var(--fg-muted)",
                margin: "4px 0",
                whiteSpace: "nowrap",
              }}
            >
              {showSeriesScore ? `${homeScore} : ${awayScore}` : "vs"}
            </div>
          </div>
          <TeamBlock
            name={match.awayTeam}
            score={awayScore}
            align="right"
            showScore={showSeriesScore}
          />
        </div>

        {liveScore ? (
          <MapScoreboard
            sportSlug={match.sport.slug}
            bestOf={match.bestOf}
            liveScore={liveScore}
            isLive={isLive}
          />
        ) : null}
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
        minWidth: 0,
      }}
    >
      <TeamMark tag={tag} size={36} />
      <div
        className="display"
        style={{
          fontSize: "clamp(17px, 4.8vw, 26px)",
          fontWeight: 500,
          letterSpacing: "-0.02em",
          textAlign: align,
          lineHeight: 1.15,
          overflowWrap: "anywhere",
          minWidth: 0,
          maxWidth: "100%",
        }}
      >
        {name}
      </div>
      {showScore && (
        <div
          className="mono tnum"
          style={{
            fontSize: "clamp(22px, 6vw, 32px)",
            fontWeight: 500,
            color: "var(--fg)",
            lineHeight: 1,
          }}
        >
          {score}
        </div>
      )}
    </div>
  );
}

// Per-sport label for the per-map score column. CS2/Valorant report rounds
// won; Dota 2 / LoL report kills (and turrets/towers as a secondary stat).
// Falls back to a generic "Score" header when the sport isn't known yet.
function periodMetricLabel(sportSlug: string): string {
  switch (sportSlug.toLowerCase()) {
    case "cs2":
    case "csgo":
    case "counter-strike":
    case "valorant":
      return "Rounds";
    case "dota2":
    case "dota":
    case "lol":
    case "leagueoflegends":
    case "league-of-legends":
      return "Kills";
    default:
      return "Score";
  }
}

// pickPeriodMetric returns the (home, away) integer pair to render for a
// completed map, preferring the sport-native metric (rounds for CS2,
// kills for Dota) and falling back to the generic home_score/away_score
// Oddin always populates.
function pickPeriodMetric(
  p: LiveScorePeriod,
  sportSlug: string,
): { home: number | null; away: number | null } {
  const slug = sportSlug.toLowerCase();
  if (slug === "cs2" || slug === "csgo" || slug === "counter-strike" || slug === "valorant") {
    if (p.homeWonRounds != null || p.awayWonRounds != null) {
      return { home: p.homeWonRounds ?? null, away: p.awayWonRounds ?? null };
    }
  }
  if (slug === "dota2" || slug === "dota" || slug === "lol" || slug === "leagueoflegends" || slug === "league-of-legends") {
    if (p.homeKills != null || p.awayKills != null) {
      return { home: p.homeKills ?? null, away: p.awayKills ?? null };
    }
  }
  if (p.homeScore != null || p.awayScore != null) {
    return { home: p.homeScore ?? null, away: p.awayScore ?? null };
  }
  if (p.homeGoals != null || p.awayGoals != null) {
    return { home: p.homeGoals ?? null, away: p.awayGoals ?? null };
  }
  return { home: null, away: null };
}

// pickLiveMetric returns the live (home, away) pair from the scoreboard
// block for the in-progress map. Same sport precedence as pickPeriodMetric.
function pickLiveMetric(
  sb: LiveScoreScoreboard,
  sportSlug: string,
): { home: number | null; away: number | null } {
  const slug = sportSlug.toLowerCase();
  if (slug === "cs2" || slug === "csgo" || slug === "counter-strike" || slug === "valorant") {
    if (sb.homeWonRounds != null || sb.awayWonRounds != null) {
      return { home: sb.homeWonRounds ?? null, away: sb.awayWonRounds ?? null };
    }
  }
  if (slug === "dota2" || slug === "dota" || slug === "lol" || slug === "leagueoflegends" || slug === "league-of-legends") {
    if (sb.homeKills != null || sb.awayKills != null) {
      return { home: sb.homeKills ?? null, away: sb.awayKills ?? null };
    }
  }
  if (sb.homeGoals != null || sb.awayGoals != null) {
    return { home: sb.homeGoals ?? null, away: sb.awayGoals ?? null };
  }
  return { home: null, away: null };
}

function MapScoreboard({
  sportSlug,
  bestOf,
  liveScore,
  isLive,
}: {
  sportSlug: string;
  bestOf: number | null;
  liveScore: LiveScore;
  isLive: boolean;
}) {
  const periods = (liveScore.periods ?? []).filter((p) => p.number != null);
  const currentMap = liveScore.currentMap ?? null;
  const scoreboard = liveScore.scoreboard ?? null;

  // Synthesize a row for the in-progress map when Oddin hasn't added it
  // to <period_scores> yet (common at the start of a map). The live
  // scoreboard block is the source of truth for the current map's score.
  const synthesizedLiveRow: LiveScorePeriod | null =
    isLive && currentMap != null && !periods.some((p) => p.number === currentMap) && scoreboard
      ? { number: currentMap, type: "map", isLive: true }
      : null;

  const rows = synthesizedLiveRow ? [...periods, synthesizedLiveRow] : periods;
  rows.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

  // Render a placeholder up to bestOf so users can see the series shape
  // before any maps have started.
  const totalSlots = Math.max(rows.length, bestOf ?? 0);
  if (totalSlots === 0) return null;

  const metricLabel = periodMetricLabel(sportSlug);

  return (
    <div
      style={{
        marginTop: 20,
        paddingTop: 16,
        borderTop: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        className="display"
        style={{
          fontSize: 11,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--fg-dim)",
        }}
      >
        Maps
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${totalSlots}, minmax(64px, 1fr))`,
          gap: 8,
        }}
      >
        {Array.from({ length: totalSlots }).map((_, idx) => {
          const mapNumber = idx + 1;
          const row = rows.find((p) => p.number === mapNumber) ?? null;
          const live =
            isLive &&
            (row?.isLive === true ||
              (currentMap === mapNumber && row != null) ||
              (currentMap === mapNumber && synthesizedLiveRow?.number === mapNumber));

          let homeVal: number | null = null;
          let awayVal: number | null = null;
          if (row) {
            if (live && scoreboard) {
              const live = pickLiveMetric(scoreboard, sportSlug);
              homeVal = live.home;
              awayVal = live.away;
            } else {
              const m = pickPeriodMetric(row, sportSlug);
              homeVal = m.home;
              awayVal = m.away;
            }
          }

          const finished = row != null && !live;
          const upcoming = row == null;

          return (
            <div
              key={mapNumber}
              style={{
                padding: "10px 8px",
                borderRadius: "var(--r-md)",
                background: live ? "var(--bg-elev-2, rgba(255,255,255,0.04))" : "transparent",
                border: live
                  ? "1px solid var(--accent, rgba(255,255,255,0.18))"
                  : "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
                opacity: upcoming ? 0.45 : 1,
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  color: live ? "var(--fg)" : "var(--fg-dim)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                {live ? <LiveDot size={5} /> : null}
                Map {mapNumber}
              </div>
              <div
                className="mono tnum"
                style={{
                  fontSize: 16,
                  fontWeight: 500,
                  color: upcoming ? "var(--fg-dim)" : "var(--fg)",
                  whiteSpace: "nowrap",
                }}
              >
                {homeVal != null && awayVal != null ? `${homeVal} : ${awayVal}` : "—"}
              </div>
              {finished ? (
                <div
                  className="mono"
                  style={{
                    fontSize: 9,
                    color: "var(--fg-dim)",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  Final
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {isLive && scoreboard && currentMap != null
        ? (() => {
            const extras = formatScoreboardExtras(scoreboard, sportSlug);
            if (extras.length === 0) return null;
            return (
              <div
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--fg-muted)",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "4px 14px",
                  marginTop: 4,
                }}
              >
                <span style={{ color: "var(--fg-dim)" }}>Map {currentMap}:</span>
                {extras.map((line) => (
                  <span key={line.label}>
                    <span style={{ color: "var(--fg-dim)" }}>{line.label}</span>{" "}
                    <span className="tnum">{line.value}</span>
                  </span>
                ))}
              </div>
            );
          })()
        : null}

      {!isLive && metricLabel ? (
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--fg-dim)", letterSpacing: "0.08em" }}
        >
          {metricLabel.toUpperCase()} PER MAP
        </div>
      ) : null}
    </div>
  );
}

function formatScoreboardExtras(
  sb: LiveScoreScoreboard,
  sportSlug: string,
): { label: string; value: string }[] {
  const slug = sportSlug.toLowerCase();
  const out: { label: string; value: string }[] = [];

  if (slug === "cs2" || slug === "csgo" || slug === "counter-strike" || slug === "valorant") {
    if (sb.homeWonRounds != null && sb.awayWonRounds != null) {
      out.push({ label: "Rounds", value: `${sb.homeWonRounds} : ${sb.awayWonRounds}` });
    }
  } else if (
    slug === "dota2" ||
    slug === "dota" ||
    slug === "lol" ||
    slug === "leagueoflegends" ||
    slug === "league-of-legends"
  ) {
    if (sb.homeKills != null && sb.awayKills != null) {
      out.push({ label: "Kills", value: `${sb.homeKills} : ${sb.awayKills}` });
    }
    if (sb.homeDestroyedTowers != null && sb.awayDestroyedTowers != null) {
      out.push({
        label: "Towers",
        value: `${sb.homeDestroyedTowers} : ${sb.awayDestroyedTowers}`,
      });
    }
    if (sb.homeDestroyedTurrets != null && sb.awayDestroyedTurrets != null) {
      out.push({
        label: "Turrets",
        value: `${sb.homeDestroyedTurrets} : ${sb.awayDestroyedTurrets}`,
      });
    }
    if (sb.homeGold != null && sb.awayGold != null) {
      out.push({
        label: "Gold",
        value: `${formatGold(sb.homeGold)} : ${formatGold(sb.awayGold)}`,
      });
    }
  }

  if (sb.time) {
    out.push({ label: "Time", value: sb.time });
  } else if (sb.gameTime != null) {
    out.push({ label: "Time", value: formatSeconds(sb.gameTime) });
  }

  return out;
}

function formatGold(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

function formatSeconds(s: number): string {
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
