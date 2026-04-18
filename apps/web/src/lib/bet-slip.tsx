"use client";

// Bet slip store — React Context + localStorage persistence. Accumulates
// selections across matches. Two placement modes:
//   single: place N independent tickets (one per selection)
//   combo:  place one multi-selection ticket (all must win)
//
// Per-market rule: only one outcome per market at a time. Clicking a
// different outcome of the same market swaps the selection. Clicking the
// same outcome again removes it (handled by the caller via `has` + `remove`).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SlipSelection } from "@oddzilla/types";

const STORAGE_KEY = "oddzilla.betslip.v2";

export type SlipMode = "single" | "combo";

interface SlipState {
  selections: SlipSelection[];
  mode: SlipMode;
  open: boolean;
}

interface SlipContextValue extends SlipState {
  add(selection: SlipSelection): void;
  remove(marketId: string, outcomeId: string): void;
  clear(): void;
  setOpen(open: boolean): void;
  setMode(mode: SlipMode): void;
  has(marketId: string, outcomeId: string): boolean;
}

const SlipContext = createContext<SlipContextValue | null>(null);

function loadFromStorage(): SlipState {
  if (typeof window === "undefined") {
    return { selections: [], mode: "combo", open: false };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { selections: [], mode: "combo", open: false };
    const parsed = JSON.parse(raw) as Partial<SlipState>;
    const mode: SlipMode = parsed.mode === "single" ? "single" : "combo";
    return {
      selections: Array.isArray(parsed.selections) ? parsed.selections : [],
      mode,
      open: false, // never restore open state — surprising UX otherwise
    };
  } catch {
    return { selections: [], mode: "combo", open: false };
  }
}

export function BetSlipProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SlipState>(() => ({
    selections: [],
    mode: "combo",
    open: false,
  }));

  useEffect(() => {
    setState(loadFromStorage());
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ selections: state.selections, mode: state.mode }),
      );
    } catch {
      // localStorage quota/disabled — slip just won't persist.
    }
  }, [state.selections, state.mode]);

  const add = useCallback((selection: SlipSelection) => {
    setState((prev) => {
      // Drop any existing selection on the same market — only one outcome
      // per market is selectable at a time.
      const withoutSameMarket = prev.selections.filter(
        (s) => s.marketId !== selection.marketId,
      );
      return {
        ...prev,
        selections: [...withoutSameMarket, selection],
        open: true,
      };
    });
  }, []);

  const remove = useCallback((marketId: string, outcomeId: string) => {
    setState((prev) => ({
      ...prev,
      selections: prev.selections.filter(
        (s) => !(s.marketId === marketId && s.outcomeId === outcomeId),
      ),
    }));
  }, []);

  const clear = useCallback(() => {
    setState((prev) => ({ ...prev, selections: [] }));
  }, []);

  const setOpen = useCallback((open: boolean) => {
    setState((prev) => ({ ...prev, open }));
  }, []);

  const setMode = useCallback((mode: SlipMode) => {
    setState((prev) => ({ ...prev, mode }));
  }, []);

  const has = useCallback(
    (marketId: string, outcomeId: string) => {
      return state.selections.some(
        (s) => s.marketId === marketId && s.outcomeId === outcomeId,
      );
    },
    [state.selections],
  );

  const value = useMemo<SlipContextValue>(
    () => ({ ...state, add, remove, clear, setOpen, setMode, has }),
    [state, add, remove, clear, setOpen, setMode, has],
  );

  return <SlipContext.Provider value={value}>{children}</SlipContext.Provider>;
}

export function useBetSlip(): SlipContextValue {
  const ctx = useContext(SlipContext);
  if (!ctx) throw new Error("useBetSlip must be inside <BetSlipProvider>");
  return ctx;
}
