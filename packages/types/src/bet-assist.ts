// Bet Assist — Sportradar's per-market statistical case for a fixture.
//
// Where the tracker (see ./sportradar.ts) answers "what is happening in
// this match", Bet Assist answers "what does the history say about THIS
// market on this match" — team form, head-to-head averages, a win
// probability split. It takes the same Sportradar match id the tracker
// does plus a `market` key from Sportradar's own vocabulary, so it can
// only be offered on a fixture with a CONFIRMED mapping, and only for a
// market we can name in that vocabulary.
//
// Both tables below are read verbatim from Sportradar's demo bundle
// (widgets.sir.sportradar.com/assets/js/entry.demo_client.*.js, the
// per-sport map behind `getMarketTypesPerSport`), 2026-09-05. Bet Assist
// covers eight sports; everything else we carry — table tennis, darts,
// rugby, volleyball, badminton, padel, every esport — has no Bet Assist
// at all, which is why the map is keyed by SR sport id and not by market
// alone.
//
// The market key is not free text, and a key the widget does not know
// for that sport renders an EMPTY panel rather than an error. That is
// the failure mode this module exists to prevent: `resolveBetAssistMarket`
// validates its answer against the per-sport list before returning it,
// so the storefront never offers a button onto a blank overlay.

/** Sportradar sport ids Bet Assist covers at all. */
import { marketKindOf } from "@oddzilla/types/market-kind";

export const BET_ASSIST_SPORT_IDS: readonly number[] = [1, 2, 3, 4, 5, 6, 16, 29];

/** Market keys Bet Assist accepts, per Sportradar sport id. */
export const BET_ASSIST_MARKETS_BY_SPORT: Readonly<
  Record<number, readonly string[]>
