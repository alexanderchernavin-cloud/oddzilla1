"use client";

import { useState } from "react";
import Link from "next/link";
import { Wordmark } from "@/components/ui/monogram";
import { I } from "@/components/ui/icons";
import { Button } from "@/components/ui/primitives";
import { ThemeToggle } from "./theme-toggle";
import { useMobileDrawers } from "./mobile-drawer-context";
import { WalletPill } from "./wallet-pill";
import { UserMenu } from "./user-menu";
import { NotificationPanel } from "./notification-panel";
import { useNotifications } from "@/lib/notifications";

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

// Static styles for the notification bell badge — these don't depend
// on any per-render values, so hoisting to module scope avoids a
// fresh object identity on every poll-driven re-render of the bell.
const BELL_WRAPPER_STYLE = { position: "relative" as const };
const BELL_BADGE_STYLE = {
  // Pill that sits on the bell. Width grows with the count; >99
  // collapses to "99+" via the label.
  position: "absolute" as const,
  top: 4,
  right: 2,
  minWidth: 16,
  height: 16,
  padding: "0 4px",
  borderRadius: 999,
  background: "var(--negative, #EF4444)",
  color: "#fff",
  fontSize: 10,
  fontWeight: 700,
  display: "inline-flex" as const,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  lineHeight: 1,
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

      {/* Theme toggle hides under 720px (.oz-topbar-theme rule in
          globals.css) — at that breakpoint a logged-in user already has
          the hamburger + wordmark + wallet pill + avatar competing for
          the row, and the toggle is duplicated as a row in the sidebar
          drawer below. Logged-out users get a smaller log-in pill so the
          desktop version stays visible to them at every size. */}
      <span className="oz-topbar-theme">
        <ThemeToggle />
      </span>

      {signedIn && user ? (
        <>
          <NotificationBell />

          {/* WalletPill reads its data from the WalletProvider context
              (mounted in (main)/layout.tsx). Shows a skeleton until the
              client-side /wallet fetch resolves on hydration. */}
          <WalletPill />

          <UserMenu user={user} isAdmin={user.role === "admin"} />
          {/* `initials` formerly rendered as a static <Link> — UserMenu
              owns the popover with Log out + Settings now. */}
        </>
      ) : (
        <>
          <Link href="/login" style={{ textDecoration: "none" }}>
            <Button variant="ghost">Log in</Button>
          </Link>
          <Link href="/signup" style={{ textDecoration: "none" }} className="oz-topbar-signup">
            <Button variant="primary">Sign up</Button>
          </Link>
        </>
      )}
    </header>
  );
}

// Bell + popover. Self-contained so the parent doesn't have to manage
// open-state. Lives next to top-bar layout because anchor positioning
// requires a positioned wrapper around both the button and the panel.
function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { unreadCount } = useNotifications();
  return (
    <div style={BELL_WRAPPER_STYLE}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        aria-expanded={open}
        title={unreadCount > 0 ? `${unreadCount} unread` : "Notifications"}
        className="oz-topbar-bell"
        style={iconBtn}
      >
        <I.Bell size={16} />
        {unreadCount > 0 ? (
          <span style={BELL_BADGE_STYLE}>
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>
      <NotificationPanel open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
