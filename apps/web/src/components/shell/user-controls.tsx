"use client";

import Link from "next/link";
import { Button } from "@/components/ui/primitives";
import { ThemeToggle } from "./theme-toggle";
import { NotificationBell } from "./notification-bell";
import { WalletPill } from "./wallet-pill";
import { UserMenu } from "./user-menu";

// The cluster of top-right controls — theme toggle, notification bell,
// wallet pill, user menu (or login / signup pair when signed out).
//
// Rendered in two places depending on viewport (see CSS rules keyed on
// `oz-topbar-controls` / `oz-rail-controls` in globals.css):
//   - `variant="topbar"`: mounted in the top bar, visible on mobile +
//     tablet where the right rail is a bottom-sheet and the controls
//     would otherwise have nowhere to live.
//   - `variant="rail"`: mounted at the top of the docked bet-slip rail,
//     visible only on desktop (≥1100px) where the rail is a persistent
//     aside and the top bar is hidden entirely.
//
// Two trees are mounted simultaneously; CSS @media gates which one
// participates in layout. NotificationBell + UserMenu each carry their
// own open-state, so the hidden copy stays silent — there's no global
// orchestration to keep in sync.
interface UserControlsProps {
  signedIn: boolean;
  user?: {
    email: string;
    displayName: string | null;
    nickname: string | null;
    role: string;
  };
  variant: "topbar" | "rail";
}

export function UserControls({ signedIn, user, variant }: UserControlsProps) {
  const isTopbar = variant === "topbar";
  return (
    <div
      className={isTopbar ? "oz-topbar-controls" : "oz-rail-controls"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        // The rail variant slots into the rail header above the tab
        // strip; align-right so the cluster hugs the rail's outer edge
        // and the tabs below get the full width.
        justifyContent: isTopbar ? "flex-start" : "flex-end",
        minWidth: 0,
      }}
    >
      {/*
        Theme toggle hides on mobile in the top-bar context (see
        .oz-topbar-theme @media rule) so the hamburger + wordmark +
        wallet pill + avatar row doesn't overflow a 360-414px phone.
        The mobile sidebar drawer re-mounts a copy. In the rail context
        we always show the toggle — the rail is desktop-only anyway.
      */}
      <span className={isTopbar ? "oz-topbar-theme" : undefined}>
        <ThemeToggle />
      </span>

      {signedIn && user ? (
        <>
          <NotificationBell className={isTopbar ? "oz-topbar-bell" : undefined} />
          <WalletPill />
          <UserMenu user={user} isAdmin={user.role === "admin"} />
        </>
      ) : (
        <>
          <Link href="/login" style={{ textDecoration: "none" }}>
            <Button variant="ghost">Log in</Button>
          </Link>
          <Link
            href="/signup"
            style={{ textDecoration: "none" }}
            className={isTopbar ? "oz-topbar-signup" : undefined}
          >
            <Button variant="primary">Sign up</Button>
          </Link>
        </>
      )}
    </div>
  );
}
