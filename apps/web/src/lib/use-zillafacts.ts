"use client";

// useZillaFacts — client-side hook that fetches the per-(market,
// outcome, team) streak bundle for a match exactly once on mount,
// then exposes the array of facts already sorted by score (highest
// impact first). Returns `loaded=false` until the fetch resolves so
// the storefront can decide whether to render a "loading" shimmer or
// skip rendering entirely when the API replies with an empty array.
//
// Mirrors the shape of useZillaTips so the storefront can wire either
// widget the same way, but ZillaFacts is a single flat list (one
// card per fact) instead of a per-marketId map — cards render inline
// as a horizontal band, not pinned to individual market headers.

import { useEffect, useState } from "react";
import { clientApi } from "./api-client";
import type {
  ZillaFact,
  ZillaFactsResponse,
} from "@oddzilla/types/zillafacts";

interface ZillaFactsState {
  facts: ZillaFact[];
  loaded: boolean;
}

const EMPTY_STATE: ZillaFactsState = {
  facts: [],
  loaded: false,
};

export function useZillaFacts(matchId: string): ZillaFactsState {
  const [state, setState] = useState<ZillaFactsState>(EMPTY_STATE);

  useEffect(() => {
    let cancelled = false;
    setState(EMPTY_STATE);
    clientApi<ZillaFactsResponse>(`/catalog/matches/${matchId}/zillafacts`)
      .then((res) => {
        if (cancelled) return;
        setState({ facts: res.facts, loaded: true });
      })
      .catch(() => {
        // Failure is non-fatal — the band just doesn't render. We
        // don't surface an error toast for a non-essential overlay
        // (mirrors the ZillaTips swallow-and-continue behaviour).
        if (cancelled) return;
        setState({ facts: [], loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  return state;
}