> = {
  // Soccer
  1: [
    "1stHalfWin", "2ndHalfWin", "3Way", "3WayOvertime", "bothTeamsToScore",
    "corners", "correctScore", "doubleChance", "doubleChance1stHalf",
    "doubleChance2ndHalf", "goalScorerAnytime", "goalScorerFirst",
    "goalScorerLast", "goalsDifference", "halfTimeOverUnder", "playerAssists",
    "playerPasses", "playerShots", "playerShotsOnGoal", "playerTackles",
    "playerToBeCarded", "totalOverUnder", "whoWillScoreFirst",
  ],
  // Basketball
  2: [
    "1stHalfWin", "2ndHalfWin", "highestScoringHalf", "highestScoringQuarter",
    "moneyLine", "overtimeChance", "playerAssists", "playerBlocks",
    "playerPoints", "playerRebounds", "playerSteals", "playerThreePointsMade",
    "spread", "spread1stHalf", "spread1stQuarter", "spread2ndHalf",
    "spread2ndQuarter", "spread3rdQuarter", "spread4thQuarter", "total1stHalf",
    "total1stQuarter", "total2ndHalf", "total2ndQuarter", "total3rdQuarter",
    "total4thQuarter", "totalAway", "totalHome", "totalPoints",
    "winner1stQuarter", "winner2ndQuarter", "winner3rdQuarter",
    "winner4thQuarter", "winningMargin",
  ],
  // Baseball
  3: [
    "averageHitsPerGame", "averageHomeRunsPerGame", "batterHomeRuns",
    "batterTotalBases", "extraInnings", "first5InningsRunLine",
    "highestScoringHalf", "highestScoringInning", "moneyLine",
    "moneyline1stInning", "moneyline2ndInning", "moneyline3rdInning",
    "moneyline4thInning", "moneyline5thInning", "moneyline6thInning",
    "moneyline7thInning", "moneyline8thInning", "moneyline9thInning",
    "pitcherStrikeouts", "playerRunsPlusRunsBattedIn", "scoredIn1stInningAway",
    "scoredIn1stInningHome", "scoredIn2ndInningAway", "scoredIn2ndInningHome",
    "scoredIn3rdInningAway", "scoredIn3rdInningHome", "scoredIn4thInningAway",
    "scoredIn4thInningHome", "scoredIn5thInningAway", "scoredIn5thInningHome",
    "scoredIn6thInningAway", "scoredIn6thInningHome", "scoredIn7thInningAway",
    "scoredIn7thInningHome", "scoredIn8stInningAway", "scoredIn8stInningHome",
    "spread", "teamHighestScoringInning", "toLeadAfter5Inning",
    "toLeadAfter5InningsAndToWinTheGame", "totalRuns", "totalRuns1st5Innings",
    "totalRuns1st5InningsAway", "totalRuns1st5InningsHome",
    "totalRuns1stInning", "totalRuns2ndInning", "totalRuns3rdInning",
    "totalRuns4thInning", "totalRuns5thInning", "totalRuns6thInning",
    "totalRuns7thInning", "totalRuns8thInning", "totalRunsAway",
    "totalRunsHome", "winningMargin", "wonMoreInnings",
  ],
  // Ice hockey
  4: [
    "bothTeamsToScore", "bothTeamsToScore1stPeriod",
    "bothTeamsToScore2ndPeriod", "bothTeamsToScore3rdPeriod",
    "bothTeamsToScoreAtLeast2Goals", "bothTeamsToScoreAtLeast3Goals",
    "doubleChance", "highestScoringPeriod", "moneyLine", "moneyLine3way",
    "moneyline1stPeriod", "moneyline2ndPeriod", "moneyline3rdPeriod",
    "shootoutChance", "spread", "spread1stPeriod", "spread2ndPeriod",
    "spread3Way", "spread3rdPeriod", "teamToScoreInEveryPeriod",
    "teamToWinEveryPeriod", "total", "total1stPeriod", "total2ndPeriod",
    "total3rdPeriod", "total3way", "totalAway", "totalHome", "winningMargin",
    "xthGoal",
  ],
  // Tennis
  5: [
    "2Way", "2WayHandicap", "anySetToNil", "bothToWinASet",
    "competitorToWinExactlyOneSet", "competitorToWinExactlyTwoSets",
    "correctScore1stSet", "correctScore2ndSet", "correctScore3rdSet",
    "correctScore4thSet", "correctScore5thSet", "doubleResult",
    "gameHandicap1stSet", "gameHandicap2ndSet", "gameHandicap3rdSet",
    "gameHandicap4thSet", "gameHandicap5thSet", "goTheDistance",
    "numberOfSets", "setBetting", "setHandicap", "tiebreaks1stSet",
    "tiebreaks2ndSet", "tiebreaks3rdSet", "tiebreaks4thSet", "tiebreaks5thSet",
    "toNotWinASet", "totalGames", "totalGames1stSet", "totalGames2ndSet",
    "totalPlayerGames", "totalSets", "winAtLeastOneSet", "winner1stSet",
    "winner2ndSet", "winner3rdSet", "winner4thSet", "winner5thSet",
  ],
  // Handball
  6: [
    "2Way", "2WayHandicap", "2WayHandicap1stHalf", "2WayHandicap2ndHalf",
    "2way1stHalf", "2way2ndHalf", "3Way", "3WayHandicap",
    "3WayHandicap1stHalf", "3WayHandicap2ndHalf", "3way1stHalf", "3way2ndHalf",
    "awayTeamToScore", "awayTotal1stHalf", "bothTeamsToScore", "doubleChance",
    "doubleChance1stHalf", "doubleResult", "eitherTeamToScore30",
    "highestScoringHalf", "homeTeamToScore", "homeTotal1stHalf",
    "teamHighestScoringHalf", "total", "total1stHalf", "total2ndHalf",
    "total3way", "totalAway", "totalHome", "winningMargin",
    "winningMargin1stHalf",
  ],
  // American football
  16: [
    "1stHalfWin", "2ndHalfWin", "doubleResult", "firstOffensivePlay",
    "highestScoringHalf", "highestScoringQuarter", "moneyLine",
    "overtimeChance", "spread", "spread1stHalf", "spread1stQuarter",
    "spread2ndHalf", "spread2ndQuarter", "spread3rdQuarter",
    "spread4thQuarter", "teamHighestScoringQuarter", "teamScoreBothHalf",
    "teamScoreEveryQuarter", "teamWinBothHalves", "teamWinEveryQuarter",
    "total1stHalf", "total1stQuarter", "total2ndHalf", "total2ndQuarter",
    "total3rdQuarter", "total4thQuarter", "totalAway", "totalHome",
    "totalPoints", "winner1stQuarter", "winner2ndQuarter", "winner3rdQuarter",
    "winner4thQuarter", "winningMargin", "winningMargin1stHalf",
  ],
  // Futsal
  29: [
    "2Way", "3Way", "3way1stHalf", "3way2ndHalf", "doubleChance",
    "doubleChance1stHalf", "doubleResult", "highestScoringHalf", "spread",
    "spread1stHalf", "spread2ndHalf", "teamHighestScoringHalf", "total",
    "total1stHalf", "total2ndHalf", "total3way", "totalAway", "totalHome",
    "whoWillScoreFirst", "winningMargin", "winningMargin1stHalf",
  ],
};

