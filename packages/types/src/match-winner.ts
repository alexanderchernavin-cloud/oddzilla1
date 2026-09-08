// Which market on a match is "the match winner" — the one question every
// list card, banner and headline surface wants a price for.
//
// It is a rule rather than a column because each feed says it its own way,
// and a surface that guesses ships a price for the wrong market:
//
//   Oddin   provider_market_id 1, outcome ids "1" / "2" / "3".
//   Fonbet  provider_market_id >= FONBET_PMID_BASE (1 000 000 + table
//           number). The table number is NOT the market: Fonbet reuses one
//           table across every sub-event, so "Match result", "1st half:
//           Match result" and "Corners: Match result" are all 1000120 and
//           are told apart by the `variant` specifier. What separates the
//           full match is that the ingester rewrites the outcome ids to
//           the canonical "1" / "2" / "3" only on tables Fonbet flags
//           `isMain` whose columns are captioned literally "1" / "2" — a
//           sub-event copy keeps its raw factor ids (921, 922, 923, and
//           924 / 925 / 1571 for the double chance).
//   Custom  provider_market_id 2 000 000, given the same canonical ids on
//           purpose so an operator's headline market prices on cards.
//
// So the canonical outcome ids do double duty: they pick the full match
// out of a table's sub-event copies, AND they pick the three-way result
// out of a row that also carries double chance. Both fall out of the same
// test, which is why it is stated once here.
//
// On the full match the ingester has already split the double chance off
// into its own market at 1_900_000 + table (docs/FONBET.md), whose ids are
// all factor ids and which therefore fails this test outright. It is the
// SUB-EVENT copies that keep all six columns in one row — verified on
// production 2026-09-07: market 425171448 (full match) carries 1 / 2 / 3,
// 425171406 (its double chance) carries 924 / 925 / 1571, and 425171408
// ("2nd half") carries all six.
//
// Extracted from catalog/routes.ts (which had it inline for the list
// cards) when the ZillaBoost match banner needed the same answer. It had
// been ranking markets by `provider_market_id` ascending with a tie-break
// on the market ROW id, i.e. insertion order — so a Fonbet football match
// quoted whichever copy of table 1000120 happened to be inserted first,
// and on production 2026-09-07 that was "2nd half: Match result", six
// outcomes including the double chance, on a card headed by the two team
// names. Same class of bug as the hard-coded `1` in quoteMatchWinnerBoost.
//
// It lives in @oddzilla/types rather than services/api because the MATCH
// PAGE needs the same answer in the browser — `isTeamShapedMarket` below
// gates a team_only ZillaBoost client-side, and a second copy of the
// Fonbet namespace rule is precisely how the hard-coded `1` happened.
// Import by subpath (`@oddzilla/types/match-winner`), never the barrel.

/**
 * provider_market_id namespace of the Fonbet feed (services/fonbet-ingester,
 * docs/FONBET.md): 1_000_000 + Fonbet table number. Oddin ids stay far
 * below this; custom (operator-authored) markets sit above it at
 * 2_000_000 and are deliberately included by the range test.
 */
export const FONBET_PMID_BASE = 1_000_000;

/**
 * Fonbet's two "Head to head" tables (399 and 25020), as
 * provider_market_ids. A head-to-head fixture — a cycling stage duel, an
 * athletics match-up — has this as its ONE market, and it IS the winner
 * of that fixture, but its outcome ids are raw factor ids rather than the
 * canonical "1" / "2": the mapper only rewrites them on tables Fonbet
 * flags `isMain` whose column captions are literally "1" / "2", and this
 * one is neither (its captions are the team placeholders "%1" / "%2").
 * That is a deliberate constraint on the ingester side — outcome ids are
 * market identity, so widening it there would re-key live markets and
 * strand any open ticket on them (see twoWayWinner in
 * services/fonbet-ingester/internal/settle/rules.go, which reads the
 * shape for the same reason) — so the pairing is widened in the READERS
 * instead, where nothing is persisted.
 *
 * An allowlist rather than a shape rule, because the shape does not
 * separate the winner from the sideshow: "To win the toss" (496) and
 * "Who will start the penalty shootout" (920) are also two-way "%1" /
 * "%2" tables, and quoting a toss price under a "Match winner" header is
 * worse than quoting nothing. Measured on production 2026-09-07: 399 is
 * the only one of the family currently in the offer, on 14 cycling
 * matches, each with exactly this one market; 25020 is carried because
 * it is the same market under another number and would otherwise be a
 * repeat of this bug.
 */
export const FONBET_HEAD_TO_HEAD_PMIDS = [
  FONBET_PMID_BASE + 399,
  FONBET_PMID_BASE + 25_020,
];

/**
 * The outcome ids a match winner is keyed by on every feed: home / away /
 * draw. Oddin's own canonical set, which the Fonbet mapper and the custom
 * -event editor both adopt for exactly this reason.
 */
export const WINNER_OUTCOME_IDS = ["1", "2", "3"] as const;

export function isWinnerOutcomeId(outcomeId: string): boolean {
  return (WINNER_OUTCOME_IDS as readonly string[]).includes(outcomeId);
}

/**
 * Is this market the match's canonical winner — Oddin's market-winner
 * table, or a Fonbet / custom row carrying the canonical outcome ids?
 *
 * `outcomeIds` is required precisely because it is the discriminator on
 * the Fonbet side: without it a caller cannot tell the full match from
 * its own sub-event copies, which share the provider_market_id.
 *
 * Oddin's map winner (4) is deliberately NOT included: it is the winner
 * of a map, not of the match, and a surface that wants it as a fallback
 * has to say so.
 */
export function isMatchWinnerMarket(market: {
  providerMarketId: number;
  outcomeIds: readonly string[];
}): boolean {
  if (market.providerMarketId === 1) return true;
  if (market.providerMarketId < FONBET_PMID_BASE) return false;
  // Every canonical id present on the row must be a winner id, and at
  // least two of them — a row carrying "1" among a dozen factor ids is a
  // factor-keyed table that happens to have a low id, not a winner.
  const canonical = market.outcomeIds.filter(isWinnerOutcomeId);
  return canonical.length >= 2;
}
