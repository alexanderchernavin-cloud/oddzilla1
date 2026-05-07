"use client";

import Link from "next/link";
import type { WalletSnapshot } from "@oddzilla/types";
import { Wordmark } from "@/components/ui/monogram";
import { I } from "@/components/ui/icons";
import { Button } from "@/components/ui/primitives";
import { ThemeToggle } from "./theme-toggle";
import { useMobileDrawers } from "./mobile-drawer-context";
import { TopBarSearch } from "./top-bar-search";
import { WalletPill } from "./wallet-pill";
import { UserMenu } from "./user-menu";

interface TopBarProps {
  signedIn: boolean;
  user?: { email: string; displayName: string | null; role: string };
  wallets?: WalletSnapshot[];
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

export function TopBar({ signedIn, user, wallets }: TopBarProps) {
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

      <Link
        href="/"
        style={{
          textDecoration: "none",
          display: "inline-flex",
          color: "var(--fg)",
          flexShrink: 0,
        }}
      >
        <Wordmark size={36} priority />
      </Link>

      {/* Search — hidden under ~900px via .oz-topbar-search CSS */}
      <TopBarSearch />

      <div style={{ flex: 1 }} />

      <ThemeToggle />

      {signedIn && user ? (
        <>
          <button
            type="button"
            style={iconBtn}
            title="Alerts"
            aria-label="Notifications"
            className="oz-topbar-bell"
          >
            <I.Bell size={16} />
            <span
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                width: 6,
                height: 6,
                borderRadius: 999,
                background: "var(--live)",
              }}
            />
          </button>

          <WalletPill wallets={wallets} />

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
