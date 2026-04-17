"use client";

// Bet slip store — React Context + localStorage persistence. No Zustand
// dependency. Singles only for MVP; the data model accepts more but the
// UI + API refuse multi-selection.

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

const STORAGE_KEY = "oddzilla.betslip.v1";

interface SlipState {
  selections: SlipSelection[];
  open: boolean;
}

interface SlipContextValue extends SlipState {
  add(selection: SlipSelection): void;
  remove(marketId: string, outcomeId: string): void;
  clear(): void;
  setOpen(open: boolean): void;
  has(marketId: string, outcomeId: string): boolean;
}

const SlipContext = createContext<SlipContextValue | null>(null);

function loadFromStorage(): SlipState {
  if (typeof window === "undefined") return { selections: [], open: false };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { selections: [], open: false };
    const parsed = JSON.parse(raw) as Partial<SlipState>;
    return {
      selections: Array.isArray(parsed.selections) ? parsed.selections : [],
      open: false, // never restore open state — surprising UX otherwise
    };
  } catch {
    return { selections: [], open: false };
  }
}

export function BetSlipProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SlipState>(() => ({ selections: [], open: false }));

  useEffect(() => {
    setState(loadFromStorage());
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ selections: state.selections }),
      );
    } catch {
      // localStorage quota/disabled — slip just won't persist.
    }
  }, [state.selections]);

  const add = useCallback((selection: SlipSelection) => {
    setState((prev) => {
      // Singles only: replace any existing selection with the new one.
      return { ...prev, selections: [selection], open: true };
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

  const has = useCallback(
    (marketId: string, outcomeId: string) => {
      return state.selections.some(
        (s) => s.marketId === marketId && s.outcomeId === outcomeId,
      );
    },
    [state.selections],
  );

  const value = useMemo<SlipContextValue>(
    () => ({ ...state, add, remove, clear, setOpen, has }),
    [state, add, remove, clear, setOpen, has],
  );

  return <SlipContext.Provider value={value}>{children}</SlipContext.Provider>;
}

export function useBetSlip(): SlipContextValue {
  const ctx = useContext(SlipContext);
  if (!ctx) throw new Error("useBetSlip must be inside <BetSlipProvider>");
  return ctx;
}
