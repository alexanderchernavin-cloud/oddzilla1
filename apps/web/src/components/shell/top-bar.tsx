"use client";

import Link from "next/link";
import { Wordmark } from "@/components/ui/monogram";
import { I } from "@/components/ui/icons";
import { Button, Divider } from "@/components/ui/primitives";
import { ThemeToggle } from "./theme-toggle";
import { useMobileDrawers } from "./mobile-drawer-context";
import { TopBarSearch } from "./top-bar-search";
import { useBetSlip } from "@/lib/bet-slip";

interface TopBarProps {
  signedIn: boolean;
  user?: { email: string; displayName: string | null; role: string };
  balanceUsd?: string;
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

export function TopBar({ signedIn, user, balanceUsd }: TopBarProps) {
  const { toggleSidebar, toggleRail } = useMobileDrawers();
  const slip = useBetSlip();
  const slipCount = slip.selections.length;

  const initials = user
    ? (user.displayName || user.email)
        .split(/\s+/)
        .map((w) => w[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : "";

  return (
    <header
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
        <Wordmark size={15} />
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

          <Link
            href="/wallet"
            className="oz-topbar-wallet"
            style={{
              textDecoration: "none",
              color: "var(--fg)",
              display: "flex",
              alignItems: "center",
              gap: 10,
              height: 36,
              padding: "0 14px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 999,
              flexShrink: 0,
            }}
          >
            <I.Wallet size={14} style={{ color: "var(--fg-muted)" }} />
            <span className="mono tnum" style={{ fontSize: 13, fontWeight: 600 }}>
              {balanceUsd ?? "0.00"}
            </span>
            <span
              className="mono oz-topbar-wallet-unit"
              style={{ fontSize: 11, color: "var(--fg-muted)" }}
            >
              USDT
            </span>
            <span className="oz-topbar-wallet-deposit" style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <Divider v style={{ height: 18, margin: "0 2px" }} />
              <span
                style={{
                  padding: "2px 8px",
                  fontSize: 11,
                  fontWeight: 600,
                  background: "var(--accent)",
                  color: "var(--accent-fg)",
                  borderRadius: 999,
                }}
              >
                + Deposit
              </span>
            </span>
          </Link>

          {/* Bet-slip trigger — mobile only; opens the rail as a
              bottom-up drawer. Shows leg count and pulses when
              non-empty so operators notice picks they've stacked. */}
          <button
            type="button"
            onClick={toggleRail}
            className="oz-mobile-slip-fab"
            aria-label="Open bet slip"
            style={{
              ...iconBtn,
              display: undefined,
              background: slipCount > 0 ? "var(--fg)" : "var(--surface-2)",
              color: slipCount > 0 ? "var(--bg)" : "var(--fg-muted)",
              border: "1px solid var(--border)",
              minWidth: 44,
              padding: "0 10px",
              gap: 6,
            }}
          >
            <I.Ticket size={14} />
            {slipCount > 0 && (
              <span
                className="mono tnum"
                style={{ fontSize: 12, fontWeight: 600 }}
              >
                {slipCount}
              </span>
            )}
          </button>

          <Link
            href="/account"
            title={user.displayName ?? user.email}
            style={{
              textDecoration: "none",
              ...iconBtn,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--fg)",
              flexShrink: 0,
            }}
          >
            {initials}
          </Link>
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
