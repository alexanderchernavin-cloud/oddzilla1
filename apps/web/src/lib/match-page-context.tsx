"use client";

// MatchPageContext — lets a match-detail page tell the persistent shell
// (specifically BetSlipRail) that it's currently looking at a specific
// match. The rail uses this to render the Oddin Disir prematch widget
// below the bet slip on desktop.
//
// Usage from the match page (server-renders the page, mounts a small
// client child to register the active match):
//   <MatchPageRegistrar matchId={...} sportSlug={...} sportName={...} />
//
// On unmount the active match clears, so navigating away from the
// match page hides the widget.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useLiveMatchStatus } from "./use-live-odds";
import type { SportradarMatchRef } from "@oddzilla/types/sportradar";

export interface ActiveMatch {
  matchId: string;
  sportSlug: string;
  sportName: string;
  homeTeam: string;
  awayTeam: string;
  // Match lifecycle status — the rail panel gates the Analyses tab's
  // visibility off this.
  matchStatus: "not_started" | "live" | "closed" | "cancelled" | "suspended";
  // Server-side auth signal routed through context so the rail can
  // render the right CTA (write-analysis button) without a second auth
  // round-trip. Cookie-presence only — see page.tsx for the rationale.
  loggedIn: boolean;
  // Operator-confirmed Sportradar mapping (migration 0100), or null.
  // The rail uses it to mount Head to Head under the bet slip; like the
  // tracker on the page itself, no mapping means no widget.
  sportradar: SportradarMatchRef | null;
}

interface MatchPageContextValue {
  active: ActiveMatch | null;
  set: (m: ActiveMatch | null) => void;
}

const MatchPageContext = createContext<MatchPageContextValue | null>(null);

export function MatchPageProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveMatch | null>(null);
  const set = useCallback((m: ActiveMatch | null) => {
    setActive(m);
  }, []);
  const value = useMemo(() => ({ active, set }), [active, set]);
  return (
    <MatchPageContext.Provider value={value}>{children}</MatchPageContext.Provider>
  );
}

export function useActiveMatchPage(): ActiveMatch | null {
  // Allow reads when the provider isn't mounted (e.g. admin pages); the
  // rail component just won't render the widget panel.
  const ctx = useContext(MatchPageContext);
  return ctx?.active ?? null;
}

export function MatchPageRegistrar(props: ActiveMatch) {
  const ctx = useContext(MatchPageContext);
  // Only depend on the stable setter — the whole ctx object would
  // change identity every time `active` updates (provider memos
  // value as `{ active, set }`), so the very setActive this effect
  // dispatches would re-fire the effect, infinitely. That loop locks
  // the render queue and the rest of the shell (sidebar links, top
  // bar) stops processing clicks.
  const set = ctx?.set;
  // Overlay live lifecycle ticks on the SSR-baked status. When a
  // match closes mid-session the rail's match panel (RailMatchPanel)
  // gates Analyses visibility off this value — without the overlay
  // the tab stays hidden until the bettor reloads.
  const liveStatus = useLiveMatchStatus(props.matchId);
  const effectiveStatus = liveStatus?.status ?? props.matchStatus;
  // Depend on the two ids rather than the object: the mapping arrives as
  // a fresh object on every parent render, and an object in the dep list
  // would re-fire this effect (and the set/clear pair inside it) on ticks
  // that changed nothing about the fixture.
  const srMatchId = props.sportradar?.srMatchId ?? null;
  const srSportId = props.sportradar?.srSportId ?? null;
  useEffect(() => {
    if (!set) return;
    set({
      matchId: props.matchId,
      sportSlug: props.sportSlug,
      sportName: props.sportName,
      homeTeam: props.homeTeam,
      awayTeam: props.awayTeam,
      matchStatus: effectiveStatus,
      loggedIn: props.loggedIn,
      sportradar:
        srMatchId != null && srSportId != null
          ? { srMatchId, srSportId }
          : null,
    });
    return () => {
      set(null);
    };
  }, [
    set,
    props.matchId,
    props.sportSlug,
    props.sportName,
    props.homeTeam,
    props.awayTeam,
    effectiveStatus,
    props.loggedIn,
    srMatchId,
    srSportId,
  ]);
  return null;
}
