// The predicates that decide whether a match belongs in a storefront
// list. Shared by /catalog (every list / count endpoint) and by anything
// else that has to draw from "the current bettable offer" — the
// ComboZilla pool (lib/combozilla.ts) is the second consumer, and it must
// agree with the lobby byte-for-byte or the carousel recommends a match
// the list below it does not show.

import { eq, notInArray, sql } from "drizzle-orm";
import { categories, matches, tournaments } from "@oddzilla/db";

// Has-active-market guard. Every list/count endpoint runs this so we
// skip matches with zero active markets — there's nothing to bet on,
// the card would render empty. Intentionally lenient: a real live
// match can have its match-winner briefly suspended (mid-round, post-
// goal in football) while secondary markets stay open, and we still
// want the row visible.
//
// Defense in depth on the storefront side. One lifecycle clause:
// matches.status IN ('not_started','live') — closed/cancelled matches
// drop out even if a stray market row stayed at status=1 (settlement
// only flips markets it touches; an untouched market on a closed event
// would otherwise keep the card visible).
//
// THERE IS NO TIME GATE, and its removal is deliberate (operator's call,
// 2026-09-07). From 2026-05-11 this also dropped any `not_started` match
// whose kickoff was more than six hours old, on the reasoning that a
// fixture that never went live is broken feed data — the 2026-05-09
// disk-full incident had wedged 33 such rows. It was the wrong remedy in
// two ways.
//
// It fixed nothing. The gate is a LIST predicate, and placement never
// consulted it: `POST /bets` accepts any market on a `not_started` match
// regardless of age, and /match/:id serves it by direct link. So a wedged
// match went on being bettable at frozen odds, which is the actual
// hazard; the gate only stopped it appearing where anyone — including
// us — would notice. It hid the evidence and left the exposure.
//
// And it cost us the operator's own book. A custom event opens now and
// resolves in months, so its `scheduled_at` is a publication time, not a
// kickoff, and six hours later the rule read it as broken data. That was
// patched with a carve-out on `custom_event_config.ends_at`, which then
// had to be added to three copies of the gate and only ever reached one:
// on 2026-09-07 the Custom sport vanished from the sidebar while
// /catalog/sports/custom still served it. Measured when the gate came
// out, it was hiding exactly two matches on production — both of them
// operator-authored events, and not one wedged feed match.
//
// What actually contains a wedged match is structural and already in
// place: suspend-before-recover on every AMQP reconnect, the alive
// watchdog's 20 s silence flush, and /admin/wedged-matches for the
// leftovers. Those set markets to status=-1, which removes the row from
// lists AND refuses placement. A wedged match is now VISIBLE, which is
// the point: it is a bug to fix, not noise to hide.
export const hasActiveMarket = sql`EXISTS (
  SELECT 1 FROM markets mk
   WHERE mk.match_id = ${matches.id}
     AND mk.status = 1
) AND ${bookableWindow(matches)}`;

/**
 * The lifecycle half of the guard above — "is this match still something
 * we can show" — for callers that reach `matches` through a RAW SQL alias
 * instead of the Drizzle table.
 *
 * It is shared rather than inlined because it was inlined once and the
 * copies drifted. `/catalog/sports` and the tournament facet of
 * `/catalog/search` each carry a correlated EXISTS over their own alias
 * (`m`, `mm`), and when the custom-event carve-out was added to the gate
 * it reached `hasActiveMarket` and neither of them — which is how the
 * Custom sport came to be missing from the sidebar while its own sport
 * page still served it. The clause that caused that is gone now, but the
 * shape that let one predicate disagree with another is what this
 * function exists to prevent. Call it; do not write a fourth copy.
 *
 * `alias` is interpolated raw, so it must be a literal from our own code —
 * never a value off a request.
 */
export function bookableWindow(alias: typeof matches | string) {
  const status = typeof alias === "string" ? sql.raw(`${alias}.status`) : matches.status;
  return sql`(${status} = 'live' OR ${status} = 'not_started')`;
}

// Tournaments whose name matches one of these strings are hidden from
// every list/count endpoint. Oddin's integration broker exposes test
// tournaments (e.g. "Integration testing" with bot teams "Integration
// testing 1/2") that are useful for protocol verification but never
// belong on the storefront. Match by exact name — these strings are
// stable Oddin constants. The `/catalog/matches/:id` detail route
// intentionally does not filter by this list: hidden tournaments are
// unreachable through the UI anyway, and a deep link should still
// resolve so admin/debug tooling keeps working.
export const HIDDEN_TOURNAMENT_NAMES = ["Integration testing"];
export const notHiddenTournament = notInArray(tournaments.name, HIDDEN_TOURNAMENT_NAMES);

// Categories an operator has flagged as list-excluded (migration 0102).
// Fonbet files EA FC simulations under the real Football sport, so 10 of
// Football's 23 live matches — and 184 of its upcoming ones — were
// computer-played 2x4-minute games crowding out the actual football offer
// (measured on production 2026-09-04). The flag removes them from every
// list a bettor gets WITHOUT asking — the lobby, /live, /upcoming, the
// sport page default view, and the per-sport live badge that labels them.
//
// It is NOT a hidden-tournament-style blackout: the sidebar tree still
// carries the category, and any EXPLICIT narrowing (?category=, ?tournament=
// or ?team=) drops this predicate so the offer is one click away. That is
// the whole distinction — HIDDEN_TOURNAMENT_NAMES hides rows that should
// never be reachable, this one hides rows that shouldn't be the default.
export const notHiddenCategory = eq(categories.hiddenFromLists, false);
