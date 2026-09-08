// The market TYPE, as a stable readable key.
//
// `provider_market_id` is the integer key a market row is stored under.
// This is the separate question of what KIND of market it is, and the two
// are not the same thing on the Fonbet side:
//
//   Oddin   the id IS the type. Market 1 is the match winner everywhere,
//           4 the map winner, 2 the match handicap.
//   Fonbet  the id is the catalogue TABLE, and one table is reused across
//           every sub-event. "Match result", "2nd half: Match result" and
//           "Corners: Match result" are all table 120, told apart by the
//           `variant` specifier. Measured on production 2026-09-08:
//           1 886 distinct (table, sub-event) pairs across 30 table ids,
//           a 63:1 collision.
//   Custom  operator-authored, one shared id (CUSTOM_PROVIDER_MARKET_ID)
//           because that column is a market type everywhere it is read.
//
// Every bug of this class this month came from a reader keying off the
// integer alone: the ZillaBoost banner quoting "2nd half: Match result"
// under two team names, `isTeamShapedMarket` matching nothing on a
// football team, `fe_market_display_order` needing a `variant` column
// bolted on (migration 0109), and `bet-assist` inventing its own
// `<pmid>@<variant>` key string because the id could not carry the
// answer.
//
// So the type gets one name, used everywhere, and it is deliberately
// built from the PROVIDER'S OWN numbers rather than from our storage key:
//
//   od:1              Oddin match winner
//   od:4              Oddin map winner
//   fb:120            Fonbet table 120, main event ("Match result")
//   fb:120@100201     ...its 1st-half copy
//   fb:120@400100     ...its corners copy
//   fb:120#dc         ...its double-chance cells (split off by the ingester)
//   cu                operator-authored
//
// **That choice is what makes the id migration possible.** The synthetic
// per-sub-event `provider_market_id` this is a step toward is an opaque
// registry number, so a reader cannot recover the Fonbet table from it.
// Anything keyed on this string keeps working across that change; anything
// keyed on the integer would have to be rewritten again. The team/player
// suffix a per-player variant carries (`fb:...:12345`) is a PARAMETER, not
// part of the type — including it would give every player their own market
// type, and 1 202 of the 1 264 distinct variants carry one — so
// `marketKindOf` strips it.

/**
 * Fonbet's provider_market_id namespace (1 000 000 + catalogue table) comes
 * from match-winner.ts, which already owns it — a second copy of a
 * namespace boundary is how the hard-coded `1` in quoteMatchWinnerBoost
 * happened. Self-reference, not a relative import: this module is pulled
 * into apps/web as a VALUE (see the barrel-imports footgun).
 */
import { FONBET_PMID_BASE } from "@oddzilla/types/match-winner";

export { FONBET_PMID_BASE };

/** Provider tag in a market kind. */
export type MarketKindProvider = "od" | "fb" | "cu";

/**
 * Where the ingester files the double-chance cells it splits off a
 * match-winner table (1 900 000 + table). A separate TYPE, not a separate
 * table, which is why it becomes a `#dc` marker rather than its own number.
 */
export const FONBET_DOUBLE_CHANCE_PMID_BASE = 1_900_000;

/** Operator-authored markets all share this id — see custom-events.ts. */
export const CUSTOM_PMID = 2_000_000;

export interface MarketKindParts {
  provider: MarketKindProvider;
  /** The provider's own market-type number: Oddin's id, Fonbet's table. */
  typeNum: number;
  /** Fonbet sub-event kind chain, no team suffix. "" for the main event. */
  variant: string;
  /** Fonbet double-chance split. */
  doubleChance: boolean;
}

/** Render the parts as a kind string. */
export function formatMarketKind(p: MarketKindParts): string {
  if (p.provider === "cu") return "cu";
  let out = `${p.provider}:${p.typeNum}`;
  if (p.variant) out += `@${p.variant}`;
  if (p.doubleChance) out += "#dc";
  return out;
}

/**
 * Strip the `fb:` tag and any `:teamId` / `:playerId` suffix off a raw
 * `specifiers.variant`, leaving the sub-event kind chain.
 *
 * `fb:100201` -> `100201`
 * `fb:400100/10100201` -> `400100/10100201`   (nested: half corners)
 * `fb:100201:12345` -> `100201`               (per-player: id dropped)
 * `` -> ``                                     (main event)
 */
export function variantKindChain(variant: string | null | undefined): string {
  const raw = (variant ?? "").trim();
  if (raw === "") return "";
  const body = raw.startsWith("fb:") ? raw.slice(3) : raw;
  // The team/player id is a trailing `:<digits>` group. Nested kinds are
  // separated by "/", so a colon can only be the parameter separator.
  return body.replace(/:\d+$/, "");
}

/**
 * The market kind for a stored market, from its provider_market_id and
 * raw `specifiers.variant`.
 *
 * Reads the LEGACY id scheme (1 000 000 + table). When provider_market_id
 * becomes a synthetic per-sub-event number the caller resolves the parts
 * through the registry instead and calls `formatMarketKind` — the string,
 * and therefore every consumer keyed on it, does not change.
 */
export function marketKindOf(providerMarketId: number, variant?: string | null): string {
  return formatMarketKind(marketKindPartsOf(providerMarketId, variant));
}

export function marketKindPartsOf(
  providerMarketId: number,
  variant?: string | null,
): MarketKindParts {
  const chain = variantKindChain(variant);
  if (providerMarketId === CUSTOM_PMID) {
    return { provider: "cu", typeNum: providerMarketId, variant: "", doubleChance: false };
  }
  if (providerMarketId >= FONBET_DOUBLE_CHANCE_PMID_BASE && providerMarketId < CUSTOM_PMID) {
    return {
      provider: "fb",
      typeNum: providerMarketId - FONBET_DOUBLE_CHANCE_PMID_BASE,
      variant: chain,
      doubleChance: true,
    };
  }
  if (providerMarketId >= FONBET_PMID_BASE && providerMarketId < CUSTOM_PMID) {
    return {
      provider: "fb",
      typeNum: providerMarketId - FONBET_PMID_BASE,
      variant: chain,
      doubleChance: false,
    };
  }
  // Oddin: the id IS the type, and its own `variant` specifier (way:two,
  // mr:12) is part of the market's identity rather than a sub-event, so it
  // is deliberately NOT folded into the kind — od:1 is the match winner
  // whichever variant of it the feed sent.
  return { provider: "od", typeNum: providerMarketId, variant: "", doubleChance: false };
}

/** Parse a kind string back to its parts, or null if it is malformed. */
export function parseMarketKind(kind: string): MarketKindParts | null {
  const s = kind.trim();
  if (s === "cu") {
    return { provider: "cu", typeNum: CUSTOM_PMID, variant: "", doubleChance: false };
  }
  const m = /^(od|fb):(\d+)(?:@([^#]+))?(#dc)?$/.exec(s);
  if (!m) return null;
  const provider = m[1] as "od" | "fb";
  if (provider === "od" && (m[3] || m[4])) return null; // od has neither
  return {
    provider,
    typeNum: Number(m[2]),
    variant: m[3] ?? "",
    doubleChance: m[4] != null,
  };
}