// Our market -> Sportradar's market key, per Sportradar sport.
//
// The left-hand side is a Fonbet market: `<provider_market_id>` for the
// whole-match line, `<provider_market_id>@<variant>` for a sub-event,
// where the variant is the `variant` specifier fonbet-ingester puts on
// the market row. Those sub-event codes are Fonbet's own and stable —
// read off the live catalogue on 2026-09-05:
//
//   fb:100101/102/103   periods 1-3 (ice hockey)
//   fb:100201/202       halves (football, handball, futsal)
//   fb:100301           1st half (basketball, american football)
//   fb:100401..404      quarters
//   fb:100501..505      sets
//   fb:100601           1st inning        fb:101701  first 5 innings
//   fb:400100           corners
//
// The same Fonbet id means the same THING across sports but maps to a
// different Sportradar key — 1000305 "Total" is totalOverUnder in
// soccer, totalPoints in basketball, totalRuns in baseball, totalGames
// in tennis — which is why this is keyed per sport rather than shared.
//
// Deliberately partial, in both directions. Bet Assist has no soccer
// handicap, so football's Handicap market gets no button; Fonbet's
// corner, card and player-special markets mostly have no Sportradar
// counterpart. Oddin's esports ids are absent because Bet Assist covers
// no esport. An unmapped market simply renders without the control.
const BET_ASSIST_MARKET_MAP: Readonly<
  Record<number, Readonly<Record<string, string>>>
