// Canonical OBB selection_id wire format. Shared by the quote endpoint
// (which sends these ids to Oddin to price a session) and by bet placement
// (which RECONSTRUCTS them from the persisted legs to prove the legs we
// settle are exactly the legs Oddin priced). Keeping one implementation is
// load-bearing: if the two diverged, a bettor could price one leg set and
// settle another at the priced odds.
//
// Per the OBB doc §2.4.1 the format is literally
// `<event>/<market>/<outcome>?<spec>` where `<spec>` is `k1=v1&k2=v2` with
// values UNENCODED — the doc's example uses `?variant=way:two&way=two`
// (literal colon). Running values through encodeURIComponent breaks Oddin's
// parser; spec values come from Oddin's own feed so they're already safe
// (`way:two`, `total:over`, numeric thresholds — no `&`, `=`, `?`, `#`).
// Keys are sorted lexicographically for a stable round-trip with our
// markets.specifiers_hash.
export function buildSelectionId(
  eventUrn: string,
  providerMarketId: number,
  outcomeId: string,
  specifiers: Record<string, string>,
): string {
  const keys = Object.keys(specifiers).sort();
  const qs = keys.map((k) => `${k}=${specifiers[k]!}`).join("&");
  const base = `${eventUrn}/${providerMarketId}/${outcomeId}`;
  return qs ? `${base}?${qs}` : base;
}
