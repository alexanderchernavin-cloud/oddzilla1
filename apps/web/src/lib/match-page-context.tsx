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

interface ActiveMatch {
  matchId: string;
  sportSlug: string;
  sportName: string;
  homeTeam: string;
  awayTeam: string;
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
  useEffect(() => {
    if (!ctx) return;
    ctx.set({
      matchId: props.matchId,
      sportSlug: props.sportSlug,
      sportName: props.sportName,
      homeTeam: props.homeTeam,
      awayTeam: props.awayTeam,
    });
    return () => {
      ctx.set(null);
    };
  }, [
    ctx,
    props.matchId,
    props.sportSlug,
    props.sportName,
    props.homeTeam,
    props.awayTeam,
  ]);
  return null;
}
