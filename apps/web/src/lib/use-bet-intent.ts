"use client";

// Placement intent for the bet slip (server side: services/api
// modules/bets/intent.ts, migration 0097).
//
// The slip requests a short-lived token from POST /bets/intent whenever
// its selection SET changes (adding / removing a leg — not on price
// ticks), keeps it fresh ahead of expiry, and hands it to POST /bets. The
// server pins the token to the user + selection set and measures the
// quote -> place gap against the operator's minimum human time; a
// placement confirmed too quickly is rejected with `intent_too_fast`, so
// `ensure()` callers wait out the remainder before posting.
//
// Failure is soft: if the intent call fails the slip still submits and
// the server decides (`intent_required` when the gate is on).

import { useCallback, useEffect, useRef, useState } from "react";
import { clientApi } from "@/lib/api-client";
import type { BetIntentResponse } from "@oddzilla/types";

export interface BetIntent {
  // Canonical key of the selection set the token was minted for.
  key: string;
  token: string;
  issuedAt: number;
  expiresAt: number;
  minHumanMs: number;
  required: boolean;
}

interface SelectionKeyLike {
  marketId: string;
  outcomeId: string;
}

const DEBOUNCE_MS = 150;
// Re-quote this far before the token expires so a slip left open for a
// few minutes still places on the first click.
const REFRESH_MARGIN_MS = 15_000;
// Treat a token as unusable this close to expiry — the request itself
// takes time to land.
const EXPIRY_SLACK_MS = 2_000;

export function intentKeyFor(selections: ReadonlyArray<SelectionKeyLike>): string {
  return Array.from(new Set(selections.map((s) => `${s.marketId}:${s.outcomeId}`)))
    .sort()
    .join("|");
}

export function useBetIntent(
  selections: ReadonlyArray<SelectionKeyLike>,
  enabled: boolean,
) {
  const key = intentKeyFor(selections);
  const [intent, setIntent] = useState<BetIntent | null>(null);
  const intentRef = useRef<BetIntent | null>(null);
  const inflight = useRef<{ key: string; promise: Promise<BetIntent | null> } | null>(null);
  const selectionsRef = useRef(selections);
  selectionsRef.current = selections;

  const fetchIntent = useCallback(async (forKey: string): Promise<BetIntent | null> => {
    if (inflight.current && inflight.current.key === forKey) {
      return inflight.current.promise;
    }
    const sels = selectionsRef.current.map((s) => ({
      marketId: s.marketId,
      outcomeId: s.outcomeId,
    }));
    const promise = (async () => {
      try {
        const res = await clientApi<BetIntentResponse>("/bets/intent", {
          method: "POST",
          body: JSON.stringify({ selections: sels }),
        });
        const next: BetIntent = {
          key: forKey,
          token: res.token,
          issuedAt: res.issuedAt,
          expiresAt: res.expiresAt,
          minHumanMs: res.minHumanMs,
          required: res.required,
        };
        // Adopt only if the slip still shows the same set — a leg may
        // have been added or removed while the request was in flight.
        if (intentKeyFor(selectionsRef.current) === forKey) {
          intentRef.current = next;
          setIntent(next);
        }
        return next;
      } catch {
        return null;
      } finally {
        if (inflight.current?.key === forKey) inflight.current = null;
      }
    })();
    inflight.current = { key: forKey, promise };
    return promise;
  }, []);

  // Quote on every selection-set change (debounced so a burst of adds
  // from "Copy this bet" or a ZillaBuild card costs one round trip).
  useEffect(() => {
    if (!enabled || key === "") {
      intentRef.current = null;
      setIntent(null);
      return;
    }
    const timer = window.setTimeout(() => void fetchIntent(key), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [key, enabled, fetchIntent]);

  // Keep the token fresh while the slip sits open.
  useEffect(() => {
    if (!intent || !enabled) return;
    const delay = Math.max(1_000, intent.expiresAt - REFRESH_MARGIN_MS - Date.now());
    const timer = window.setTimeout(() => void fetchIntent(intent.key), delay);
    return () => window.clearTimeout(timer);
  }, [intent, enabled, fetchIntent]);

  // Current usable token for the slip as it stands now, fetching one if
  // the cached token is missing, stale, or for a different set.
  const ensure = useCallback(async (): Promise<BetIntent | null> => {
    const wanted = intentKeyFor(selectionsRef.current);
    if (wanted === "") return null;
    const cur = intentRef.current;
    if (cur && cur.key === wanted && Date.now() < cur.expiresAt - EXPIRY_SLACK_MS) {
      return cur;
    }
    return fetchIntent(wanted);
  }, [fetchIntent]);

  const invalidate = useCallback(() => {
    intentRef.current = null;
    setIntent(null);
  }, []);

  return { intent, ensure, invalidate };
}

// Milliseconds still to wait before this intent satisfies the server's
// minimum human time; 0 when it already does.
export function intentWaitMs(intent: BetIntent | null, now: number = Date.now()): number {
  if (!intent) return 0;
  return Math.max(0, intent.issuedAt + intent.minHumanMs - now);
}
