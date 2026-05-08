"use client";

// Bet slip store — React Context + localStorage persistence. Accumulates
// selections across matches. Five placement modes:
//   single:     place N independent tickets (one per selection)
//   combo:      place one multi-selection ticket (all legs must win)
//   tiple:      place one ticket that wins if at least one leg wins
//   tippot:     place one ticket whose payout depends on the # of winning legs
//   betbuilder: same-match parlay priced by Oddin OBB; payout = stake ×
//               session_odds when every leg wins, refund on void, 0 on
//               loss (see services/api /betbuilder/* + docs/ODDIN.md).
//
// Default per-match rule: only one outcome per match at a time. Picking
// another market or outcome from the same match replaces the previous
// pick. BetBuilder mode inverts this rule for ONE match: while
// `betbuilderMatchId` is set, same-match adds accumulate; switching
// matches drops every betbuilder leg and reverts to single behavior.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isCurrency, type Currency } from "@oddzilla/types/currencies";
import type {
  BetBuilderQuoteAcceptedResponse,
  SlipSelection,
} from "@oddzilla/types";

const STORAGE_KEY = "oddzilla.betslip.v2";
// New users land on the demo OZ wallet so the bet flow is testable
// out-of-the-box without on-chain top-up.
const DEFAULT_SLIP_CURRENCY: Currency = "OZ";

export type SlipMode = "single" | "combo" | "tiple" | "tippot" | "betbuilder";

const ALL_MODES: SlipMode[] = ["single", "combo", "tiple", "tippot", "betbuilder"];

interface SlipState {
  selections: SlipSelection[];
  mode: SlipMode;
  open: boolean;
  currency: Currency;
  /**
   * The match id BetBuilder is currently building for. Non-null only
   * while `mode === "betbuilder"`; cleared when the user switches mode
   * or picks a leg from a different match. Persisted across reloads
   * along with selections so a refresh on the match page keeps the
   * builder state.
   */
  betbuilderMatchId: string | null;
  /**
   * Latest accepted OBB quote for the current builder session. Cleared
   * whenever the leg set changes (the slip then re-quotes via the
   * provider hook). Set on every successful POST /betbuilder/match/:id/quote.
   */
  betbuilderQuote: BetBuilderQuoteAcceptedResponse | null;
  /**
   * OBB-eligible internal market ids for the current builder match, as
   * returned by GET /betbuilder/match/:id/markets. Used by the match
   * page to grey out outcomes whose market isn't OBB-supported BEFORE
   * the user picks the first leg (we don't have a SessionCreate quote
   * yet, so per-outcome gating from `betbuilderQuote.availableMarkets`
   * doesn't apply). Cleared with builder mode.
   */
  betbuilderEligibleMarketIds: string[] | null;
}

interface SlipContextValue extends SlipState {
  add(selection: SlipSelection): void;
  remove(marketId: string, outcomeId: string): void;
  clear(): void;
  setOpen(open: boolean): void;
  setMode(mode: SlipMode): void;
  setCurrency(currency: Currency): void;
  has(marketId: string, outcomeId: string): boolean;
  // Forward a live odds tick into the slip. The store decides what to
  // mutate:
  //   - `active` is applied immediately (suspension is a hard gate, no
  //     user opt-in).
  //   - When the tick's odds match the user-accepted `odds`, any prior
  //     `pendingOdds` is cleared (drift snapped back).
  //   - When the tick's odds differ, they're stashed as `pendingOdds`
  //     so the rail can show "old → new" and require an explicit
  //     "Accept odds change" before Place bet.
  // No-op when nothing tracked changes (avoids re-render churn on every
  // WS frame).
  updateOdds(
    marketId: string,
    outcomeId: string,
    odds: string,
    probability?: string,
    active?: boolean,
  ): void;
  // Promote every selection's pendingOdds/pendingProbability into the
  // accepted `odds`/`probability` fields and clear the pending state.
  // Called when the user clicks "Accept odds change" in the rail.
  // No-op if no selection has a pending update.
  acceptPendingOdds(): void;
  // ── BetBuilder controls ────────────────────────────────────────────
  /**
   * Enter BetBuilder mode for a specific match. If `matchId` is null,
   * the slip exits builder mode and reverts to whichever mode the user
   * had previously (combo/single fallback). Switching builder to a
   * different match clears any prior betbuilder legs.
   */
  setBetbuilderMatch(matchId: string | null): void;
  /**
   * Cache the latest OBB quote response. The match-page provider
   * fetches /betbuilder/match/:id/quote whenever the leg set changes;
   * the slip rail consumes the cached value to render combined odds +
   * the place-bet payload.
   */
  setBetbuilderQuote(quote: BetBuilderQuoteAcceptedResponse | null): void;
  /**
   * Stash the OBB-eligible internal market ids for the current builder
   * match. The match-page toggle fetches /betbuilder/match/:id/markets
   * once on mount and pushes the result here so LiveMarkets can grey
   * out outcomes whose market isn't OBB-supported.
   */
  setBetbuilderEligibleMarkets(matchId: string, marketIds: string[]): void;
}

