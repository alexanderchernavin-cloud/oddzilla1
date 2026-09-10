"use client";

// useSlotzilla — the storefront's view of one SlotZilla game.
//
// Three inputs, one state:
//   - GET /slotzilla/matches/:id on mount and every 15 s (the
//     authoritative snapshot: clock, windows, paytable, limits, the
//     bettor's open + recent spins, and whether a spin may be placed);
//   - `slotzilla_state` frames on the shared socket (the clock and the
//     shared 5-second windows, published by the service as they move);
//   - `slotzilla_spin` frames (the bettor's own spin placed / filled /
//     settled / voided).
//
// The clock is an ANCHOR, not a reading: `clock.seconds` was true at
// `clock.atMs` (server time), and while `running` the hook derives the
// current second against the tab's server-clock estimate on a
// one-second ticker — the same convention the running match clocks on
// the list rows follow (running-clock.ts).
//
// The rules that decide whether a spin may be placed are re-derived
// locally from every frame in the SAME order the api applies them, so a
// clock that stops between two fetches locks the button within a
// frame rather than within 15 s. The two blocks only the server can
// know — `disabled` and `sign_in` — are kept as the server said them.

import { useCallback, useEffect, useRef, useState } from "react";
import { roundEnd } from "@oddzilla/types/slotzilla";
import type {
  SlotzillaGameState,
  SlotzillaSpinBlock,
  SlotzillaSpinRequest,
  SlotzillaSpinView,
  WsSlotzillaSpin,
  WsSlotzillaState,
} from "@oddzilla/types/slotzilla";
import { isCurrency } from "@oddzilla/types/currencies";
import { ApiFetchError, clientApi } from "./api-client";
import { serverClock } from "./running-clock";
import { useSlotzillaStream } from "./use-live-odds";
import { useSessionUserId } from "./session-user";
import { useWallets } from "./wallets";

const POLL_MS = 15_000;
// A settled spin is left on screen this long before auto-play places
// the next one — long enough to read the result, short enough that the
// next round's first window is still ahead of the clock.
const AUTOPLAY_GAP_MS = 1_500;
// If the settle frame never arrives (socket blip, gateway restart), the
// snapshot is re-read this long after the spin's last window should
// have closed. The service's own grace is a few seconds; 12 covers it.
const SETTLE_FALLBACK_SECONDS = 12;

export interface UseSlotzilla {
  state: SlotzillaGameState | null;
  /** First fetch resolved (successfully or not). */
  loaded: boolean;
  /** The api answered 404: no game for this match. The panel hides. */
  missing: boolean;
  /** Derived match-clock second (advances locally while running), or null before tip-off. */
  clockSeconds: number | null;
  spin(stakeMicro: bigint, currency: string): Promise<boolean>;
  spinning: boolean;
  /** Last placement error code (api `body.error`, or `sign_in` / `open_spin` / `network`). */
  error: string | null;
  clearError(): void;
  /** The most recent spin of THIS session — open while running, then its settled form. */
  lastSpin: SlotzillaSpinView | null;
  autoplay: boolean;
  startAutoplay(stakeMicro: bigint, currency: string): void;
  stopAutoplay(): void;
  /** Stakes placed from this tab, by currency (micro). */
  sessionSpend: Readonly<Record<string, bigint>>;
  refresh(): Promise<void>;
}

/** Re-apply the api's block ordering to a locally merged state. */
function withDerivedBlock(s: SlotzillaGameState): SlotzillaGameState {
  if (s.spinBlock === "disabled" || s.spinBlock === "sign_in") {
    return s.canSpin ? { ...s, canSpin: false } : s;
  }
  let block: SlotzillaSpinBlock | null = null;
  if (s.status === "paused") block = "game_paused";
  else if (s.status !== "live") block = "game_not_live";
  else if (!s.clock.running) block = "clock_stopped";
  else if (s.openSpin) block = "open_spin";
  if (block === s.spinBlock && s.canSpin === (block === null)) return s;
  return { ...s, spinBlock: block, canSpin: block === null };
}

function applyStateFrame(prev: SlotzillaGameState, frame: WsSlotzillaState): SlotzillaGameState {
  // A frame older than the anchor we hold is a reorder; keep ours.
  if (frame.clock.atMs < prev.clock.atMs) return prev;
  return withDerivedBlock({
    ...prev,
    status: frame.status,
    clock: frame.clock,
    windows: frame.windows,
  });
}

