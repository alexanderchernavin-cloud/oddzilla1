"use client";

// Cross-component state for the mobile slide-in drawers (sidebar + bet
// slip). Desktop breakpoints never mount a toggle, so both bools stay
// false there and the context adds no cost.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

interface DrawerState {
  sidebarOpen: boolean;
  railOpen: boolean;
  toggleSidebar: () => void;
  toggleRail: () => void;
  closeAll: () => void;
}

const DrawerCtx = createContext<DrawerState | null>(null);

export function MobileDrawersProvider({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebar] = useState(false);
  const [railOpen, setRail] = useState(false);
  const pathname = usePathname();

  // Auto-close on navigation — clicking a sidebar link on mobile
  // should dismiss the drawer after the route transition.
  useEffect(() => {
    setSidebar(false);
    setRail(false);
  }, [pathname]);

  // Lock body scroll when a drawer is open so touch gestures don't
  // bleed into the page underneath.
  useEffect(() => {
    const open = sidebarOpen || railOpen;
    const prev = document.body.style.overflow;
    if (open) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sidebarOpen, railOpen]);

  const toggleSidebar = useCallback(() => {
    setSidebar((v) => !v);
    setRail(false);
  }, []);
  const toggleRail = useCallback(() => {
    setRail((v) => !v);
    setSidebar(false);
  }, []);
  const closeAll = useCallback(() => {
    setSidebar(false);
    setRail(false);
  }, []);

  const value = useMemo(
    () => ({ sidebarOpen, railOpen, toggleSidebar, toggleRail, closeAll }),
    [sidebarOpen, railOpen, toggleSidebar, toggleRail, closeAll],
  );

  return <DrawerCtx.Provider value={value}>{children}</DrawerCtx.Provider>;
}

export function useMobileDrawers(): DrawerState {
  const ctx = useContext(DrawerCtx);
  if (!ctx) {
    // Allow hook use outside the provider (SSR fallback etc.) — return
    // no-op state so nothing renders open.
    return {
      sidebarOpen: false,
      railOpen: false,
      toggleSidebar: () => {},
      toggleRail: () => {},
      closeAll: () => {},
    };
  }
  return ctx;
}
