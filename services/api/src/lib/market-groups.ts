// Resolving a match-page tab's configured rows against a match's markets.
//
// `fe_market_display_order` rows name a market TYPE and, since migration
// 0109, the SUB-EVENT it means — (provider_market_id, variant). This is
// the one place that turns those rows into the markets a tab renders, for
// every kind of tab: the curated ones (`top`, `custom_<key>`) and, since
// migration 0111, the feed tabs (`match`, `map_<N>`, `fb_<kinds>`), whose
// rows can now import a market from another sub-event and — when the tab
// is set to membership='manual' — define its contents outright.
//
// Pure and unit-tested because it decides what a bettor is offered: a
// wrong reading of a row either hides a market or drags a foreign one in
// under a heading that does not describe it.

/** The shape this module needs from a market; the catalog row has more. */
export interface GroupableMarket {
  id: string;
  providerMarketId: number;
  variant: string;
  scope: { id: string; order: number };
}

export interface GroupRow {
  providerMarketId: number;
  /** Sub-event (`specifiers.variant`); empty is a wildcard — see below. */
  variant: string;
  displayOrder: number;
}

/**
 * The markets one tab's rows admit, in the operator's order.
 *
 * What an empty `variant` means depends on the tab, and the difference is
 * the whole of this function:
 *
 *   * On a FEED tab it means "this market type, on this tab". The tab is
 *     one sub-event already, so the row resolves within it. Reading it as
 *     "any copy" would drag the match total and every half total onto the
 *     corners tab.
 *   * On a CURATED tab it keeps its pre-0109 meaning: any copy, of which
 *     ONE is featured — preferring the match-scope copy, else the lowest
 *     scope order. Those rows were written before a row could name a
 *     sub-event at all; re-reading them now would silently change tabs an
 *     operator configured long ago.
 *
 * A row that DOES name a sub-event admits every market of that type on
 * it — the whole ladder, as the tab it came from renders it. Featuring
 * "Corners: Total" and getting one arbitrary threshold would be a card no
 * bettor asked for.
 */
export function resolveGroupRows<M extends GroupableMarket>(
  markets: M[],
  scopeId: string,
  rows: GroupRow[],
  curated: boolean,
): M[] {
  const out: M[] = [];
  const seen = new Set<string>();
  for (const row of [...rows].sort((a, b) => a.displayOrder - b.displayOrder)) {
    const candidates = markets.filter(
      (m) =>
        m.providerMarketId === row.providerMarketId &&
        (row.variant === ""
          ? curated || m.scope.id === scopeId
          : m.variant === row.variant),
    );
    if (candidates.length === 0) continue;
    const admitted =
      row.variant === "" && curated ? [representative(candidates)] : candidates;
    for (const pick of admitted) {
      // Two rows can resolve to the same market (a wildcard and the
      // explicit sub-event that wins it); render it once.
      if (pick && !seen.has(pick.id)) {
        seen.add(pick.id);
        out.push(pick);
      }
    }
  }
  return out;
}

// One copy stands for the market type, so a curated tab doesn't double up
// on a total that exists for both Match and Map 1.
function representative<M extends GroupableMarket>(candidates: M[]): M | undefined {
  return (
    candidates.find((m) => m.scope.id === "match") ??
    [...candidates].sort((a, b) => a.scope.order - b.scope.order)[0]
  );
}

/**
 * A feed tab's final market list.
 *
 * 'auto' is the default and the lossless one: the configured markets
 * first, in the operator's order, then everything else the feed puts on
 * the tab. It matters because the backoffice pool is built from the
 * CURRENT offer — a market kind that was not live when the operator saved
 * is simply not in their list, and under 'auto' it still reaches bettors.
 * 'manual' is the opt-in that makes the list the whole tab.
 */
export function applyFeedTabMembership<M extends GroupableMarket>(
  own: M[],
  listed: M[],
  membership: "auto" | "manual",
): M[] {
  if (membership === "manual") return listed;
  const seen = new Set(listed.map((m) => m.id));
  const rest = own
    .filter((m) => !seen.has(m.id))
    .sort((a, b) => a.providerMarketId - b.providerMarketId);
  return [...listed, ...rest];
}
