// Which market cards on the match page are collapsed to their title.
//
// Keyed by market KIND rather than by market row, so a bettor who folds
// "Handicap" away on one football match finds it folded on the next one
// too — a preference about a kind of market, not about one fixture. The
// kind is the catalogue table plus the sub-event: Fonbet reuses one
// table id across every sub-event ("Total" under Match, Corners and 1st
// half are three different cards), and those must fold independently.
//
// Persisted in localStorage. Read in an effect, never in the initial
// state, so the server render and the first client render agree; the
// cards therefore mount expanded and fold on the next paint for a
// returning bettor, which is the same trade the sidebar's sport tab
// makes. Every storage access is guarded — a private window or a
// browser that blocks site data just gives a page with nothing folded.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "oz:collapsed-markets";
// A bettor cannot meaningfully hold more preferences than this; the cap
// keeps the stored array from growing without bound over months.
const MAX_KEYS = 300;

/** Identity of a market kind across matches. */
export function marketKindKey(
  providerMarketId: number,
  variant: string | null | undefined,
): string {
  return `${providerMarketId}|${variant ?? ""}`;
}

function readStored(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function writeStored(keys: Set<string>): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Array.from(keys).slice(-MAX_KEYS)),
    );
  } catch {
    // Storage unavailable: the preference lives for this page only.
  }
}

export interface CollapsedMarkets {
  isCollapsed(key: string): boolean;
  toggle(key: string): void;
  collapse(keys: readonly string[]): void;
  expand(keys: readonly string[]): void;
}

export function useCollapsedMarkets(): CollapsedMarkets {
  const [keys, setKeys] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setKeys(readStored());
    setLoaded(true);
  }, []);

  // Write after the state settles rather than inside the updater, which
  // React may run twice in development.
  useEffect(() => {
    if (!loaded) return;
    writeStored(keys);
  }, [keys, loaded]);

  const toggle = useCallback((key: string) => {
    setKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const collapse = useCallback((ks: readonly string[]) => {
    setKeys((prev) => {
      const next = new Set(prev);
      for (const k of ks) next.add(k);
      return next;
    });
  }, []);

  const expand = useCallback((ks: readonly string[]) => {
    setKeys((prev) => {
      const next = new Set(prev);
      for (const k of ks) next.delete(k);
      return next;
    });
  }, []);

  return {
    isCollapsed: (key) => keys.has(key),
    toggle,
    collapse,
    expand,
  };
}
