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
// Defense in depth on the storefront side. Two clauses:
//
//   1. matches.status IN ('not_started','live') — closed/cancelled
//      matches drop out even if a stray market row stayed at status=1
//      (settlement only flips markets it touches; an untouched market
//      on a closed event would otherwise keep the card visible).
//
//   2. A 6 h time gate on `not_started`: if Oddin never delivered the
//      lifecycle transition (e.g. our service was down for hours and
//      the message fell outside the recovery window), the row stays
//      stuck at `not_started` past its scheduled start. A match
//      scheduled > 6 h ago that hasn't moved to `live` is broken data —
//      live esports rounds don't run that long. Hides it from listings
//      until the suspend-before-recover flush or the admin
//      "Refresh from REST" tool repairs the row. Live matches don't
//      need the gate (by definition the lifecycle DID advance).
export const hasActiveMarket = sql`EXISTS (
  SELECT 1 FROM markets mk
   WHERE mk.match_id = ${matches.id}
     AND mk.status = 1
) AND (
  ${matches.status} = 'live'
  OR (${matches.status} = 'not_started'
      AND ${matches.scheduledAt} > NOW() - INTERVAL '6 hours')
)`;

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
