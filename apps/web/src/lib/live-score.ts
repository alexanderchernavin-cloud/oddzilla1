// Shared types + helpers for the live-score JSON shape feed-ingester
// writes to matches.live_score (see services/feed-ingester/internal/
// handler/livescore.go). Used by both the match-detail Scoreboard and
// the match-list row's compact per-map mini-table so the two views
// stay byte-identical on which metric appears in each cell.

export interface LiveScorePeriod {
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

export interface LiveScoreScoreboard {
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

/**
 * The match clock as an ANCHOR rather than a reading: at unix-ms
 * instant `atMs` (the feed's server time) the clock read `seconds`, and
 * it has moved `direction` seconds per second since — 1 counting up
 * (football, hockey, basketball, esports on the Fonbet line), 0 stopped
 * (half time, an intermission, "END"), -1 counting down. The reading at
 * any instant t is `seconds + direction × (t − atMs) / 1000`; see
 * `clockSecondsAt` in clock-math.ts, and `useRunningClock` for the hook
 * that ticks it.
 *
 * Written by fonbet-ingester, normalised so a RUNNING clock is stored at
 * its zero instant (`seconds` 0, `atMs` = when it read 0) — a form that
 * is constant for as long as the clock runs, so the payload does not
 * change from poll to poll and a single frame carries a whole half. A
 * stopped clock keeps its reading in `seconds` and has no `atMs`. Absent
 * on the Oddin esports payload and on untimed sports (tennis, table
 * tennis, volleyball, cricket, snooker), where `scoreboard.time` — the
 * feed's own rendered string, static between frames — is the fallback.
 */
export interface LiveScoreClock {
  seconds: number;
  direction: number;
  atMs?: number;
}

export interface LiveScore {
  home?: number;
  away?: number;
  status?: number;
  matchStatusCode?: number;
  currentMap?: number;
  clock?: LiveScoreClock | null;
  /**
   * Which side holds serve: 1 = home, 2 = away. Written by
   * fonbet-ingester for the sports whose feed carries it (tennis,
   * table tennis, volleyball) and absent everywhere else — Oddin's
   * esports payload has no equivalent. Read through `servingSide()`
   * rather than compared inline, so an unexpected value degrades to
   * "nobody is marked" instead of marking the home player.
   */
  serve?: number;
  /**
   * The feed's own parenthetical qualifier on the headline score —
   * games in the current set for tennis ("(6-5)"), the period line
   * elsewhere. Written by fonbet-ingester from Fonbet's `comment` /
   * `scoreComment`; absent on the Oddin esports payload, where the
   * headline score IS the map count and there is nothing to qualify.
   *
   * Rendered verbatim rather than reconstructed from `periods`: it is
   * the string Fonbet itself shows, and it already encodes per-sport
   * conventions we would otherwise have to re-derive per sport.
   */
  comment?: string;
  scoreboard?: LiveScoreScoreboard;
  periods?: LiveScorePeriod[];
  updatedAt?: string;
}

// servingSide answers "is this side serving right now" for one row.
// Only meaningful while the match is live: the feed keeps the last
// value on the payload after a match ends, and a serve marker on a
// finished scoreboard reads as a live match that isn't.
export function servingSide(
  liveScore: LiveScore | null | undefined,
  isLive: boolean,
): "home" | "away" | null {
  if (!isLive) return null;
  if (liveScore?.serve === 1) return "home";
  if (liveScore?.serve === 2) return "away";
  return null;
}

// mapCellValue picks the right metric for one (team, map) cell.
// Prefers the live <scoreboard> for the current map (more up-to-date than
// the period_score row, which only refreshes after the map ends on some
// sports). Falls back to the period when the scoreboard block is empty —
// Oddin sometimes ships `<scoreboard/>` with no inner attributes during
// pauses or just-started maps.
export function mapCellValue(
  side: "home" | "away",
  mapNumber: number,
  period: LiveScorePeriod | undefined,
  scoreboard: LiveScoreScoreboard | null,
  currentMap: number | null,
  sportSlug: string,
): number | null {
  if (currentMap === mapNumber && scoreboard) {
    const live = pickLiveMetric(scoreboard, sportSlug);
    const v = side === "home" ? live.home : live.away;
    if (v != null) return v;
  }
  if (!period) return null;
  const periodMetric = pickPeriodMetric(period, sportSlug);
  return side === "home" ? periodMetric.home : periodMetric.away;
}

// pickPeriodMetric returns the (home, away) integer pair for a completed
// map, preferring the sport-native metric (rounds for CS2, kills for Dota)
// and falling back to the generic home_score/away_score Oddin always
// populates.
export function pickPeriodMetric(
  p: LiveScorePeriod,
  sportSlug: string,
): { home: number | null; away: number | null } {
  const slug = sportSlug.toLowerCase();
  if (slug === "cs2" || slug === "csgo" || slug === "counter-strike" || slug === "valorant") {
    if (p.homeWonRounds != null || p.awayWonRounds != null) {
      return { home: p.homeWonRounds ?? null, away: p.awayWonRounds ?? null };
    }
  }
  if (
    slug === "dota2" ||
    slug === "dota" ||
    slug === "lol" ||
    slug === "leagueoflegends" ||
    slug === "league-of-legends"
  ) {
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

export function pickLiveMetric(
  sb: LiveScoreScoreboard,
  sportSlug: string,
): { home: number | null; away: number | null } {
  const slug = sportSlug.toLowerCase();
  if (slug === "cs2" || slug === "csgo" || slug === "counter-strike" || slug === "valorant") {
    if (sb.homeWonRounds != null || sb.awayWonRounds != null) {
      return { home: sb.homeWonRounds ?? null, away: sb.awayWonRounds ?? null };
    }
  }
  if (
    slug === "dota2" ||
    slug === "dota" ||
    slug === "lol" ||
    slug === "leagueoflegends" ||
    slug === "league-of-legends"
  ) {
    if (sb.homeKills != null || sb.awayKills != null) {
      return { home: sb.homeKills ?? null, away: sb.awayKills ?? null };
    }
  }
  if (sb.homeGoals != null || sb.awayGoals != null) {
    return { home: sb.homeGoals ?? null, away: sb.awayGoals ?? null };
  }
  return { home: null, away: null };
}
