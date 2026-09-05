"use client";

// RailHeadToHead — Sportradar's Head to Head panel, mounted in the right
// rail directly under the bet slip on a match-detail page.
//
// Gated on the same operator-confirmed Sportradar mapping the tracker
// uses (migration 0100): the widget is keyed by a Sportradar match id
// that neither feed carries, so an unmapped fixture renders nothing
// rather than an empty frame. Reads the mapping from MatchPageContext,
// which the match page's registrar populates — so this renders on match
// pages only and clears itself on navigation, exactly like the tabbed
// panel below it.

import { useActiveMatchPage } from "@/lib/match-page-context";
import { SportradarHeadToHead } from "./sportradar-h2h";

export function RailHeadToHead() {
  const active = useActiveMatchPage();
  if (!active?.sportradar) return null;
  return (
    <SportradarHeadToHead
      // Re-mount per fixture so the iframe loads the new match instead of
      // keeping the previous one's hash-driven state.
      key={active.matchId}
      srMatchId={active.sportradar.srMatchId}
      srSportId={active.sportradar.srSportId}
    />
  );
}