const SlipContext = createContext<SlipContextValue | null>(null);

function emptyState(): SlipState {
  return {
    selections: [],
    mode: "combo",
    open: false,
    currency: DEFAULT_SLIP_CURRENCY,
    betbuilderMatchId: null,
    betbuilderQuote: null,
    betbuilderEligibleMarketIds: null,
  };
}

function loadFromStorage(): SlipState {
  if (typeof window === "undefined") return emptyState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<SlipState>;
    const mode: SlipMode = ALL_MODES.includes(parsed.mode as SlipMode)
      ? (parsed.mode as SlipMode)
      : "combo";
    const currency: Currency = isCurrency(parsed.currency)
      ? parsed.currency
      : DEFAULT_SLIP_CURRENCY;
    return {
      selections: Array.isArray(parsed.selections) ? parsed.selections : [],
      mode,
      open: false, // never restore open state — surprising UX otherwise
      currency,
      betbuilderMatchId:
        typeof parsed.betbuilderMatchId === "string"
          ? parsed.betbuilderMatchId
          : null,
      // Quote is short-lived (Oddin invalidates a session in 10 min – 2 h);
      // we never restore it from storage. The match page re-quotes on mount.
      betbuilderQuote: null,
      // Eligible-markets list comes back from /betbuilder/match/:id/markets
      // on every mount; never restored. The match-page toggle re-probes.
      betbuilderEligibleMarketIds: null,
    };
  } catch {
    return emptyState();
  }
}

