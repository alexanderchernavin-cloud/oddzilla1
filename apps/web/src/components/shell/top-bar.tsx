"use client";

import Link from "next/link";
import { I } from "@/components/ui/icons";
import { Wordmark } from "@/components/ui/monogram";
import { useTranslations } from "@/lib/i18n";
import { useMobileDrawers } from "./mobile-drawer-context";
import { UserControls } from "./user-controls";
import { ZillapassIndicator } from "./zillapass-indicator";

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
        height: 90,
        borderBottom: "1px solid var(--hairline)",
        background: "color-mix(in oklab, var(--bg) 80%, transparent)",
        backdropFilter: "blur(12px)",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      {/*
        Hamburger — mobile only. 66px hit target (1.5× the prior 44px
        baseline) so the whole row reads as a dedicated mobile chrome
        strip; the 33px Grid icon scales with it. The wordmark sits to
        the right of this button on mobile via `.oz-topbar-logo`
        (hidden on tablet, where the docked sidebar already carries
        the brand mark).
      */}
      <button
        type="button"
        onClick={toggleSidebar}
        className="oz-topbar-toggle"
        style={{ ...iconBtn, width: 66, height: 66, display: undefined, marginLeft: -10 }}
        aria-label={tCommon("openNavigation")}
      >
        <I.Grid size={33} />
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
        <Wordmark size={60} priority />
      </Link>

      {/*
        Mobile-only ZillaPass chip. The default-variant chip lives
        in the shell-search row beside the search input on tablet +
        desktop, where there's a 460-px-wide slot for it. On a 360-
        414 px phone that row has no room — the search input fills
        the line — so the compact variant slots into the topbar's
        empty mid-band (between the wordmark and the wallet pill)
        and the default variant hides on mobile via CSS.
      */}
      <ZillapassIndicator variant="compact" />

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
