"use client";

// Top-bar avatar with a built-in user menu.
//
// Click the avatar → popover with "My bets", "Wallet", "Settings",
// "Log out". The previous behaviour was a hard link to /account
// which buried logout one extra navigation away.

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { I } from "@/components/ui/icons";
import { clientApi } from "@/lib/api-client";
import { useTranslations } from "@/lib/i18n";
import { LanguageSwitcher } from "./language-switcher";

const AVATAR_SIZE = 36;

const avatarStyle: CSSProperties = {
  width: AVATAR_SIZE,
  height: AVATAR_SIZE,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  color: "var(--fg)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
  padding: 0,
};

export function UserMenu({
  user,
  isAdmin,
}: {
  user: { email: string; displayName: string | null };
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const tShell = useTranslations("shell");
  const tCommon = useTranslations("common");

  const initials = (user.displayName || user.email)
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function logOut() {
    setLoggingOut(true);
    try {
      await clientApi("/auth/logout", { method: "POST" });
    } catch {
      // Cookies are httpOnly so JS can't clear them; the next request
      // is unauthed regardless and the middleware will redirect.
    }
    router.push("/login");
    router.refresh();
  }

  return (
    <div ref={wrapperRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={tShell("accountMenu", { name: user.displayName ?? user.email })}
        title={user.displayName ?? user.email}
        style={avatarStyle}
      >
        {initials}
      </button>

      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: AVATAR_SIZE + 6,
            right: 0,
            minWidth: 220,
            padding: 6,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
            zIndex: 60,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div
            style={{
              padding: "8px 10px",
              borderBottom: "1px solid var(--hairline)",
              marginBottom: 4,
              minWidth: 0,
            }}
          >
            {user.displayName ? (
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--fg)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {user.displayName}
              </div>
            ) : null}
            <div
              style={{
                fontSize: 11,
                color: "var(--fg-muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {user.email}
            </div>
          </div>

          <MenuItem href="/bets" icon={<I.Ticket size={14} />} onClick={() => setOpen(false)}>
            {tShell("myBets")}
          </MenuItem>
          <MenuItem href="/wallet" icon={<I.Wallet size={14} />} onClick={() => setOpen(false)}>
            {tShell("wallet")}
          </MenuItem>
          <MenuItem href="/account" icon={<I.Gear size={14} />} onClick={() => setOpen(false)}>
            {tShell("settings")}
          </MenuItem>
          {isAdmin ? (
            <MenuItem href="/admin" icon={<I.Trophy size={14} />} onClick={() => setOpen(false)}>
              {tShell("admin")}
            </MenuItem>
          ) : null}

          <div
            style={{
              marginTop: 4,
              paddingTop: 4,
              borderTop: "1px solid var(--hairline)",
            }}
          >
            <LanguageSwitcher variant="menu" />
          </div>

          <div
            style={{
              marginTop: 4,
              paddingTop: 4,
              borderTop: "1px solid var(--hairline)",
            }}
          >
            <button
              type="button"
              onClick={logOut}
              disabled={loggingOut}
              role="menuitem"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "8px 10px",
                background: "transparent",
                border: 0,
                borderRadius: 8,
                textAlign: "left",
                font: "inherit",
                fontSize: 13,
                color: "var(--fg-muted)",
                cursor: "pointer",
                opacity: loggingOut ? 0.6 : 1,
              }}
            >
              <I.Arrow size={14} />
              <span>{loggingOut ? tCommon("loggingOut") : tCommon("logout")}</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  href,
  icon,
  onClick,
  children,
}: {
  href: string;
  icon: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      role="menuitem"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: 8,
        textDecoration: "none",
        color: "var(--fg)",
        fontSize: 13,
      }}
    >
      <span style={{ color: "var(--fg-muted)" }}>{icon}</span>
      <span>{children}</span>
    </Link>
  );
}
