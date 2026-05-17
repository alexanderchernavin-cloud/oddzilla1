"use client";

// Client-side ZillaPass state. Single owner of the `/zillapass/me`
// fetch + the 30 s background poll. Consumers (top-bar chip + the
// `/zillapass` page + the tracker hooks) all read from this context.
//
// Two write paths so the chip can update in real time:
//   - refresh()   — fetches fresh state. Used after bet placement
//                   and any other event that mutates progress
//                   without going through POST /zillapass/track.
//   - setData()   — replace state wholesale. The trackers call this
//                   with the body returned by POST /zillapass/track
//                   so the chip flips immediately on click without
//                   a second round-trip.
//
// Anonymous viewers get a no-op provider: useZillapass() returns
// `null` data and inert refresh / setData functions.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ZillapassMeResponse } from "@oddzilla/types";
import { ApiFetchError, clientApi } from "@/lib/api-client";
import { useSessionUserId } from "@/lib/session-user";

const POLL_MS = 30_000;

interface ZillapassContextValue {
  data: ZillapassMeResponse | null;
  refresh: () => Promise<void>;
  setData: (next: ZillapassMeResponse) => void;
}

const ZillapassContext = createContext<ZillapassContextValue>({
  data: null,
  refresh: async () => {
    // no-op for anonymous viewers; the chip / page won't render the
    // entry points that depend on this context anyway.
  },
  setData: () => {
    // no-op for anonymous viewers.
  },
});

export function ZillapassProvider({ children }: { children: ReactNode }) {
  const userId = useSessionUserId();
  const [data, setLocalData] = useState<ZillapassMeResponse | null>(null);
  // Track whether the provider is mounted, so a poll that arrives
  // after unmount doesn't try to setState on a dead tree.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await clientApi<ZillapassMeResponse>("/zillapass/me");
      if (aliveRef.current) setLocalData(res);
    } catch (e) {
      // 401 on first paint is normal (cookies still propagating);
      // anything else is transient — silent retry on next poll.
      if (e instanceof ApiFetchError && e.status === 401) return;
    }
  }, [userId]);

  const setData = useCallback((next: ZillapassMeResponse) => {
    if (aliveRef.current) setLocalData(next);
  }, []);

  useEffect(() => {
    if (!userId) {
      setLocalData(null);
      return;
    }
    void refresh();
    const t = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [userId, refresh]);

  return (
    <ZillapassContext.Provider value={{ data, refresh, setData }}>
      {children}
    </ZillapassContext.Provider>
  );
}

export function useZillapass(): ZillapassContextValue {
  return useContext(ZillapassContext);
}
