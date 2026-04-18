"use client";

import Link from "next/link";
import { Wordmark } from "@/components/ui/monogram";
import { I } from "@/components/ui/icons";
import { Button, Divider } from "@/components/ui/primitives";
import { ThemeToggle } from "./theme-toggle";

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
        gap: 16,
        padding: "0 24px",
        height: 60,
        borderBottom: "1px solid var(--hairline)",
        background: "color-mix(in oklab, var(--bg) 80%, transparent)",
        backdropFilter: "blur(12px)",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      <Link
        href="/"
        style={{ textDecoration: "none", display: "inline-flex", color: "var(--fg)" }}
      >
        <Wordmark size={15} />
      </Link>

      <div style={{ flex: 1, maxWidth: 460, marginLeft: 24 }}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            height: 36,
            padding: "0 14px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 999,
            color: "var(--fg-muted)",
          }}
        >
          <I.Search size={15} />
          <input
            placeholder="Search teams, tournaments, markets…"
            style={{
              flex: 1,
              border: 0,
              background: "transparent",
              outline: "none",
              fontFamily: "inherit",
              fontSize: 13,
              color: "var(--fg)",
            }}
          />
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              padding: "2px 6px",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--fg-dim)",
            }}
          >
            ⌘K
          </span>
        </label>
      </div>

      <div style={{ flex: 1 }} />

      <ThemeToggle />

      {signedIn && user ? (
        <>
          <button type="button" style={iconBtn} title="Alerts" aria-label="Notifications">
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
            }}
          >
            <I.Wallet size={14} style={{ color: "var(--fg-muted)" }} />
            <span className="mono tnum" style={{ fontSize: 13, fontWeight: 600 }}>
              {balanceUsd ?? "0.00"}
            </span>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
              USDT
            </span>
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
          </Link>

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
          <Link href="/signup" style={{ textDecoration: "none" }}>
            <Button variant="primary">Sign up</Button>
          </Link>
        </>
      )}
    </header>
  );
}
