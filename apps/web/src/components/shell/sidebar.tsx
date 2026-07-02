"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useEffect,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { Wordmark } from "@/components/ui/monogram";
import { I } from "@/components/ui/icons";
import { LiveDot } from "@/components/ui/primitives";
import { TierMark, isFeaturedTier } from "@/components/ui/tier-mark";
import { clientApi } from "@/lib/api-client";
import {
  orderSportsForSidebar,
  partitionSportsForEdit,
} from "@/lib/sport-order";
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
  // Bettor's persisted sport order from /auth/me. NULL = render the
  // default (TOP_SPORT_SLUGS pinned + alphabetical) order. Signed-out
  // users always get NULL here.
  userSportOrder: string[] | null;
  // Bettor's persisted hidden-sport set from /auth/me (migration 0072).
  // NULL = nothing hidden. Hidden slugs are filtered out of the live
  // sidebar render and surfaced under a "Hidden" header in edit mode
  // so the bettor can un-hide them.
  userHiddenSports: string[] | null;
}

export function Sidebar({
  sports,
  liveCounts,
  signedIn,
  isAdmin,
  userSportOrder,
  userHiddenSports,
}: SidebarProps) {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const tShell = useTranslations("shell");
  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  };
  // Sum live counts EXCLUDING the bettor's hidden sports — the /live
  // page filters those rows out, so the Live entry's badge would
  // mislead the user otherwise ("5 live!" but the page renders 0).
  const hiddenSet = new Set(userHiddenSports ?? []);
  const totalLive = Object.entries(liveCounts).reduce(
    (a, [slug, n]) => (hiddenSet.has(slug) ? a : a + n),
    0,
  );

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
        liveCount={totalLive}
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

      <SportsSection
        sports={sports}
        liveCounts={liveCounts}
        userSportOrder={userSportOrder}
        userHiddenSports={userHiddenSports}
        signedIn={signedIn}
        activeSportSlug={activeSportSlug}
        activeTournamentId={activeTournamentId}
        isActive={isActive}
        tournamentsBySport={tournamentsBySport}
      />

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
        <br />
        <Link
          href="/privacy"
          style={{ color: "var(--fg-dim)", textDecoration: "underline" }}
        >
          {tShell("privacyPolicy")}
        </Link>
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

function SectionLabel({
  children,
  trailing,
}: {
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div
      className="mono"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "14px 10px 6px",
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--fg-dim)",
        fontWeight: 600,
      }}
    >
      <span style={{ flex: 1 }}>{children}</span>
      {trailing}
    </div>
  );
}

