"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { I } from "@/components/ui/icons";
import { LiveDot } from "@/components/ui/primitives";
import { TierMark, isFeaturedTier } from "@/components/ui/tier-mark";
import { clientApi } from "@/lib/api-client";

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
      <Item href="/" icon={<I.Grid size={15} />} active={isActive("/")} label="Lobby" />
      <Item
        href="/live"
        icon={<I.Live size={15} />}
        active={isActive("/live")}
        label="Live"
        tag={totalLive > 0 ? String(totalLive) : undefined}
      />
      <Item
        href="/upcoming"
        icon={<I.Clock size={15} />}
        active={isActive("/upcoming")}
        label="Upcoming"
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
        label="Community"
      />

      <SectionLabel>Sports</SectionLabel>
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

      <SectionLabel>Account</SectionLabel>
      {signedIn ? (
        <>
          <Item
            href="/bets"
            icon={<I.Ticket size={15} />}
            active={isActive("/bets")}
            label="My bets"
          />
          <Item
            href="/wallet"
            icon={<I.Wallet size={15} />}
            active={isActive("/wallet")}
            label="Wallet"
          />
          {/*
            "/account/community" is the settings page (nickname / bio /
            visibility), not the feed. Renamed from "Community" so it
            doesn't collide with the new top-level Community entry above.
          */}
          <Item
            href="/account/community"
            icon={<I.User size={15} />}
            active={isActive("/account/community")}
            label="Profile"
          />
          <Item
            href="/account"
            icon={<I.Gear size={15} />}
            active={pathname === "/account"}
            label="Settings"
          />
          {isAdmin && (
            <Item
              href="/admin"
              icon={<I.Trophy size={15} />}
              active={isActive("/admin")}
              label="Admin"
            />
          )}
          <LogOutItem />
        </>
      ) : (
        <>
          <Item href="/login" icon={<I.User size={15} />} active={isActive("/login")} label="Log in" />
          <Item
            href="/signup"
            icon={<I.Plus size={15} />}
            active={isActive("/signup")}
            label="Sign up"
          />
        </>
      )}

      <div style={{ flex: 1 }} />
      <div
        style={{
          padding: 12,
          marginTop: 12,
          fontSize: 11,
          color: "var(--fg-dim)",
          lineHeight: 1.5,
        }}
      >
        Please bet responsibly.
        <br />
        18+ · BeGambleAware.org
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

// Explicit sport ordering: flagship esports pinned on top, everything
// else alphabetical below. Bot leagues are excluded from the product
// entirely (backend blocklist + DB inactive); the sidebar also filters
// them defensively so a stray active row can't leak in.
const TOP = ["cs2", "dota2", "lol", "valorant"] as const;
const HIDDEN = new Set<string>(["efootballbots", "ebasketballbots"]);

function orderSports(sports: SportItem[]): SportItem[] {
  const visible = sports.filter((s) => !HIDDEN.has(s.slug));
  const bySlug = new Map(visible.map((s) => [s.slug, s]));
  const top = TOP.map((s) => bySlug.get(s)).filter(
    (s): s is SportItem => Boolean(s),
  );
  const pinned = new Set<string>(TOP);
  const middle = visible
    .filter((s) => !pinned.has(s.slug))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...top, ...middle];
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
      <span style={{ flex: 1 }}>{pending ? "Logging out…" : "Log out"}</span>
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
