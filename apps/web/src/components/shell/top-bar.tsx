"use client";

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
      {/*
        Hamburger — mobile only. Bumped to a 44px hit target (Apple's
        recommended minimum, slightly above Material's 40dp) with an
        18→22px icon so the visual weight matches. The wordmark used to
        live to the right of this button; it moved into the lobby
        header's left column on mobile (see `oz-lobby-mobile-logo` in
        globals.css) and the sidebar drawer header on tablet/desktop.
      */}
      <button
        type="button"
        onClick={toggleSidebar}
        className="oz-topbar-toggle"
        style={{ ...iconBtn, width: 44, height: 44, display: undefined, marginLeft: -10 }}
        aria-label="Open navigation"
      >
        <I.Grid size={22} />
      </button>

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