// Sports section with built-in customisation mode. Signed-in bettors
// can toggle edit mode via a gear icon in the section label, reorder
// each sport with up/down buttons, hide sports they don't care about,
// and reset to defaults. Order + hidden set are persisted server-side
// via PUT /users/me/sport-order + PUT /users/me/hidden-sports; the
// response shape is ignored — the source of truth during the editing
// session is the local state, and the next page render re-hydrates
// from /auth/me. Signed-out users see the section without the gear
// (no preference to save against).
//
// Layout outside edit mode: visible sports only, in the user's chosen
// order. Hidden sports + their live counts disappear entirely so the
// sidebar drawer stays short.
//
// Layout inside edit mode: visible sports first (in user order), then
// a "Hidden" header, then the hidden sports as un-hide-able rows. The
// up/down arrows only operate within the visible bucket — hiding a
// sport moves it under the header (and a future un-hide pops it back
// into the visible tail).
function SportsSection({
  sports,
  liveCounts,
  userSportOrder,
  userHiddenSports,
  signedIn,
  activeSportSlug,
  activeTournamentId,
  isActive,
  tournamentsBySport,
}: {
  sports: SportItem[];
  liveCounts: Record<string, number>;
  userSportOrder: string[] | null;
  userHiddenSports: string[] | null;
  signedIn: boolean;
  activeSportSlug: string | null;
  activeTournamentId: string | null;
  isActive: (href: string) => boolean;
  tournamentsBySport: Record<string, Tournament[]>;
}) {
  const tShell = useTranslations("shell");
  const [editing, setEditing] = useState(false);

  // Local override of the user's saved order + hidden set. Initialized
  // from the server props, and updated optimistically when the user
  // clicks arrow / hide / show / reset. Stays sticky across edit-mode
  // toggle so pressing Save doesn't visually revert. The earlier
  // pattern (with `editing` in the resync deps) overwrote local state
  // with the still-stale prop on Save; the cleaner model is
  // "localXxx is the source of truth for what we render; the prop
  // seeds it and reseeds only when the prop genuinely changes (e.g.
  // another tab edited)".
  const [localOrder, setLocalOrder] = useState<string[] | null>(
    userSportOrder,
  );
  const [localHidden, setLocalHidden] = useState<string[] | null>(
    userHiddenSports,
  );

  useEffect(() => {
    setLocalOrder(userSportOrder);
  }, [userSportOrder]);

  useEffect(() => {
    setLocalHidden(userHiddenSports);
  }, [userHiddenSports]);

  // Outside edit mode: the live sidebar list, hidden sports filtered
  // out so they don't take up screen real estate. Inside edit mode we
  // render `partitioned.visible` + a header + `partitioned.hidden`
  // instead so the bettor can still see them to un-hide.
  const renderList = useMemo(
    () => orderSportsForSidebar(sports, localOrder, localHidden),
    [sports, localOrder, localHidden],
  );
  const partitioned = useMemo(
    () => partitionSportsForEdit(sports, localOrder, localHidden),
    [sports, localOrder, localHidden],
  );

  function persistOrder(next: string[] | null) {
    clientApi("/users/me/sport-order", {
      method: "PUT",
      body: JSON.stringify({ order: next }),
    }).catch(() => {
      // Persistence failure is non-fatal — the local order still works
      // for this session. Errors surface in the network log; we don't
      // toast because the user's mental model is "I clicked an arrow",
      // not "I issued a network request".
    });
  }

  function persistHidden(next: string[] | null) {
    clientApi("/users/me/hidden-sports", {
      method: "PUT",
      body: JSON.stringify({ hidden: next }),
    }).catch(() => {
      // Non-fatal; same rationale as persistOrder.
    });
  }

  // Move applies only inside the visible bucket. We re-derive the
  // new slug order by reading `partitioned.visible` (the bucket the
  // arrows are visible against), swapping the two indices, and
  // emitting the resulting slug list as the new order. Hidden sports
  // are not included in `sport_order` because their position is
  // already fully determined by the hidden bucket.
  function move(index: number, dir: -1 | 1) {
    const swapWith = index + dir;
    if (swapWith < 0 || swapWith >= partitioned.visible.length) return;
    const next = partitioned.visible.slice();
    [next[index], next[swapWith]] = [next[swapWith]!, next[index]!];
    const slugs = next.map((s) => s.slug);
    setLocalOrder(slugs);
    persistOrder(slugs);
  }

  function hide(slug: string) {
    const set = new Set(localHidden ?? []);
    set.add(slug);
    const next = Array.from(set);
    setLocalHidden(next);
    persistHidden(next);
  }

  function show(slug: string) {
    if (!localHidden || localHidden.length === 0) return;
    const next = localHidden.filter((s) => s !== slug);
    const normalised = next.length === 0 ? null : next;
    setLocalHidden(normalised);
    persistHidden(normalised);
  }

  // Reset clears BOTH preferences — the user's mental model for the
  // "Reset" button is "put everything back to defaults", which means
  // showing every sport in the default pinned-first / alphabetical
  // order. Two independent persists so a network failure on one
  // doesn't roll the other back; the local state already reflects
  // the new default optimistically.
  function reset() {
    setLocalOrder(null);
    setLocalHidden(null);
    persistOrder(null);
    persistHidden(null);
  }

  const trailing = signedIn ? (
    editing ? (
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <button
          type="button"
          onClick={reset}
          className="mono"
          title={tShell("resetSports")}
          aria-label={tShell("resetSports")}
          style={{
            background: "transparent",
            border: 0,
            color: "var(--fg-muted)",
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            fontWeight: 600,
            padding: "2px 6px",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          {tShell("resetSports")}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="mono"
          title={tShell("saveSportOrder")}
          aria-label={tShell("saveSportOrder")}
          style={{
            background: "var(--fg)",
            color: "var(--bg)",
            border: 0,
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          {tShell("saveSportOrder")}
        </button>
      </div>
    ) : (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={tShell("customizeSports")}
        aria-label={tShell("customizeSports")}
        style={{
          background: "transparent",
          border: 0,
          color: "var(--fg-dim)",
          padding: 2,
          borderRadius: 4,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <I.Gear size={12} />
      </button>
    )
  ) : null;

  if (editing) {
    return (
      <>
        <SectionLabel trailing={trailing}>{tShell("sports")}</SectionLabel>
        {partitioned.visible.map((s, idx) => (
          <SportEditRow
            key={s.slug}
            sport={s}
            canMoveUp={idx > 0}
            canMoveDown={idx < partitioned.visible.length - 1}
            onMoveUp={() => move(idx, -1)}
            onMoveDown={() => move(idx, 1)}
            onHide={() => hide(s.slug)}
            hidden={false}
            upLabel={tShell("moveSportUp")}
            downLabel={tShell("moveSportDown")}
            hideLabel={tShell("hideSport")}
            showLabel={tShell("showSport")}
          />
        ))}
        {partitioned.hidden.length > 0 && (
          <>
            <HiddenSportsHeader label={tShell("hiddenSportsHeader")} />
            {partitioned.hidden.map((s) => (
              <SportEditRow
                key={s.slug}
                sport={s}
                canMoveUp={false}
                canMoveDown={false}
                onMoveUp={() => {}}
                onMoveDown={() => {}}
                onHide={() => show(s.slug)}
                hidden
                upLabel={tShell("moveSportUp")}
                downLabel={tShell("moveSportDown")}
                hideLabel={tShell("hideSport")}
                showLabel={tShell("showSport")}
              />
            ))}
          </>
        )}
      </>
    );
  }

  return (
    <>
      <SectionLabel trailing={trailing}>{tShell("sports")}</SectionLabel>
      {renderList.map((s) => {
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
              liveCount={liveCounts[s.slug] ?? 0}
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
    </>
  );
}

// Sub-header that introduces the hidden-sport bucket in edit mode.
// Visually quieter than the main "SPORTS" label so the bettor's eye
// rests on the visible bucket first; same mono treatment for shape
// consistency. Renders nothing when there are no hidden sports —
// caller gates this.
function HiddenSportsHeader({ label }: { label: string }) {
  return (
    <div
      className="mono"
      style={{
        padding: "12px 10px 4px",
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--fg-dim)",
        fontWeight: 600,
      }}
    >
      {label}
    </div>
  );
}

// One sport row in customisation mode. Carries up/down arrow buttons
// the user clicks to reorder, plus a hide/show toggle (eye icon).
// Disabled state matches the row's position in the list (top row
// can't move up, etc.); when `hidden=true` the arrows render as
// hidden placeholders since hidden sports don't have an order.
//
// Layout note: in edit mode the row extends 8 px past the section's
// right padding (negative marginRight) so the button stack can use
// the sidebar's right gutter. The slight misalignment with the
// non-edit rows above/below is intentional and only visible while
// editing — it buys the sport-name column ~20 px of width, which is
// enough to keep "League of Legends" / "Counter-Strike 2 Duels"
// from truncating.
function SportEditRow({
  sport,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onHide,
  hidden,
  upLabel,
  downLabel,
  hideLabel,
  showLabel,
}: {
  sport: SportItem;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  // Toggle: when hidden=false this hides the sport; when hidden=true
  // it un-hides. One callback because the surface is symmetric and
  // the parent always knows the current state from the bucket the
  // row was rendered in.
  onHide: () => void;
  hidden: boolean;
  upLabel: string;
  downLabel: string;
  hideLabel: string;
  showLabel: string;
}) {
  const toggleLabel = hidden ? showLabel : hideLabel;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 0 8px 10px",
        marginRight: -8,
        borderRadius: 8,
        background: "transparent",
        color: hidden ? "var(--fg-dim)" : "var(--fg-muted)",
        fontSize: 13,
        opacity: hidden ? 0.75 : 1,
      }}
    >
      <SportGlyph sport={sport.slug} size={16} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {sport.name}
      </span>
      <div style={{ display: "inline-flex", gap: 2, flexShrink: 0 }}>
        {!hidden && (
          <>
            <button
              type="button"
              onClick={onMoveUp}
              disabled={!canMoveUp}
              title={upLabel}
              aria-label={`${upLabel}: ${sport.name}`}
              style={moveBtnStyle(canMoveUp)}
            >
              <I.ChevU size={12} />
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={!canMoveDown}
              title={downLabel}
              aria-label={`${downLabel}: ${sport.name}`}
              style={moveBtnStyle(canMoveDown)}
            >
              <I.ChevD size={12} />
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onHide}
          title={toggleLabel}
          aria-label={`${toggleLabel}: ${sport.name}`}
          style={moveBtnStyle(true)}
        >
          {hidden ? <I.EyeOff size={12} /> : <I.Eye size={12} />}
        </button>
      </div>
    </div>
  );
}

function moveBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: 0,
    color: enabled ? "var(--fg-muted)" : "var(--fg-dim)",
    width: 18,
    height: 22,
    padding: 0,
    borderRadius: 4,
    cursor: enabled ? "pointer" : "not-allowed",
    opacity: enabled ? 1 : 0.35,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };
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
      {/* matchCount is intentionally NOT rendered — the sidebar tournament
          tree shows the live-only badge above; the total-match count was
          dropped per operator request 2026-05-25 because it added visual
          noise without driving navigation (the user already clicks through
          to see the list). matchCount stays on the API response + Tournament
          type so the row's visibility gate (matchCount > 0) keeps working
          in the parent list. */}
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
  liveCount,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  tag?: string;
  liveCount?: number;
}) {
  const hasLive = (liveCount ?? 0) > 0;
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
          title={`${liveCount} live now`}
        >
          <LiveDot size={6} />
          {liveCount}
        </span>
      )}
      {!hasLive && tag != null && (
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
