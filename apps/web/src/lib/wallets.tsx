"use client";

// Wallet store — client-side React Context that replaces the SSR
// `/wallet` fan-out call that used to fire from the (main) layout on
// every page render.
//
// Why this exists: the layout's `await serverApi("/wallet")` ran inside
// every authed request, queuing work on the api + postgres pool on top
// of all the other render-time fetches. Under the 5000-VU load test
// that fan-out was the proximate cause of web replicas crashing under
// the queue depth. Pulling it client-side means the SSR render is
// lighter, returns to the pool faster, and 5000 anonymous users no
// longer hammer /wallet at all (server returns immediately with a
// blank top-bar pill; the client fetch never fires because they
// aren't signed in).
//
// Provider responsibilities:
//   - Fetch /wallet ONCE on mount, only when the user is signed in.
//   - Expose the wallet array via useWallets().
//   - Optimistic deduct on bet placement so the top-bar / slip rail
//     show the new balance immediately (~0 ms) without waiting on the
//     next /wallet roundtrip.
//   - Refetch on user-channel ticket frames that move money: settled
//     (payout), cashed_out (cash-out credit), voided (refund). This
//     keeps the displayed balance authoritative even when the user
//     leaves a page open across a settlement.
//
// Important: the SERVER side of the wallet remains authoritative for
// bet acceptance — the api re-validates available_micro >= stake on
// every POST /bets. The optimistic state here is purely cosmetic; a
// mismatch (e.g. user opened two tabs and placed in both) shows up
// as a 400 from the api with a clear error, and the next refresh
// reconciles.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Currency } from "@oddzilla/types/currencies";
import type { WalletSnapshot, WalletListResponse } from "@oddzilla/types";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { useTicketStream } from "@/lib/use-ticket-stream";

interface WalletState {
  wallets: WalletSnapshot[];
  // `loading` is true between mount and first response. The top-bar
  // pill / bet-slip available-balance widgets render a skeleton while
  // this is true. `error` carries the last fetch error so callers can
  // distinguish "still loading" from "fetch failed".
  loading: boolean;
  error: string | null;
}

interface WalletContextValue extends WalletState {
  /**
   * Deduct `micro` from the matching currency's available balance,
   * immediately and locally. Use right after a successful POST /bets
   * so the user sees their new balance without waiting on a refetch.
   * Server stays authoritative — a subsequent settlement frame or
   * page navigation will reconcile any drift.
   */
  optimisticDeduct(currency: Currency, micro: bigint): void;
  /**
   * Manual refresh. Used by the wallet page after a withdrawal request
   * lands, and called automatically on user-channel ticket frames
   * representing money movement.
   */
  refresh(): Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const EMPTY_WALLETS: WalletSnapshot[] = [];

interface ProviderProps {
  children: ReactNode;
  /**
   * Whether a user session exists. Passed from the SSR layout (it
   * already knows from getSessionUser()) so we skip the /wallet fetch
   * entirely for anonymous visitors. An anonymous render emits zero
   * additional api requests beyond what /catalog/* already does.
   */
  signedIn: boolean;
}

export function WalletProvider({ children, signedIn }: ProviderProps) {
  const [state, setState] = useState<WalletState>({
    wallets: EMPTY_WALLETS,
    loading: signedIn,
    error: null,
  });

  // The latest setState reference for use inside long-lived callbacks
  // (WS listener) so we don't capture a stale closure.
  const setStateRef = useRef(setState);
  setStateRef.current = setState;

  const fetchWallets = useCallback(async () => {
    if (!signedIn) {
      setStateRef.current({ wallets: EMPTY_WALLETS, loading: false, error: null });
      return;
    }
    try {
      const r = await clientApi<WalletListResponse>("/wallet");
      setStateRef.current({ wallets: r.wallets, loading: false, error: null });
    } catch (e) {
      const message =
        e instanceof ApiFetchError ? e.body.message : (e as Error).message;
      setStateRef.current((prev) => ({ ...prev, loading: false, error: message }));
    }
  }, [signedIn]);

  // Fetch once on mount (and whenever signedIn flips). Login / logout
  // triggers a SSR re-render which re-mounts this provider with the
  // new signedIn value — and `getSessionUser()` upstream is the
  // source of truth for the flip, so no race here.
  useEffect(() => {
    void fetchWallets();
  }, [fetchWallets]);

  const optimisticDeduct = useCallback((currency: Currency, micro: bigint) => {
    setStateRef.current((prev) => {
      let changed = false;
      const next = prev.wallets.map((w) => {
        if (w.currency !== currency) return w;
        changed = true;
        // BigInt arithmetic — bigints arrive as decimal strings on the
        // wire (see CLAUDE.md invariant 1) and we keep them as bigint
        // values inside the wallet type after parsing.
        const remaining = BigInt(w.availableMicro) - micro;
        // Don't allow display to drop below zero. Server will reject
        // the placement with insufficient_balance long before we ever
        // see a real negative state.
        const clamped = remaining < 0n ? 0n : remaining;
        return { ...w, availableMicro: clamped.toString() };
      });
      if (!changed) return prev;
      return { ...prev, wallets: next };
    });
  }, []);

  // Subscribe to user-channel ticket frames. Any frame whose status
  // implies money movement triggers a /wallet refetch so the displayed
  // balance stays authoritative. The list is intentionally narrow —
  // pending_delay / accepted / rejected don't move money, so refetching
  // on them would be wasted bandwidth.
  useTicketStream((frame) => {
    if (!signedIn) return;
    if (
      frame.status === "settled" ||
      frame.status === "voided" ||
      frame.status === "cashed_out"
    ) {
      void fetchWallets();
    }
  });

  const value = useMemo<WalletContextValue>(
    () => ({
      ...state,
      optimisticDeduct,
      refresh: fetchWallets,
    }),
    [state, optimisticDeduct, fetchWallets],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallets(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallets() must be used inside <WalletProvider>");
  }
  return ctx;
}

/**
 * Find the wallet snapshot for a specific currency. Returns null when
 * the user has no wallet of that currency (rare — every signup creates
 * both USDC and OZ wallets atomically, see auth/service.ts).
 */
export function selectWalletByCurrency(
  wallets: WalletSnapshot[],
  currency: Currency,
): WalletSnapshot | null {
  return wallets.find((w) => w.currency === currency) ?? null;
}