function applySpin(prev: SlotzillaGameState, spin: SlotzillaSpinView): SlotzillaGameState {
  const open = spin.status === "open";
  const openSpin = open ? spin : prev.openSpin?.id === spin.id ? null : prev.openSpin;
  const recentSpins = open
    ? prev.recentSpins
    : [spin, ...prev.recentSpins.filter((s) => s.id !== spin.id)].slice(0, 10);
  return withDerivedBlock({ ...prev, openSpin, recentSpins });
}

/** The clock's reading now, from its anchor. */
export function deriveClockSeconds(
  clock: SlotzillaGameState["clock"] | null | undefined,
  nowMs: number,
): number | null {
  if (!clock || clock.seconds == null) return null;
  if (!clock.running || !Number.isFinite(clock.atMs)) return clock.seconds;
  const elapsed = Math.floor((nowMs - clock.atMs) / 1000);
  return clock.seconds + Math.max(0, elapsed);
}

export function useSlotzilla(matchId: string): UseSlotzilla {
  const [state, setState] = useState<SlotzillaGameState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [clockSeconds, setClockSeconds] = useState<number | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSpin, setLastSpin] = useState<SlotzillaSpinView | null>(null);
  const [autoplay, setAutoplay] = useState(false);
  const [sessionSpend, setSessionSpend] = useState<Record<string, bigint>>({});
  const wallets = useWallets();
  // The session as SSR resolved it. Compared against what the api says
  // per poll, so an access cookie that expired while the bettor sat on
  // this page is recovered rather than shown as "sign in".
  const sessionUserId = useSessionUserId();

  const spinningRef = useRef(false);
  const autoplayRef = useRef<{ on: boolean; stakeMicro: bigint; currency: string }>({
    on: false,
    stakeMicro: 0n,
    currency: "",
  });
  // Spin ids whose settle fallback has already fired, so a slow settle
  // costs one extra fetch rather than one per second.
  const fallbackFiredRef = useRef<string | null>(null);
  // One session-recovery attempt per expiry; see fetchState.
  const refreshTriedRef = useRef(false);

  const fetchState = useCallback(async () => {
    try {
      let fresh = await clientApi<SlotzillaGameState>(`/slotzilla/matches/${matchId}`);

      // The access cookie lives 15 minutes and ONLY a page navigation
      // refreshes it (the Next.js middleware is the sole caller of
      // /auth/refresh). This section is a page a bettor sits on —
      // watching a match and spinning IS the activity — so it routinely
      // passes that mark without navigating. Every poll after it then
      // comes back anonymous and the panel says "Sign in to spin" to
      // someone whose balance is on screen in the top bar, which was
      // server-rendered while the cookie was still good. Reported from
      // production 2026-09-10.
      //
      // So when the server says anonymous but the SSR-resolved session
      // says otherwise, rotate the cookie and re-read once. Bounded by
      // a ref: an expired REFRESH cookie must not turn the poll loop
      // into a refresh loop, and the same bound is why ws-session-sync
      // caps its reconnects.
      if (fresh.spinBlock === "sign_in" && sessionUserId !== null && !refreshTriedRef.current) {
        refreshTriedRef.current = true;
        try {
          await clientApi("/auth/refresh", { method: "POST" });
          fresh = await clientApi<SlotzillaGameState>(`/slotzilla/matches/${matchId}`);
        } catch {
          // Refresh cookie is gone too: the bettor really is signed out.
          // Keep the sign-in block, which is now the truth.
        }
      } else if (fresh.spinBlock !== "sign_in") {
        // A good read re-arms the recovery for the next expiry.
        refreshTriedRef.current = false;
      }

      setMissing(false);
      setState((prev) => {
        // Keep a newer clock we already hold from a frame; the snapshot's
        // anchor can be older than the last frame by up to a poll.
        if (prev && prev.clock.atMs > fresh.clock.atMs) {
          return withDerivedBlock({ ...fresh, clock: prev.clock, windows: prev.windows });
        }
        return withDerivedBlock(fresh);
      });
    } catch (e) {
      if (e instanceof ApiFetchError && e.status === 404) {
        setMissing(true);
        setState(null);
      }
      // Any other failure keeps the last snapshot; the next poll retries.
    } finally {
      setLoaded(true);
    }
  }, [matchId, sessionUserId]);

  // Snapshot on mount + poll.
  useEffect(() => {
    let cancelled = false;
    setState(null);
    setLoaded(false);
    setMissing(false);
    setLastSpin(null);
    void fetchState();
    const timer = setInterval(() => {
      if (!cancelled) void fetchState();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fetchState]);

  // Live frames.
  const walletsRefresh = wallets.refresh;
  useSlotzillaStream(
    missing ? null : matchId,
    (frame) => {
      setState((prev) => (prev ? applyStateFrame(prev, frame) : prev));
    },
    (frame: WsSlotzillaSpin) => {
      const spin = frame.spin;
      if (spin.matchId !== matchId) return;
      setState((prev) => (prev ? applySpin(prev, spin) : prev));
      setLastSpin((prev) => (prev && prev.id !== spin.id && spin.status !== "open" ? prev : spin));
      // Money moved (payout credited, stake released or refunded): the
      // top-bar balance should follow without a navigation.
      if (spin.status !== "open") void walletsRefresh();
    },
  );

  // One-second ticker while the clock runs; a stopped clock is a constant.
  const clock = state?.clock ?? null;
  const running = Boolean(clock && clock.running && clock.seconds != null);
  useEffect(() => {
    setClockSeconds(deriveClockSeconds(clock, serverClock.now()));
    if (!running) return;
    const timer = setInterval(() => {
      setClockSeconds(deriveClockSeconds(clock, serverClock.now()));
    }, 1000);
    return () => clearInterval(timer);
  }, [clock, running]);

  // Settle fallback: an open spin whose last window closed a while ago
  // and no frame said so — re-read the snapshot once.
  const openSpin = state?.openSpin ?? null;
  useEffect(() => {
    if (!openSpin || clockSeconds == null) return;
    if (fallbackFiredRef.current === openSpin.id) return;
    if (clockSeconds >= roundEnd(openSpin.windowFrom) + SETTLE_FALLBACK_SECONDS) {
      fallbackFiredRef.current = openSpin.id;
      void fetchState();
    }
  }, [openSpin, clockSeconds, fetchState]);

  const stopAutoplay = useCallback(() => {
    autoplayRef.current = { ...autoplayRef.current, on: false };
    setAutoplay(false);
  }, []);

  const spin = useCallback(
    async (stakeMicro: bigint, currency: string): Promise<boolean> => {
      if (spinningRef.current) return false;
      spinningRef.current = true;
      setSpinning(true);
      setError(null);
      try {
        const body: SlotzillaSpinRequest = {
          currency,
          stakeMicro: stakeMicro.toString(),
          idempotencyKey: crypto.randomUUID(),
          autoplay: autoplayRef.current.on,
        };
        const view = await clientApi<SlotzillaSpinView>(`/slotzilla/matches/${matchId}/spins`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        setState((prev) => (prev ? applySpin(prev, view) : prev));
        setLastSpin(view);
        setSessionSpend((prev) => ({
          ...prev,
          [currency]: (prev[currency] ?? 0n) + stakeMicro,
        }));
        if (isCurrency(currency)) wallets.optimisticDeduct(currency, stakeMicro);
        return true;
      } catch (e) {
        let code = "network";
        if (e instanceof ApiFetchError) {
          if (e.status === 401) code = "sign_in";
          else if (e.status === 409) code = "open_spin";
          else code = e.body.error || "error";
        }
        setError(code);
        stopAutoplay();
        // The server's view of the block is more current than ours
        // whenever it refuses; re-read it so the panel shows the reason.
        if (code !== "network") void fetchState();
        return false;
      } finally {
        spinningRef.current = false;
        setSpinning(false);
      }
    },
    [matchId, fetchState, stopAutoplay, wallets],
  );

  const startAutoplay = useCallback((stakeMicro: bigint, currency: string) => {
    autoplayRef.current = { on: true, stakeMicro, currency };
    setAutoplay(true);
  }, []);

  // Auto-play loop: whenever the board is clear and a spin may be
  // placed, place the next one after a short pause. Anything that
  // blocks — a stopped clock, a pause, an error — leaves the toggle on
  // (a stopped clock is normal between plays) except an error, which
  // `spin` clears it on.
  const canSpin = Boolean(state?.canSpin);
  const autoplayAllowed = Boolean(state?.limits.autoplayEnabled);
  useEffect(() => {
    if (!autoplay) return;
    if (!autoplayAllowed) {
      stopAutoplay();
      return;
    }
    if (!canSpin || openSpin || spinning) return;
    const timer = setTimeout(() => {
      const a = autoplayRef.current;
      if (!a.on) return;
      void spin(a.stakeMicro, a.currency);
    }, AUTOPLAY_GAP_MS);
    return () => clearTimeout(timer);
  }, [autoplay, autoplayAllowed, canSpin, openSpin, spinning, spin, stopAutoplay]);

  const clearError = useCallback(() => setError(null), []);

  return {
    state,
    loaded,
    missing,
    clockSeconds,
    spin,
    spinning,
    error,
    clearError,
    lastSpin,
    autoplay,
    startAutoplay,
    stopAutoplay,
    sessionSpend,
    refresh: fetchState,
  };
}