> = {
  // Soccer
  1: {
    "fb:120": "3Way",
    "fb:120@100201": "1stHalfWin",
    "fb:120@100202": "2ndHalfWin",
    "fb:120#dc": "doubleChance",
    "fb:120@100201#dc": "doubleChance1stHalf",
    "fb:120@100202#dc": "doubleChance2ndHalf",
    "fb:305": "totalOverUnder",
    "fb:305@100201": "halfTimeOverUnder",
    "fb:305@400100": "corners",
    "fb:3400": "correctScore",
  },
  // Basketball
  2: {
    "fb:120": "moneyLine",
    "fb:120@100301": "1stHalfWin",
    "fb:120@100401": "winner1stQuarter",
    "fb:120@100402": "winner2ndQuarter",
    "fb:120@100403": "winner3rdQuarter",
    "fb:120@100404": "winner4thQuarter",
    "fb:304": "spread",
    "fb:304@100301": "spread1stHalf",
    "fb:304@100401": "spread1stQuarter",
    "fb:304@100402": "spread2ndQuarter",
    "fb:304@100403": "spread3rdQuarter",
    "fb:304@100404": "spread4thQuarter",
    "fb:305": "totalPoints",
    "fb:305@100301": "total1stHalf",
    "fb:305@100401": "total1stQuarter",
    "fb:305@100402": "total2ndQuarter",
    "fb:305@100403": "total3rdQuarter",
    "fb:305@100404": "total4thQuarter",
    "fb:506": "totalHome",
    "fb:507": "totalAway",
  },
  // Baseball
  3: {
    "fb:120": "moneyLine",
    "fb:120@100601": "moneyline1stInning",
    "fb:304": "spread",
    "fb:304@101701": "first5InningsRunLine",
    "fb:305": "totalRuns",
    "fb:305@100601": "totalRuns1stInning",
    "fb:305@101701": "totalRuns1st5Innings",
    "fb:506": "totalRunsHome",
    "fb:507": "totalRunsAway",
  },
  // Ice hockey. Fonbet's "Match result" is regular time with a draw, so
  // it is the 3-way moneyline; its "To win the match" (1000491) is the
  // 2-way including overtime, which is what Sportradar calls moneyLine.
  4: {
    "fb:120": "moneyLine3way",
    "fb:120@100101": "moneyline1stPeriod",
    "fb:120@100102": "moneyline2ndPeriod",
    "fb:120@100103": "moneyline3rdPeriod",
    "fb:491": "moneyLine",
    "fb:120#dc": "doubleChance",
    "fb:304": "spread",
    "fb:304@100101": "spread1stPeriod",
    "fb:304@100102": "spread2ndPeriod",
    "fb:304@100103": "spread3rdPeriod",
    "fb:305": "total",
    "fb:305@100101": "total1stPeriod",
    "fb:305@100102": "total2ndPeriod",
    "fb:305@100103": "total3rdPeriod",
    "fb:506": "totalHome",
    "fb:507": "totalAway",
  },
  // Tennis
  5: {
    "fb:120": "2Way",
    "fb:120@100501": "winner1stSet",
    "fb:120@100502": "winner2ndSet",
    "fb:120@100503": "winner3rdSet",
    "fb:120@100504": "winner4thSet",
    "fb:120@100505": "winner5thSet",
    "fb:130": "setHandicap",
    "fb:304": "2WayHandicap",
    "fb:304@100501": "gameHandicap1stSet",
    "fb:304@100502": "gameHandicap2ndSet",
    "fb:304@100503": "gameHandicap3rdSet",
    "fb:304@100504": "gameHandicap4thSet",
    "fb:304@100505": "gameHandicap5thSet",
    "fb:305": "totalGames",
    "fb:305@100501": "totalGames1stSet",
    "fb:305@100502": "totalGames2ndSet",
  },
  // Handball
  6: {
    "fb:120": "3Way",
    "fb:120@100201": "3way1stHalf",
    "fb:120@100202": "3way2ndHalf",
    "fb:120#dc": "doubleChance",
    "fb:120@100201#dc": "doubleChance1stHalf",
    "fb:304": "2WayHandicap",
    "fb:304@100201": "2WayHandicap1stHalf",
    "fb:304@100202": "2WayHandicap2ndHalf",
    "fb:305": "total",
    "fb:305@100201": "total1stHalf",
    "fb:305@100202": "total2ndHalf",
    "fb:506": "totalHome",
    "fb:506@100201": "homeTotal1stHalf",
    "fb:507": "totalAway",
    "fb:507@100201": "awayTotal1stHalf",
  },
  // American football
  16: {
    "fb:120": "moneyLine",
    "fb:120@100301": "1stHalfWin",
    "fb:120@100401": "winner1stQuarter",
    "fb:120@100402": "winner2ndQuarter",
    "fb:120@100403": "winner3rdQuarter",
    "fb:120@100404": "winner4thQuarter",
    "fb:304": "spread",
    "fb:304@100301": "spread1stHalf",
    "fb:304@100401": "spread1stQuarter",
    "fb:304@100402": "spread2ndQuarter",
    "fb:304@100403": "spread3rdQuarter",
    "fb:304@100404": "spread4thQuarter",
    "fb:305": "totalPoints",
    "fb:305@100301": "total1stHalf",
    "fb:305@100401": "total1stQuarter",
    "fb:305@100402": "total2ndQuarter",
    "fb:305@100403": "total3rdQuarter",
    "fb:305@100404": "total4thQuarter",
    "fb:506": "totalHome",
    "fb:507": "totalAway",
  },
  // Futsal
  29: {
    "fb:120": "3Way",
    "fb:120@100201": "3way1stHalf",
    "fb:120@100202": "3way2ndHalf",
    "fb:120#dc": "doubleChance",
    "fb:120@100201#dc": "doubleChance1stHalf",
    "fb:304": "spread",
    "fb:304@100201": "spread1stHalf",
    "fb:304@100202": "spread2ndHalf",
    "fb:305": "total",
    "fb:305@100201": "total1stHalf",
    "fb:305@100202": "total2ndHalf",
    "fb:506": "totalHome",
    "fb:507": "totalAway",
  },
};

