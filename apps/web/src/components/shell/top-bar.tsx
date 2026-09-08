"use client";

import Link from "next/link";
import { I } from "@/components/ui/icons";
import { Wordmark } from "@/components/ui/monogram";
import { useTranslations } from "@/lib/i18n";
import { useMobileDrawers } from "./mobile-drawer-context";
import { UserControls } from "./user-controls";
import { TopBarSearch } from "./top-bar-search";
import { ZillapassIndicator } from "./zillapass-indicator";
import { TodayLabel } from "@/components/lobby/today-label";

interface TopBarProps {
  signedIn: boolean;
  user?: {
    email: string;
    displayName: string | null;
    nickname: string | null;
    role: string;
  };
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
  const tShell = useTranslations("shell");
  const tCommon = useTranslations("common");

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
        Hamburger — mobile only. 44px square: the standard comfortable
        touch target, and the height driver for the whole mobile row.
        It was 66px until 2026-09-07, which — with the 60px wordmark
        beside it — is why the mobile bar needed 90px of height and
        ate a seventh of a phone screen before any content (operator).
        Both came down together; the bar is 54px now, and 44 keeps the
        target well clear of WCAG 2.5.8's 24px floor. The wordmark sits
        to the right of this button on mobile via `.oz-topbar-logo`
        (hidden on tablet, where the docked sidebar carries the brand
        mark).
      */}
      <button
        type="button"
        onClick={toggleSidebar}
        className="oz-topbar-toggle"
        style={{ ...iconBtn, width: 44, height: 44, display: undefined, marginLeft: -6 }}
        aria-label={tCommon("openNavigation")}
      >
        <I.Grid size={22} />
      </button>

      <Link
        href="/"
        className="oz-topbar-logo"
        aria-label={tShell("homeLink")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          textDecoration: "none",
          flexShrink: 0,
        }}
      >
        {/* 36px tall (was 60): the mascot still reads at this size and
            it no longer sets the row height. `size` is the HEIGHT — the
            width follows WORDMARK_ASPECT — so this is the number that
            decides how much vertical room the brand takes on a phone. */}
        <Wordmark size={36} priority />
      </Link>

      {/*
        Date kicker + global search + ZillaPass chip. Lives in the
        top bar on tablet + desktop so the whole row is fixed at the
        top alongside the user-controls cluster. Hidden on mobile via
        `.oz-topbar-shellrow-wide { display: none }` — at <720px the
        same components mount in `.oz-shell-search` below the top
        bar, where the existing mobile responsive rules already lay
        them out correctly. */}
      <div className="oz-topbar-shellrow-wide">
        <TodayLabel />
        <div style={{ flex: 1, minWidth: 0 }}>
          <TopBarSearch />
        </div>
        <ZillapassIndicator />
      </div>

      {/* Mobile-only flex spacer — pushes the cluster to the right
          edge when the shell row above is hidden. Symmetrical with
          the previous unconditional spacer; CSS gates it. */}
      <div className="oz-topbar-spacer" aria-hidden="true" />

      {/*
        Theme + bell + wallet + avatar (or login / signup). Lives in
        the top bar on every breakpoint — the prior experiment of
        moving this cluster into the bet-slip rail header was reverted
        because the wallet pill alone is ~200px and the rail can't
        host the full cluster without the leftmost item leaking past
        the rail's left edge.
      */}
      <UserControls signedIn={signedIn} user={user} variant="topbar" />
    </header>
  );
}
