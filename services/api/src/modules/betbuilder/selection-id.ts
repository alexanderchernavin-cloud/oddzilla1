// Canonical OBB selection_id wire format. Shared by the quote endpoint
// (which sends these ids to Oddin to price a session) and by bet placement
// (which RECONSTRUCTS them from the persisted legs to prove the legs we
// settle are exactly the legs Oddin priced). Keeping one implementation is
// load-bearing: if the two diverged, a bettor could price one leg set and
// settle another at the priced odds.
//
// The format is `<event>/<market>/<outcome>?<spec>` where `<spec>` is
// `k1=v1|k2=v2` with keys sorted lexicographically and values UNENCODED.
//
// The specifier separator is a PIPE `|`, not `&`. This is Oddin's
// canonical form — it's the separator Oddin uses in its own
// `availableMarkets` / SessionMarket specifier strings AND the one
// `SessionCreate` echoes back in `created.selections[].selectionId`
// (verified against the integration broker, e.g.
// `od:match:N/107/od:player:45?map=1|slot=5|variant=od:dynamic_outcomes:16502`).
// It also matches the canonical string our `specifiers_hash` is built
// from (see invariant #2 in CLAUDE.md). An earlier `&` here byte-mismatched
// Oddin's echo at placement, so the round-trip check in bets/service.ts
// rejected every BetBuilder ticket with `betbuilder_selection_mismatch`.
//
// Values come from Oddin's own feed so they're already URL-safe
// (`way:two`, `total:over`, numeric thresholds, `od:player:N` — no `|`,
// `=`, `?`, `#`); running them through encodeURIComponent would instead
// break Oddin's parser.
export function buildSelectionId(
  eventUrn: string,
  providerMarketId: number,
  outcomeId: string,
  specifiers: Record<string, string>,
): string {
  const keys = Object.keys(specifiers).sort();
  const qs = keys.map((k) => `${k}=${specifiers[k]!}`).join("|");
  const base = `${eventUrn}/${providerMarketId}/${outcomeId}`;
  return qs ? `${base}?${qs}` : base;
}
