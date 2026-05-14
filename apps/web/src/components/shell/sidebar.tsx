"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { Wordmark } from "@/components/ui/monogram";
import { I } from "@/components/ui/icons";
import { LiveDot } from "@/components/ui/primitives";
import { TierMark, isFeaturedTier } from "@/components/ui/tier-mark";
import { clientApi } from "@/lib/api-client";
import { orderSportsForChips } from "@/lib/sport-order";
import { useTranslations } from "@/lib/i18n";
import { ThemeToggle } from "./theme-toggle";

interface SportItem {
  slug: string;
  name: string;
  kind: string;
  active: boolean;
}

interface Tournament {
  id: number;
  name: string;
  riskTier?: number | null;
  // Admin-uploaded or admin-pasted logo URL. Null falls back to the
  // sport's logo (gold-tier rendering keeps using TierMark either way).
  logoUrl?: string | null;
  brandColor?: string | null;
  matchCount: number;
  liveCount: number;
}

interface TournamentsResponse {
  sport: { id: number; slug: string; name: string };
  tournaments: Tournament[];
}

interface SidebarProps {
  sports: SportItem[];
  liveCounts: Record<string, number>;
  signedIn: boolean;
  isAdmin: boolean;
}

export function Sidebar({ sports, liveCounts, signedIn, isAdmin }: SidebarProps) {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const tShell = useTranslations("shell");
  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  };
  const totalLive = Object.values(liveCounts).reduce((a, n) => a + n, 0);

  const activeSportSlug = extractSportSlug(pathname);
  const activeTournamentId = searchParams?.get("tournament") ?? null;

  // Cache tournaments per sport so navigating away and back doesn't
  // re-fetch. Keyed by slug; value is the loaded list or undefined while
  // still loading / never requested.
  const [tournamentsBySport, setTournamentsBySport] = useState<
    Record<string, Tournament[]>
  >({});

  useEffect(() => {
    if (!activeSportSlug) return;
    if (tournamentsBySport[activeSportSlug]) return;
    let cancelled = false;
    clientApi<TournamentsResponse>(
      `/catalog/sports/${activeSportSlug}/tournaments`,
    )
      .then((data) => {
        if (cancelled) return;
        setTournamentsBySport((prev) => ({
          ...prev,
          [activeSportSlug]: data.tournaments,
        }));
      })
      .catch(() => {
        // Sidebar gracefully omits the tournament list on failure —
        // the top-level sport link still works.
      });
    return () => {
      cancelled = true;
    };
  }, [activeSportSlug, tournamentsBySport]);

  return (
    <aside
      className="oz-side"
      style={{
        gridArea: "side",
        padding: "20px 14px",
        borderRight: "1px solid var(--hairline)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        overflow: "auto",
      }}
    >
      {/*
        Brand mark at the top of the sidebar. size=240 renders the
        wordmark at 211×240 (WORDMARK_ASPECT ≈ 0.878), which lines up
        the mascot's width with the 240px sidebar column minus a small
        breathing margin on each side (column 240 − padding 14×2 +
        negative margin 6×2 = 224 effective; 224 − 211 = 13 → ~6.5px
        each side). Visible only on desktop via `.oz-side-logo` in
        globals.css; on mobile / tablet the sidebar is a drawer and the
        brand is in the top-bar.
      */}
      <Link
        href="/"
        aria-label={tShell("homeLink")}
        className="oz-side-logo"
        style={{
          display: "none",
          alignItems: "center",
          justifyContent: "center",
          margin: "-4px -6px 12px",
          padding: "4px 0",
          textDecoration: "none",
        }}
      >
        <Wordmark size={240} priority />
      </Link>

      <Item href="/" icon={<I.Grid size={15} />} active={isActive("/")} label={tShell("lobby")} />
      <Item
        href="/live"
        icon={<I.Live size={15} />}
        active={isActive("/live")}
        label={tShell("live")}
        tag={totalLive > 0 ? String(totalLive) : undefined}
      />
      <Item
        href="/upcoming"
        icon={<I.Clock size={15} />}
        active={isActive("/upcoming")}
        label={tShell("upcoming")}
      />
      {/*
        Community feed sits in the primary navigation cluster — same
        weight as Lobby / Live / Upcoming so the entry doesn't get
        buried at the bottom of the long sport list. Signed-out users
        see it too; the feed is anonymous.
      */}
      <Item
        href="/community"
        icon={<I.User size={15} />}
        active={isActive("/community")}
        label={tShell("community")}
      />

      <SectionLabel>{tShell("sports")}</SectionLabel>
      {orderSports(sports).map((s) => {
        const sportActive = isActive(`/sport/${s.slug}`);
        const expanded = sportActive && s.slug === activeSportSlug;
        const tournaments = tournamentsBySport[s.slug];
        return (
          <div key={s.slug}>
            <Item
              href={`/sport/${s.slug}`}
              icon={<SportGlyph sport={s.slug} size={16} />}
              active={sportActive && activeTournamentId == null}
              label={s.name}
              tag={liveCounts[s.slug] ? String(liveCounts[s.slug]) : undefined}
            />
            {expanded && tournaments && tournaments.length > 0 && (
              <div
                style={{
                  marginLeft: 22,
                  paddingLeft: 10,
                  borderLeft: "1px solid var(--hairline)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  marginTop: 2,
                  marginBottom: 4,
                }}
              >
                {tournaments.map((t) => {
                  const active = activeTournamentId === String(t.id);
                  return (
                    <TournamentItem
                      key={t.id}
                      sportSlug={s.slug}
                      tournament={t}
                      active={active}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <SectionLabel>{tShell("account")}</SectionLabel>
      {signedIn ? (
        <>
          <Item
            href="/bets"
            icon={<I.Ticket size={15} />}
            active={isActive("/bets")}
            label={tShell("myBets")}
          />
          <Item
            href="/wallet"
            icon={<I.Wallet size={15} />}
            active={isActive("/wallet")}
            label={tShell("wallet")}
          />
          {/*
            "/account/community" is the public-handle settings page
            (nickname / bio / avatar / visibility), not the feed.
            Labelled "Public profile" so it's clear this is where the
            user controls how they appear to others, distinct from
            "Settings" below (private account: email, password).
          */}
          <Item
            href="/account/community"
            icon={<I.User size={15} />}
            active={isActive("/account/community")}
            label={tShell("publicProfile")}
          />
          <Item
            href="/account"
            icon={<I.Gear size={15} />}
            active={pathname === "/account"}
            label={tShell("settings")}
          />
          {isAdmin && (
            <Item
              href="/admin"
              icon={<I.Trophy size={15} />}
              active={isActive("/admin")}
              label={tShell("admin")}
            />
          )}
          <LogOutItem />
        </>
      ) : (
        <>
          <Item href="/login" icon={<I.User size={15} />} active={isActive("/login")} label={tShell("login")} />
          <Item
            href="/signup"
            icon={<I.Plus size={15} />}
            active={isActive("/signup")}
            label={tShell("signup")}
          />
        </>
      )}

      <div style={{ flex: 1 }} />
      {/* Theme toggle on mobile only — the top-bar one is hidden under
          720px (.oz-topbar-theme in globals.css) to make room for the
          wallet pill + avatar, so users still need a way to flip themes
          from inside the sidebar drawer. Desktop keeps using the top-bar
          toggle to avoid a duplicate control on the same screen. */}
      <div
        className="oz-sidebar-theme"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          marginTop: 8,
          fontSize: 13,
          color: "var(--fg-muted)",
        }}
      >
        <ThemeToggle />
        <span>{tShell("toggleTheme")}</span>
      </div>
      <div
        style={{
          padding: 12,
          marginTop: 4,
          fontSize: 11,
          color: "var(--fg-dim)",
          lineHeight: 1.5,
        }}
      >
        {tShell("responsibleGambling")}
        <br />
        {tShell("ageNotice")}
      </div>
    </aside>
  );
}

// extractSportSlug returns the slug if the pathname is exactly
// /sport/:slug or /sport/:slug/… , otherwise null. Used by the sidebar
// to decide when to auto-expand the tournament sub-tree.
function extractSportSlug(pathname: string): string | null {
  const m = pathname.match(/^\/sport\/([^/]+)/);
  return m && m[1] ? m[1] : null;
}

// Sidebar sport ordering: flagship esports pinned on top, everything
// else alphabetical below. The shared helper from lib/sport-order
// also filters out the bot leagues defensively.
function orderSports(sports: SportItem[]): SportItem[] {
  return orderSportsForChips(sports);
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        padding: "14px 10px 6px",
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--fg-dim)",
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

function TournamentItem({
  sportSlug,
  tournament,
  active,
}: {
  sportSlug: string;
  tournament: Tournament;
  active: boolean;
}) {
  const tier = tournament.riskTier ?? null;
  const featured = isFeaturedTier(tier);
  const hasLive = tournament.liveCount > 0;
  return (
    <Link
      href={`/sport/${sportSlug}?tournament=${tournament.id}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderRadius: 6,
        fontSize: 12.5,
        textDecoration: "none",
        color: active || featured ? "var(--fg)" : "var(--fg-muted)",
        background: active ? "var(--surface-2)" : "transparent",
        position: "relative",
        transition: "background 140ms var(--ease), color 140ms var(--ease)",
      }}
    >
      <TierMark tier={tier} size={11} />
      <TournamentLogoMark logoUrl={tournament.logoUrl ?? null} name={tournament.name} />
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontWeight: featured ? 600 : undefined,
        }}
      >
        {tournament.name}
      </span>
      {hasLive && (
        <span
          className="mono tnum"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 10.5,
            color: "var(--live)",
            fontWeight: 600,
          }}
          title={`${tournament.liveCount} live now`}
        >
          <LiveDot size={6} />
          {tournament.liveCount}
        </span>
      )}
      {tournament.matchCount > 0 && (
        <span
          className="mono tnum"
          style={{
            fontSize: 10.5,
            color: active ? "var(--fg)" : "var(--fg-dim)",
          }}
        >
          {tournament.matchCount}
        </span>
      )}
    </Link>
  );
}

// 16-px square renderer for an admin-uploaded tournament logo. Falls
// back to nothing (TierMark + name still carry the row) when logoUrl
// is null OR when the <img> errors out, so a stale/blocked URL never
// breaks the sidebar layout.
function TournamentLogoMark({
  logoUrl,
  name,
}: {
  logoUrl: string | null;
  name: string;
}) {
  const [errored, setErrored] = useState(false);
  if (!logoUrl || errored) return null;
  return (
    <img
      src={logoUrl}
      alt=""
      aria-hidden
      width={14}
      height={14}
      title={name}
      onError={() => setErrored(true)}
      style={{
        width: 14,
        height: 14,
        objectFit: "contain",
        flexShrink: 0,
      }}
    />
  );
}

// Sidebar log-out — mirrors `Item`'s visual but is a button that
// fires /auth/logout and bounces to /login. Cookies are httpOnly so
// the redirect itself is enough to clear the session client-side.
function LogOutItem() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const t = useTranslations("common");

  function onClick() {
    startTransition(async () => {
      try {
        await clientApi("/auth/logout", { method: "POST" });
      } catch {
        // Server-side may be down; redirecting still drops the user
        // out of authenticated state on the next request.
      }
      router.push("/login");
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        justifyContent: "flex-start",
        width: "100%",
        padding: "8px 10px",
        background: "transparent",
        color: "var(--fg-muted)",
        borderRadius: 8,
        border: 0,
        cursor: pending ? "wait" : "pointer",
        font: "inherit",
        fontSize: 13,
        textAlign: "left",
        opacity: pending ? 0.6 : 1,
      }}
    >
      <I.Arrow size={15} />
      <span style={{ flex: 1 }}>{pending ? t("loggingOut") : t("logout")}</span>
    </button>
  );
}

function Item({
  href,
  icon,
  label,
  active,
  tag,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  tag?: string;
}) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        justifyContent: "flex-start",
        width: "100%",
        padding: "8px 10px",
        background: active ? "var(--surface-2)" : "transparent",
        color: active ? "var(--fg)" : "var(--fg-muted)",
        borderRadius: 8,
        textDecoration: "none",
        fontFamily: "inherit",
        fontSize: 13,
        textAlign: "left",
        position: "relative",
        transition: "background 140ms var(--ease), color 140ms var(--ease)",
      }}
    >
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {tag != null && (
        <span
          className="mono tnum"
          style={{
            fontSize: 10.5,
            padding: "1px 6px",
            color: "var(--fg-dim)",
          }}
        >
          {tag}
        </span>
      )}
      {active && (
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 8,
            bottom: 8,
            width: 2,
            background: "var(--fg)",
            borderRadius: 2,
          }}
        />
      )}
    </Link>
  );
}
