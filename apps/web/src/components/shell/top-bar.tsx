"use client";

import Link from "next/link";
import { Wordmark } from "@/components/ui/monogram";
import { I } from "@/components/ui/icons";
import { useMobileDrawers } from "./mobile-drawer-context";
import { UserControls } from "./user-controls";

interface TopBarProps {
  signedIn: boolean;
  user?: { email: string; displayName: string | null; role: string };
}

const iconBtn = {
  width: 36,
  height: 36,
  display: "inline-flex" as const,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  background: "transparent",
  border: 0,
  borderRadius: 999,
  cursor: "pointer",
  color: "var(--fg-muted)",
  position: "relative" as const,
};

export function TopBar({ signedIn, user }: TopBarProps) {
  const { toggleSidebar } = useMobileDrawers();

  return (
    <header
      className="oz-topbar"
      style={{
        gridArea: "top",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 clamp(12px, 3vw, 24px)",
        height: 60,
        borderBottom: "1px solid var(--hairline)",
        background: "color-mix(in oklab, var(--bg) 80%, transparent)",
        backdropFilter: "blur(12px)",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      {/* Hamburger — mobile only */}
      <button
        type="button"
        onClick={toggleSidebar}
        className="oz-topbar-toggle"
        style={{ ...iconBtn, display: undefined, marginLeft: -8 }}
        aria-label="Open navigation"
      >
        <I.Grid size={18} />
      </button>

      {/*
        Brand mark — visible only on mobile (below 720px) where the
        sidebar is a drawer. Tablet and desktop hide this and show the
        full-size `.oz-side-logo` at the top of the sidebar instead;
        see the @media rule in globals.css.
      */}
      <Link
        href="/"
        className="oz-topbar-wordmark"
        style={{
          textDecoration: "none",
          display: "inline-flex",
          color: "var(--fg)",
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <Wordmark size={36} priority />
      </Link>

      <div style={{ flex: 1 }} />

      {/*
        Theme + bell + wallet + avatar (or login / signup). On desktop
        (≥1100px) the entire top bar is hidden via `.oz-topbar` and a
        twin <UserControls variant="rail" /> in the bet-slip rail
        carries the same cluster — see globals.css.
      */}
      <UserControls signedIn={signedIn} user={user} variant="topbar" />
    </header>
  );
}
