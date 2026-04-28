"use client";

// Bet slip store — React Context + localStorage persistence. Accumulates
// selections across matches. Two placement modes:
//   single: place N independent tickets (one per selection)
//   combo:  place one multi-selection ticket (all must win)
//
// Per-match rule: only one outcome per match at a time. Picking another
// market or outcome from the same match replaces the previous selection
// for that match. This keeps combos on DIFFERENT matches only — required
// until BetBuilder-style same-match parlays are integrated. Clicking the
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
import { isCurrency, SUPPORTED_CURRENCIES, type Currency } from "@oddzilla/types/currencies";
import type { SlipSelection } from "@oddzilla/types";

const STORAGE_KEY = "oddzilla.betslip.v2";
// New users land on the demo OZ wallet so the bet flow is testable
// out-of-the-box without on-chain top-up.
const DEFAULT_SLIP_CURRENCY: Currency = "OZ";

export type SlipMode = "single" | "combo";

interface SlipState {
  selections: SlipSelection[];
  mode: SlipMode;
  open: boolean;
  currency: Currency;
}

interface SlipContextValue extends SlipState {
  add(selection: SlipSelection): void;
  remove(marketId: string, outcomeId: string): void;
  clear(): void;
  setOpen(open: boolean): void;
  setMode(mode: SlipMode): void;
  setCurrency(currency: Currency): void;
  has(marketId: string, outcomeId: string): boolean;
}

const SlipContext = createContext<SlipContextValue | null>(null);

function loadFromStorage(): SlipState {
  if (typeof window === "undefined") {
    return {
      selections: [],
      mode: "combo",
      open: false,
      currency: DEFAULT_SLIP_CURRENCY,
    };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        selections: [],
        mode: "combo",
        open: false,
        currency: DEFAULT_SLIP_CURRENCY,
      };
    }
    const parsed = JSON.parse(raw) as Partial<SlipState>;
    const mode: SlipMode = parsed.mode === "single" ? "single" : "combo";
    const currency: Currency = isCurrency(parsed.currency)
      ? parsed.currency
      : DEFAULT_SLIP_CURRENCY;
    return {
      selections: Array.isArray(parsed.selections) ? parsed.selections : [],
      mode,
      open: false, // never restore open state — surprising UX otherwise
      currency,
    };
  } catch {
    return {
      selections: [],
      mode: "combo",
      open: false,
      currency: DEFAULT_SLIP_CURRENCY,
    };
  }
}

export function BetSlipProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SlipState>(() => ({
    selections: [],
    mode: "combo",
    open: false,
    currency: DEFAULT_SLIP_CURRENCY,
  }));

  useEffect(() => {
    setState(loadFromStorage());
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          selections: state.selections,
          mode: state.mode,
          currency: state.currency,
        }),
      );
    } catch {
      // localStorage quota/disabled — slip just won't persist.
    }
  }, [state.selections, state.mode, state.currency]);

  const add = useCallback((selection: SlipSelection) => {
    setState((prev) => {
      // Drop any existing selection on the same MATCH. We don't allow two
      // selections from the same match in the slip — clicking a different
      // market or outcome in a match the user already has in the slip
      // simply replaces the previous pick for that match.
      const withoutSameMatch = prev.selections.filter(
        (s) => s.matchId !== selection.matchId,
      );
      return {
        ...prev,
        selections: [...withoutSameMatch, selection],
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

  const setCurrency = useCallback((currency: Currency) => {
    if (!isCurrency(currency)) return;
    setState((prev) => ({ ...prev, currency }));
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
    () => ({ ...state, add, remove, clear, setOpen, setMode, setCurrency, has }),
    [state, add, remove, clear, setOpen, setMode, setCurrency, has],
  );

  return <SlipContext.Provider value={value}>{children}</SlipContext.Provider>;
}

export function useBetSlip(): SlipContextValue {
  const ctx = useContext(SlipContext);
  if (!ctx) throw new Error("useBetSlip must be inside <BetSlipProvider>");
  return ctx;
}