export interface BetAssistMarketInput {
  /** Sportradar sport id, from the confirmed mapping row. */
  srSportId: number;
  /** Our `markets.provider_market_id`. */
  providerMarketId: number;
  /** The market's `variant` specifier; absent or "" means the whole match. */
  variant?: string | null;
  /**
   * The market kind as the api resolved it ("fb:120@100201"). Preferred
   * over the two fields above, and REQUIRED for a Fonbet market: its id is
   * registry-allocated and opaque, so nothing downstream can derive the
   * kind from it. Optional only so an Oddin or custom market, whose id is
   * still self-describing, can be resolved without it.
   */
  marketKind?: string | null;
}

/** True when Bet Assist covers this Sportradar sport at all. */
export function betAssistCoversSport(srSportId: number): boolean {
  return BET_ASSIST_SPORT_IDS.includes(srSportId);
}

/**
 * Sportradar's Bet Assist market key for one of our markets, or null when
 * the pair has no counterpart. Never returns a key Bet Assist does not
 * accept for that sport — a wrong key renders an empty panel, so the
 * per-sport list is the last gate.
 */
export function resolveBetAssistMarket(
  input: BetAssistMarketInput,
): string | null {
  const table = BET_ASSIST_MARKET_MAP[input.srSportId];
  if (!table) return null;
  // Keyed by MARKET KIND, not by provider_market_id. The id alone cannot
  // say which market this is on the Fonbet side — one catalogue table is
  // reused across every sub-event — so this map used to build its own
  // `<pmid>@<variant>` key string. That is the market kind, so it now uses
  // the shared one: same information, one definition, and it survives the
  // move to synthetic per-sub-event ids (which are opaque, so a reader
  // could not recover the Fonbet table from them at all).
  // The kind is taken from the payload where the api resolved it, and
  // only computed locally as a fallback for ids that are still
  // self-describing (Oddin, custom). A Fonbet market's id is registry
  // -allocated and opaque, so there is nothing to compute from.
  const kind =
    input.marketKind ?? marketKindOf(input.providerMarketId, input.variant);
  if (!kind) return null;
  const market = table[kind];
  if (!market) return null;
  return BET_ASSIST_MARKETS_BY_SPORT[input.srSportId]?.includes(market)
    ? market
    : null;
}

/** Every (sport, our-market) pair this module knows — for tests and audits. */
export function betAssistMappedPairs(): Array<{
  srSportId: number;
  key: string;
  market: string;
}> {
  const out: Array<{ srSportId: number; key: string; market: string }> = [];
  for (const [sportId, table] of Object.entries(BET_ASSIST_MARKET_MAP)) {
    for (const [key, market] of Object.entries(table)) {
      out.push({ srSportId: Number(sportId), key, market });
    }
  }
  return out;
}
