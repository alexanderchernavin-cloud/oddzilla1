"use client";

// SidePanelContext — holds which match (if any) is mounted in the left
// and right empty bands flanking the centered shell on ultra-wide
// viewports. Each side renders an iframe of the shell-less embed route
// (`/embed/match/[id]`) so a bettor can keep two or three matches open
// at once on 4K / wide-aspect displays.
//
// Mounted in `(main)/layout.tsx` so every page under the storefront
// shell can open / close panels. The visibility threshold itself
// (when the buttons + panels appear at all) is enforced in CSS via
// `@media (min-width: 2200px)`; this file only tracks state.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type PanelSide = "left" | "right";

interface SidePanelState {
  left: string | null;
  right: string | null;
}

interface SidePanelContextValue extends SidePanelState {
  open(side: PanelSide, matchId: string): void;
  close(side: PanelSide): void;
  toggle(side: PanelSide, matchId: string): void;
  isOpen(side: PanelSide, matchId: string): boolean;
}

const SidePanelContext = createContext<SidePanelContextValue | null>(null);

const STORAGE_KEY = "oz:side-panels.v1";

function emptyState(): SidePanelState {
  return { left: null, right: null };
}

function loadFromStorage(): SidePanelState {
  if (typeof window === "undefined") return emptyState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<SidePanelState>;
    return {
      left: typeof parsed.left === "string" ? parsed.left : null,
      right: typeof parsed.right === "string" ? parsed.right : null,
    };
  } catch {
    return emptyState();
  }
}

export function SidePanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SidePanelState>(() => emptyState());

  // Hydrate after mount so SSR + client trees agree on the empty state.
  useEffect(() => {
    setState(loadFromStorage());
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // localStorage disabled — state just won't survive a reload.
    }
  }, [state]);

  const open = useCallback((side: PanelSide, matchId: string) => {
    setState((prev) => ({ ...prev, [side]: matchId }));
  }, []);

  const close = useCallback((side: PanelSide) => {
    setState((prev) => ({ ...prev, [side]: null }));
  }, []);

  const toggle = useCallback((side: PanelSide, matchId: string) => {
    setState((prev) => ({
      ...prev,
      [side]: prev[side] === matchId ? null : matchId,
    }));
  }, []);

  const isOpen = useCallback(
    (side: PanelSide, matchId: string) => state[side] === matchId,
    [state],
  );

  const value = useMemo<SidePanelContextValue>(
    () => ({ ...state, open, close, toggle, isOpen }),
    [state, open, close, toggle, isOpen],
  );

  return (
    <SidePanelContext.Provider value={value}>
      {children}
    </SidePanelContext.Provider>
  );
}

export function useSidePanels(): SidePanelContextValue {
  const ctx = useContext(SidePanelContext);
  if (!ctx) {
    // Provider may legitimately be absent on routes outside the (main)
    // shell (auth pages, admin). Return a no-op so consumers can still
    // mount without crashing — they just won't be able to open panels.
    return {
      left: null,
      right: null,
      open: () => {},
      close: () => {},
      toggle: () => {},
      isOpen: () => false,
    };
  }
  return ctx;
}
