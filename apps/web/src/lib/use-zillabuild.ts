"use client";

// useZillaBuild — fetches the pre-built BetBuilder card set for a match
// once on mount, then exposes it. Odds are re-quoted server-side on every
// open (the route is no-store), so a fresh mount = fresh prices. Failure
// is non-fatal: the widget just doesn't render.

import { useEffect, useState } from "react";
import { clientApi } from "./api-client";
import type { ZillaBuildResponse } from "@oddzilla/types/zillabuild";

interface ZillaBuildState {
  response: ZillaBuildResponse | null;
  loaded: boolean;
}

const EMPTY: ZillaBuildState = { response: null, loaded: false };

export function useZillaBuild(matchId: string): ZillaBuildState {
  const [state, setState] = useState<ZillaBuildState>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    setState(EMPTY);
    // Empty id is the caller's "don't fetch" sentinel (e.g. a live/closed
    // match where ZillaBuild is prematch-only) — stay in the unloaded
    // state so the widget renders nothing without a wasted round-trip.
    if (!matchId) return;
    clientApi<ZillaBuildResponse>(`/catalog/matches/${matchId}/zillabuild`)
      .then((res) => {
        if (!cancelled) setState({ response: res, loaded: true });
      })
      .catch(() => {
        if (!cancelled) setState({ response: null, loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  return state;
}