export function BetSlipProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SlipState>(() => emptyState());

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
          betbuilderMatchId: state.betbuilderMatchId,
        }),
      );
    } catch {
      // localStorage quota/disabled — slip just won't persist.
    }
  }, [state.selections, state.mode, state.currency, state.betbuilderMatchId]);

  const add = useCallback((selection: SlipSelection) => {
    // Strip any pending-odds carryover the caller might have copied
    // through — the click happens at the freshly-rendered price, so
    // by definition there's no drift to surface yet.
    const fresh: SlipSelection = {
      ...selection,
      pendingOdds: null,
      pendingProbability: null,
    };
    setState((prev) => {
      // BetBuilder branch: same-match accumulates, but the user must
      // also re-pick the same outcome — when the same (market, outcome)
      // is already in the slip the caller handles the toggle via has()/
      // remove(). Picking a leg from a different match drops the entire
      // betbuilder set and reverts to single-replace mode for the new
      // match.
      if (prev.mode === "betbuilder" && prev.betbuilderMatchId) {
        if (prev.betbuilderMatchId === fresh.matchId) {
          // Replace any prior pick on the SAME market (only one outcome
          // per market is meaningful) but keep the rest of the legs.
          const filtered = prev.selections.filter(
            (s) => s.marketId !== fresh.marketId,
          );
          return {
            ...prev,
            selections: [...filtered, fresh],
            // Mutated leg set — drop the cached quote so the rail
            // re-fetches a fresh combined-odds quote.
            betbuilderQuote: null,
            open: true,
          };
        }
        // Different match — exit builder, revert to single-replace.
        return {
          ...prev,
          selections: [fresh],
          mode: "combo",
          betbuilderMatchId: null,
          betbuilderQuote: null,
          betbuilderEligibleMarketIds: null,
          open: true,
        };
      }
      // Default behaviour: drop any existing selection on the same
      // MATCH and append the new one.
      const withoutSameMatch = prev.selections.filter(
        (s) => s.matchId !== fresh.matchId,
      );
      return {
        ...prev,
        selections: [...withoutSameMatch, fresh],
        open: true,
      };
    });
  }, []);

  const remove = useCallback((marketId: string, outcomeId: string) => {
    setState((prev) => {
      const next = prev.selections.filter(
        (s) => !(s.marketId === marketId && s.outcomeId === outcomeId),
      );
      // BetBuilder leg set changed — invalidate the cached quote.
      const quoteChanged = prev.mode === "betbuilder";
      return {
        ...prev,
        selections: next,
        betbuilderQuote: quoteChanged ? null : prev.betbuilderQuote,
        // Auto-exit builder mode when no legs are left so the slip
        // doesn't leave the user in a weird empty-builder state.
        ...(prev.mode === "betbuilder" && next.length === 0
          ? {
              mode: "combo" as const,
              betbuilderMatchId: null,
              betbuilderEligibleMarketIds: null,
            }
          : null),
      };
    });
  }, []);

  const clear = useCallback(() => {
    setState((prev) => ({
      ...prev,
      selections: [],
      ...(prev.mode === "betbuilder"
        ? {
            mode: "combo" as const,
            betbuilderMatchId: null,
            betbuilderQuote: null,
            betbuilderEligibleMarketIds: null,
          }
        : null),
    }));
  }, []);

  const setOpen = useCallback((open: boolean) => {
    setState((prev) => ({ ...prev, open }));
  }, []);

  const setMode = useCallback((mode: SlipMode) => {
    setState((prev) => {
      // Switching out of betbuilder clears builder-specific state. The
      // slip selections themselves stay — the user may then place them
      // as a normal combo if they're cross-match, or just keep the
      // current match's first leg as a single.
      if (prev.mode === "betbuilder" && mode !== "betbuilder") {
        return {
          ...prev,
          mode,
          betbuilderMatchId: null,
          betbuilderQuote: null,
          betbuilderEligibleMarketIds: null,
        };
      }
      // Switching into betbuilder is normally driven by the match-page
      // toggle (which calls setBetbuilderMatch). Keep this method
      // permissive for completeness.
      return { ...prev, mode };
    });
  }, []);

  const setBetbuilderMatch = useCallback((matchId: string | null) => {
    setState((prev) => {
      if (matchId === null) {
        if (prev.mode !== "betbuilder") return prev;
        // Turn-off explicitly drops every selection. The legs in a
        // builder slip are by definition same-match, so leaving them
        // in "combo" mode would just hand the user an orphan combo
        // that POST /bets rejects with `combo_same_match`. Cleaner to
        // wipe and let the user re-pick.
        return {
          ...prev,
          mode: "combo",
          betbuilderMatchId: null,
          betbuilderQuote: null,
          betbuilderEligibleMarketIds: null,
          selections: [],
        };
      }
      // Entering builder for a specific match — drop any selections
      // not from this match so the slip doesn't carry phantom combo
      // legs into the builder context.
      return {
        ...prev,
        mode: "betbuilder",
        betbuilderMatchId: matchId,
        selections: prev.selections.filter((s) => s.matchId === matchId),
        betbuilderQuote: null,
        // Drop the cached eligibility list when builder switches matches —
        // the match-page toggle re-fetches on mount for the new match.
        betbuilderEligibleMarketIds:
          prev.betbuilderMatchId === matchId
            ? prev.betbuilderEligibleMarketIds
            : null,
        open: true,
      };
    });
  }, []);

  const setBetbuilderQuote = useCallback(
    (quote: BetBuilderQuoteAcceptedResponse | null) => {
      setState((prev) => {
        if (prev.mode !== "betbuilder") return prev;
        return { ...prev, betbuilderQuote: quote };
      });
    },
    [],
  );

  const setBetbuilderEligibleMarkets = useCallback(
    (matchId: string, marketIds: string[]) => {
      setState((prev) => {
        // Only accept when builder is on for this exact match. Stops a
        // late-arriving probe response from a previous match leaking
        // into the active builder context after the user navigated.
        if (prev.mode !== "betbuilder" || prev.betbuilderMatchId !== matchId) {
          return prev;
        }
        return { ...prev, betbuilderEligibleMarketIds: marketIds };
      });
    },
    [],
  );

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

  const updateOdds = useCallback(
    (
      marketId: string,
      outcomeId: string,
      odds: string,
      probability?: string,
      active?: boolean,
    ) => {
      setState((prev) => {
        let changed = false;
        const next = prev.selections.map((s) => {
          if (s.marketId !== marketId || s.outcomeId !== outcomeId) return s;
          // Selections persisted before this field existed default to
          // active=true; an explicit boolean from the WS tick wins.
          const prevActive = s.active ?? true;
          const nextActive = active ?? prevActive;
          // Compute the next pending values relative to the user's
          // *accepted* odds. When the tick matches the accepted price,
          // pending is cleared (the broker just snapped back). When
          // it differs, stash the new odds + probability as pending —
          // the rail will surface them and require an explicit accept
          // before Place bet.
          const incomingProb =
            probability !== undefined && probability !== "" ? probability : null;
          const tickEqualsAccepted =
            odds === s.odds &&
            ((incomingProb ?? s.probability ?? null) === (s.probability ?? null));
          const prevPendingOdds = s.pendingOdds ?? null;
          const prevPendingProb = s.pendingProbability ?? null;
          const nextPendingOdds = tickEqualsAccepted ? null : odds;
          const nextPendingProb = tickEqualsAccepted ? null : incomingProb;
          if (
            prevActive === nextActive &&
            prevPendingOdds === nextPendingOdds &&
            prevPendingProb === nextPendingProb
          ) {
            return s;
          }
          changed = true;
          return {
            ...s,
            active: nextActive,
            pendingOdds: nextPendingOdds,
            pendingProbability: nextPendingProb,
          };
        });
        if (!changed) return prev;
        return { ...prev, selections: next };
      });
    },
    [],
  );

  const acceptPendingOdds = useCallback(() => {
    setState((prev) => {
      let changed = false;
      const next = prev.selections.map((s) => {
        if (s.pendingOdds == null) return s;
        changed = true;
        return {
          ...s,
          odds: s.pendingOdds,
          // Pending probability may be null (the WS frame omitted it);
          // fall back to the previous value rather than wiping a known-
          // good probability that the tippot/tiple preview depends on.
          probability: s.pendingProbability ?? s.probability,
          pendingOdds: null,
          pendingProbability: null,
        };
      });
      if (!changed) return prev;
      // BetBuilder leg odds also changed under the user — invalidate
      // the cached session quote so the rail re-fetches /betbuilder/
      // .../quote against the freshly-accepted leg set.
      const isBuilder = prev.mode === "betbuilder";
      return {
        ...prev,
        selections: next,
        betbuilderQuote: isBuilder ? null : prev.betbuilderQuote,
      };
    });
  }, []);

  const value = useMemo<SlipContextValue>(
    () => ({
      ...state,
      add,
      remove,
      clear,
      setOpen,
      setMode,
      setCurrency,
      has,
      updateOdds,
      acceptPendingOdds,
      setBetbuilderMatch,
      setBetbuilderQuote,
      setBetbuilderEligibleMarkets,
    }),
    [
      state,
      add,
      remove,
      clear,
      setOpen,
      setMode,
      setCurrency,
      has,
      updateOdds,
      acceptPendingOdds,
      setBetbuilderMatch,
      setBetbuilderQuote,
      setBetbuilderEligibleMarkets,
    ],
  );

  return <SlipContext.Provider value={value}>{children}</SlipContext.Provider>;
}

export function useBetSlip(): SlipContextValue {
  const ctx = useContext(SlipContext);
  if (!ctx) throw new Error("useBetSlip must be inside <BetSlipProvider>");
  return ctx;
}
