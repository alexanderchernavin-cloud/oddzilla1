"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { Wordmark } from "@/components/ui/monogram";
import { I } from "@/components/ui/icons";
import { LiveDot } from "@/components/ui/primitives";
import { useZillaBoostSportSet } from "@/lib/use-zillaboost-banners";
import { TierMark, isFeaturedTier } from "@/components/ui/tier-mark";
import { clientApi } from "@/lib/api-client";
import { categoryFlagUrl } from "@/lib/category-flags";
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
  /**
   * Operator pin position from /admin/sports (migration 0103). Null on
   * every unpinned sport, which then keeps the old flagship-slugs-then-
   * alphabetical order. A bettor's own saved order still wins over both.
   */
  displayOrder?: number | null;
}

// Which half of the sport rail is showing. `sports.kind` is the
// discriminator ("esport" | "traditional"); anything not explicitly
// traditional counts as esport, matching the catalog's own default.
type SportKindTab = "esport" | "traditional";

const SPORT_TAB_KEY = "oz:sport-tab";

interface TournamentCategory {
  id: number;
  name: string;
  slug: string;
  /**
   * Category the operator keeps out of the match lists (migration 0102) —
   * EA FC simulations under Football, and anything else flagged on
   * /admin/categories. The tree still carries it and this header is the
   * only way in, so the bucket wears a quiet marker rather than hiding.
   */
  hiddenFromLists?: boolean;
  /**
   * Operator pin position within this sport's tree (migration 0103).
   * Null leaves the bucket in the alphabetical tail, which is where
   * every bucket sat before the column existed.
   */
  displayOrder?: number | null;
}

interface Tournament {
  id: number;
  name: string;
  // Country / competition the tournament sits under, used to group the
  // sub-tree. Null for Oddin's synthetic "Auto-mapped" category, which
  // holds every esports tournament and would only add a meaningless
  // header — those render flat, exactly as they did before grouping.
  category?: TournamentCategory | null;
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
  const activeCategoryId = searchParams?.get("category") ?? null;

  // Cache tournaments per sport so navigating away and back doesn't
  // re-fetch. Keyed by slug; value is the loaded list or undefined while
  // still loading / never requested.
  const [tournamentsBySport, setTournamentsBySport] = useState<
    Record<string, Tournament[]>
  >({});

  // Sports the user has expanded with the caret, independent of where
  // they've navigated. The active sport is always treated as expanded
  // (unless explicitly collapsed) so landing on /sport/:slug still
  // reveals its tree — but browsing the tournament list of a sport no
  // longer requires leaving the page you're on.
  const [expandedSports, setExpandedSports] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsedSports, setCollapsedSports] = useState<Set<string>>(
    () => new Set(),
  );

  const isSportExpanded = (slug: string) =>
    expandedSports.has(slug) ||
    (slug === activeSportSlug && !collapsedSports.has(slug));

  function toggleSport(slug: string) {
    const open = isSportExpanded(slug);
    setExpandedSports((prev) => {
      const next = new Set(prev);
      if (open) next.delete(slug);
      else next.add(slug);
      return next;
    });
    // The active sport auto-expands, so closing it needs an explicit
    // "user collapsed this" marker the auto-rule can't override.
    setCollapsedSports((prev) => {
      const next = new Set(prev);
      if (open) next.add(slug);
      else next.delete(slug);
      return next;
    });
  }

  // Fetch the tournament list for every sport whose tree is open —
  // the caret-expanded ones plus the active sport. Each slug is
  // fetched at most once per session; `wanted` is joined into a
  // primitive so the effect doesn't re-run on every Set identity.
  const wantedSlugs = useMemo(() => {
    const set = new Set(expandedSports);
    if (activeSportSlug && !collapsedSports.has(activeSportSlug)) {
      set.add(activeSportSlug);
    }
    return [...set].sort();
  }, [expandedSports, collapsedSports, activeSportSlug]);
  const wantedKey = wantedSlugs.join(",");

  // Slugs already requested this session. A ref rather than state
  // because it must be checked and set synchronously, before React
  // commits anything — a state flag would let a second render fire a
  // duplicate fetch for the same slug, and StrictMode's double-invoke
  // in dev would do it every time.
  const requestedSlugs = useRef<Set<string>>(new Set());

  // One place that turns "we want this sport's tree" into at most one
  // request per slug per session. Called by the open-tree effect below
  // AND by the prefetch handlers on each row, which is the whole point
  // of extracting it: a hover or the first touch contact can start the
  // fetch before the click lands, so the tree is already in hand by the
  // time the caret toggles.
  const ensureTournaments = useCallback((slug: string) => {
    if (requestedSlugs.current.has(slug)) return;
    requestedSlugs.current.add(slug);
    clientApi<TournamentsResponse>(`/catalog/sports/${slug}/tournaments`)
      .then((data) => {
        setTournamentsBySport((cur) => ({ ...cur, [slug]: data.tournaments }));
      })
      .catch(() => {
        // Sidebar gracefully omits the tournament list on failure —
        // the top-level sport link still works. Drop the slug so
        // re-opening the sport retries instead of staying empty.
        requestedSlugs.current.delete(slug);
      });
  }, []);

  useEffect(() => {
    if (wantedKey === "") return;
    for (const slug of wantedKey.split(",")) ensureTournaments(slug);
  }, [wantedKey, ensureTournaments]);

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
        No "Sports" nav item. It existed to give the Fonbet traditional
        line one obvious entry point back when the sport rail was a
        single esports-first list. The rail now opens on a Sports /
        Esports switch sitting a few pixels below, which is both a
        better entry point and the one bettors actually reach for, so
        the nav row was two controls competing for the same job. The
        /sports route still exists and still works if linked directly.
      */}
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
        activeCategoryId={activeCategoryId}
        isActive={isActive}
        tournamentsBySport={tournamentsBySport}
        isSportExpanded={isSportExpanded}
        onToggleSport={toggleSport}
        onPrefetchSport={ensureTournaments}
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

// Prefetch-on-intent for a sport's tournament tree.
//
// The tree is fetched on demand, and on a broad sport that fetch is the
// slowest thing in the sidebar — so the win is starting it BEFORE the
// click rather than after. Two signals, because they have very
// different amounts of warning to offer:
//
//   - Mouse hover, after a dwell. The dwell is the whole point: without
//     it, sweeping the pointer down the rail to reach the sport you
//     want would fire a request for every sport you passed over, and
//     several of those are the expensive ones. 140 ms filters a
//     pass-through from an approach, and still lands well before the
//     click.
//   - Pointer-down, immediately. On touch there is no hover to read, but
//     finger-down to click is ~100-200 ms of real headroom, and on a
//     mouse it is another ~80-150 ms on top of the dwell.
//
// Deliberately NOT wired to focus: React's onFocus bubbles, so tabbing
// through the rail would request every sport in it. A keyboard user
// still gets the on-expand fetch, exactly as before.
//
// One module-level timer is enough — only one row can be hovered.
const HOVER_INTENT_MS = 140;
let hoverIntentTimer: ReturnType<typeof setTimeout> | null = null;

function clearHoverIntent() {
  if (hoverIntentTimer !== null) {
    clearTimeout(hoverIntentTimer);
    hoverIntentTimer = null;
  }
}

function prefetchHandlers(slug: string, prefetch: (slug: string) => void) {
  return {
    onPointerEnter: (e: React.PointerEvent) => {
      // Touch and pen deliver enter + down together, so a dwell here
      // would only delay the fetch it is meant to bring forward.
      if (e.pointerType !== "mouse") {
        prefetch(slug);
        return;
      }
      clearHoverIntent();
      hoverIntentTimer = setTimeout(() => {
        hoverIntentTimer = null;
        prefetch(slug);
      }, HOVER_INTENT_MS);
    },
    onPointerLeave: clearHoverIntent,
    onPointerDown: () => {
      clearHoverIntent();
      prefetch(slug);
    },
  };
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
  activeCategoryId,
  isActive,
  tournamentsBySport,
  isSportExpanded,
  onToggleSport,
  onPrefetchSport,
}: {
  sports: SportItem[];
  liveCounts: Record<string, number>;
  userSportOrder: string[] | null;
  userHiddenSports: string[] | null;
  signedIn: boolean;
  activeSportSlug: string | null;
  activeTournamentId: string | null;
  activeCategoryId: string | null;
  isActive: (href: string) => boolean;
  tournamentsBySport: Record<string, Tournament[]>;
  isSportExpanded: (slug: string) => boolean;
  onToggleSport: (slug: string) => void;
  onPrefetchSport: (slug: string) => void;
}) {
  const tShell = useTranslations("shell");
  const [editing, setEditing] = useState(false);
  // ZillaBoost sport banners (migration 0086) — slugs wearing the bolt.
  const boostedSports = useZillaBoostSportSet();

  // Which of the two lists is showing. Read from localStorage on mount
  // rather than in the initializer: the server renders the default, so
  // seeding from storage during the first render would hydrate a
  // different tree than the HTML and React would discard it.
  const [tab, setTab] = useState<SportKindTab>("esport");
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SPORT_TAB_KEY);
      if (saved === "esport" || saved === "traditional") setTab(saved);
    } catch {
      // Private mode / blocked storage — the default tab is fine.
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(SPORT_TAB_KEY, tab);
    } catch {
      // Non-fatal; the choice just doesn't survive a reload.
    }
  }, [tab]);

  // Follow the page. Landing on /sport/football while the rail shows
  // Esports would hide the very row the user is looking at — and with
  // it the tournament tree that just auto-expanded underneath it.
  const activeSportKind = activeSportSlug
    ? sports.find((s) => s.slug === activeSportSlug)?.kind
    : undefined;
  useEffect(() => {
    if (activeSportKind === "traditional") setTab("traditional");
    else if (activeSportKind) setTab("esport");
  }, [activeSportKind]);

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

  // Which half of the rail a sport belongs to. `sports.kind` is the
  // discriminator; anything that isn't explicitly traditional is an
  // esport, so a new kind from the feed lands with the esports rather
  // than vanishing from both lists.
  const inTab = (s: SportItem, t: SportKindTab) =>
    (s.kind === "traditional" ? "traditional" : "esport") === t;

  // Move applies within the visible bucket of the CURRENT tab, which
  // is the only list the arrows are rendered against. The saved
  // preference is still ONE global slug list, so we swap the two
  // sports at their positions in the full visible order: sports of the
  // other kind keep their slots and their relative order, and "up"
  // means "above the next sport you can actually see". Hidden sports
  // are not included in `sport_order` because their position is
  // already fully determined by the hidden bucket.
  function move(list: SportItem[], index: number, dir: -1 | 1) {
    const swapWith = index + dir;
    if (swapWith < 0 || swapWith >= list.length) return;
    const next = partitioned.visible.slice();
    const a = next.indexOf(list[index]!);
    const b = next.indexOf(list[swapWith]!);
    if (a < 0 || b < 0) return;
    [next[a], next[b]] = [next[b]!, next[a]!];
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

  // Section header, shared by both modes. With both halves on offer
  // it's the segmented tab control; with only one (a feed outage, or
  // Fonbet switched off) it's a plain label rather than a toggle with
  // a dead half.
  const sectionHeader = (bothKinds: boolean, activeTab: SportKindTab) =>
    bothKinds ? (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "14px 2px 8px",
        }}
      >
        <SportKindTabs
          value={activeTab}
          onChange={setTab}
          esportsLabel={tShell("esportsSection")}
          sportsLabel={tShell("sports")}
        />
        {trailing}
      </div>
    ) : (
      <SectionLabel trailing={trailing}>
        {activeTab === "traditional"
          ? tShell("sports")
          : tShell("esportsSection")}
      </SectionLabel>
    );

  // Edit mode shows the SAME half of the rail the bettor is looking
  // at, not both kinds stacked into one flat list. Flat, reordering a
  // traditional sport meant scrolling past ~16 esports to reach the
  // row, and the arrows on that row moved it through sports that were
  // never on screen together. The tab strip stays live while editing,
  // so the other half is one click away and `move` keeps emitting a
  // single global order underneath.
  //
  // The universe here is visible + hidden, not just what renders
  // outside edit mode: a bettor who hid every traditional sport must
  // still be able to reach that tab to un-hide one.
  if (editing) {
    const universe = [...partitioned.visible, ...partitioned.hidden];
    const hasEsports = universe.some((s) => inTab(s, "esport"));
    const hasTraditional = universe.some((s) => inTab(s, "traditional"));
    const bothKinds = hasEsports && hasTraditional;
    const editTab: SportKindTab = bothKinds
      ? tab
      : hasTraditional
        ? "traditional"
        : "esport";
    const editVisible = partitioned.visible.filter((s) => inTab(s, editTab));
    const editHidden = partitioned.hidden.filter((s) => inTab(s, editTab));
    return (
      <>
        {sectionHeader(bothKinds, editTab)}
        {editVisible.map((s, idx) => (
          <SportEditRow
            key={s.slug}
            sport={s}
            canMoveUp={idx > 0}
            canMoveDown={idx < editVisible.length - 1}
            onMoveUp={() => move(editVisible, idx, -1)}
            onMoveDown={() => move(editVisible, idx, 1)}
            onHide={() => hide(s.slug)}
            hidden={false}
            upLabel={tShell("moveSportUp")}
            downLabel={tShell("moveSportDown")}
            hideLabel={tShell("hideSport")}
            showLabel={tShell("showSport")}
          />
        ))}
        {editHidden.length > 0 && (
          <>
            <HiddenSportsHeader label={tShell("hiddenSportsHeader")} />
            {editHidden.map((s) => (
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

  // Two sub-sections, switched side by side rather than stacked. The
  // stacked version meant the Fonbet traditional line always sat below
  // ~16 esports, so reaching Football was a scroll on every visit. One
  // of the two lists is rendered at a time; the saved sport order and
  // hidden set stay global slug lists, so ordering inside each still
  // honours whatever the bettor arranged.
  const esports = renderList.filter((s) => inTab(s, "esport"));
  const traditional = renderList.filter((s) => inTab(s, "traditional"));

  const renderSport = (s: SportItem) => {
    const sportActive = isActive(`/sport/${s.slug}`);
    const expanded = isSportExpanded(s.slug);
    const tournaments = tournamentsBySport[s.slug];
    return (
      <div key={s.slug} {...prefetchHandlers(s.slug, onPrefetchSport)}>
        <Item
          href={`/sport/${s.slug}`}
          icon={<SportGlyph sport={s.slug} size={16} />}
          active={
            sportActive && activeTournamentId == null && activeCategoryId == null
          }
          label={s.name}
          liveCount={liveCounts[s.slug] ?? 0}
          boosted={boostedSports.has(s.slug)}
          expanded={expanded}
          onToggleExpand={() => onToggleSport(s.slug)}
          expandLabel={
            expanded ? tShell("hideTournaments") : tShell("showTournaments")
          }
        />
        {expanded && tournaments && tournaments.length > 0 && (
          <div
            style={{
              // Deliberately shallow: the panel is 240px wide, so every
              // pixel of indent is a pixel off the tournament name. One
              // step in for the tree, one more for tournaments inside a
              // category — enough to read the hierarchy, not enough to
              // squeeze the labels.
              marginLeft: 14,
              paddingLeft: 8,
              borderLeft: "1px solid var(--hairline)",
              display: "flex",
              flexDirection: "column",
              gap: 1,
              marginTop: 2,
              marginBottom: 6,
            }}
          >
            {groupTournamentsByCategory(tournaments).map((group) => (
              <CategoryGroup
                key={group.key}
                group={group}
                sportSlug={s.slug}
                activeTournamentId={activeTournamentId}
                activeCategoryId={activeCategoryId}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  // Nothing to switch between when only one kind is on offer (a feed
  // outage, or Fonbet switched off) — `sectionHeader` then renders a
  // plain label rather than a toggle with a dead half.
  const bothKinds = esports.length > 0 && traditional.length > 0;
  const activeTab: SportKindTab = bothKinds
    ? tab
    : traditional.length > 0
      ? "traditional"
      : "esport";
  const list = activeTab === "traditional" ? traditional : esports;
  return (
    <>
      {sectionHeader(bothKinds, activeTab)}
      {list.map(renderSport)}
    </>
  );
}

// Side-by-side switch between the esports and traditional lists. A
// segmented control rather than two nav links: the two halves are
// mutually exclusive views of the same rail, and a bettor flipping
// between them is changing what they're browsing, not navigating.
//
// Built from the shell's own tokens. The pair is --bg-sunken for the
// track and --surface-2 for the active segment, chosen because it is
// the only pair that stays "raised" in BOTH themes: light goes
// #ecebe5 -> #faf8f3 and dark #050506 -> #1a1a1c, so the active pill
// is lighter than its track either way. The obvious-looking
// --surface-2 / --bg-elevated inverts on dark (#1a1a1c track, #131314
// pill), which reads as a recess — the opposite of what a selected
// segment should say.
function SportKindTabs({
  value,
  onChange,
  esportsLabel,
  sportsLabel,
}: {
  value: SportKindTab;
  onChange: (v: SportKindTab) => void;
  esportsLabel: string;
  sportsLabel: string;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        flex: 1,
        minWidth: 0,
        padding: 2,
        gap: 2,
        borderRadius: 8,
        background: "var(--bg-sunken)",
        border: "1px solid var(--hairline)",
      }}
    >
      {(
        // Sports on the left, esports on the right (operator call,
        // 2026-09-05). Only the render order moves — `esport` is still
        // the tab a fresh visitor lands on, and the stored preference
        // key is unchanged, so nobody's saved side flips under them.
        [
          ["traditional", sportsLabel],
          ["esport", esportsLabel],
        ] as const
      ).map(([kind, label]) => {
        const active = value === kind;
        return (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(kind)}
            className="mono"
            style={{
              flex: 1,
              minWidth: 0,
              padding: "5px 4px",
              border: 0,
              borderRadius: 6,
              background: active ? "var(--surface-2)" : "transparent",
              color: active ? "var(--fg)" : "var(--fg-muted)",
              boxShadow: active ? "var(--shadow-sm)" : "none",
              fontSize: 9.5,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              fontWeight: 600,
              cursor: "pointer",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              transition:
                "background 140ms var(--ease), color 140ms var(--ease)",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// One category bucket in a sport's tournament tree.
//
// Collapsed by default (operator request 2026-09-04): the Fonbet line
// puts 50+ leagues under a single sport across a dozen countries, and
// rendering all of them flat turned the sidebar into an unscannable
// wall. The unlabelled bucket — Oddin's synthetic "Auto-mapped"
// category, which holds every esports tournament — has no header to
// click and stays open, so esports look exactly as they did before.
//
// Auto-opens when the currently-filtered tournament lives inside it, or
// when the bucket IS the current category filter — otherwise the active
// row would sit behind a collapsed header.
function CategoryGroup({
  group,
  sportSlug,
  activeTournamentId,
  activeCategoryId,
}: {
  group: TournamentGroup;
  sportSlug: string;
  activeTournamentId: string | null;
  activeCategoryId: string | null;
}) {
  const isActiveCategory =
    group.categoryId != null && String(group.categoryId) === activeCategoryId;
  const holdsActive =
    isActiveCategory ||
    (activeTournamentId != null &&
      group.tournaments.some((t) => String(t.id) === activeTournamentId));
  // `open` stays the single source of truth so the caret can still
  // close a bucket that auto-opened; the effect only ever forces it
  // open (deriving `expanded` from holdsActive directly would make the
  // toggle a no-op on whichever bucket holds the active filter).
  const [open, setOpen] = useState(holdsActive);
  useEffect(() => {
    if (holdsActive) setOpen(true);
  }, [holdsActive]);
  const expanded = group.label == null || open;

  // Fonbet has a real competition mark for only about half its leagues
  // (their own site falls back to the country flag, which this bucket's
  // header already carries), so a group is normally a mix of logo'd and
  // bare rows. Hold the icon slot open for every row in a group where at
  // least one logo exists, so the names share a left edge instead of
  // stepping in and out; a group with no logos at all keeps the full 240px
  // panel width for names. Derived from the data, not from each row's
  // <img> error state, so a logo that 404s doesn't reflow its neighbours.
  const reserveLogoSlot = group.tournaments.some((t) => t.logoUrl);

  // Built on demand, not eagerly. Football's tree is 105 buckets over
  // 291 tournaments and nearly every bucket is collapsed, so building
  // the element for each one up front meant constructing (and, on every
  // re-render of the sidebar, re-constructing) a few hundred rows that
  // are never mounted.
  const renderList = () => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        marginLeft: group.label ? 10 : 0,
      }}
    >
      {group.tournaments.map((t) => (
        <TournamentItem
          key={t.id}
          sportSlug={sportSlug}
          tournament={t}
          active={activeTournamentId === String(t.id)}
          stripPrefix={group.label}
          reserveLogoSlot={reserveLogoSlot}
        />
      ))}
    </div>
  );

  if (group.label == null) return renderList();

  return (
    <div>
      <CategoryHeader
        label={group.label}
        href={
          group.categoryId != null
            ? `/sport/${sportSlug}?category=${group.categoryId}`
            : null
        }
        logoUrl={group.logoUrl}
        liveCount={group.liveCount}
        tournamentCount={group.tournaments.length}
        hiddenFromLists={group.hiddenFromLists}
        active={isActiveCategory}
        expanded={expanded}
        onToggle={() => setOpen((v) => !v)}
      />
      {expanded && renderList()}
    </div>
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

interface TournamentGroup {
  key: string;
  /** Null renders the tournaments without a header (ungrouped bucket). */
  label: string | null;
  /** Category id, so the header can link to `?category=`. Null when unlabelled. */
  categoryId: number | null;
  /** True when this bucket only shows up in lists once it's the one selected. */
  hiddenFromLists: boolean;
  /** Operator pin position, or null for the alphabetical tail. */
  displayOrder: number | null;
  /**
   * Logo to stand for the whole bucket, when one unambiguously does.
   * Set only when every tournament in the bucket that carries a logo
   * carries the SAME one — a cycling category is one race whose stages
   * all wear the race's crest, whereas a country bucket holds several
   * unrelated leagues and must not borrow whichever league sorted first.
   */
  logoUrl: string | null;
  liveCount: number;
  tournaments: Tournament[];
}

// groupTournamentsByCategory turns the flat API list into category
// buckets, preserving the caller's tournament order inside each one (the
// endpoint sorts by operator pin, then tier, then live count, then name —
// migration 0104 added the pin tier, and preserving order here is what
// makes a pinned tournament head its own category).
//
// Two deliberate choices:
//   - Tournaments with no category (Oddin's synthetic "Auto-mapped", which
//     the API nulls out) collect into one unlabelled bucket rendered FIRST
//     and without a header, so every esport looks exactly as it did before
//     grouping existed.
//   - Labelled buckets sort by the operator's pin order first (migration
//     0103, set on /admin/categories), then by NAME. They used to sort by
//     live count first, which made the list jump around as matches went
//     live and finished — with the buckets now collapsed by default the
//     header row is a navigation target, and a target that moves is worse
//     than one that's occasionally below the fold. The pin tier is the
//     operator saying which countries lead the tree; it is a fixed
//     sequence, so it keeps that property.
function groupTournamentsByCategory(tournaments: Tournament[]): TournamentGroup[] {
  const ungrouped: Tournament[] = [];
  const byCategory = new Map<string, TournamentGroup>();
  const ambiguousLogo = new Map<string, boolean>();
  for (const t of tournaments) {
    const label = t.category?.name?.trim();
    if (!label) {
      ungrouped.push(t);
      continue;
    }
    const key = String(t.category?.id ?? label);
    let group = byCategory.get(key);
    if (!group) {
      group = {
        key,
        label,
        categoryId: t.category?.id ?? null,
        hiddenFromLists: t.category?.hiddenFromLists === true,
        displayOrder: t.category?.displayOrder ?? null,
        logoUrl: null,
        liveCount: 0,
        tournaments: [],
      };
      byCategory.set(key, group);
      ambiguousLogo.set(key, false);
    }
    group.tournaments.push(t);
    group.liveCount += t.liveCount;
    const logo = t.logoUrl ?? null;
    if (logo) {
      if (group.logoUrl == null) group.logoUrl = logo;
      else if (group.logoUrl !== logo) ambiguousLogo.set(key, true);
    }
  }
  for (const [key, group] of byCategory) {
    if (ambiguousLogo.get(key)) group.logoUrl = null;
  }
  const groups = [...byCategory.values()].sort((a, b) => {
    // MAX_SAFE_INTEGER for an unpinned bucket drops it below every
    // pinned one without a second branch — same shape the tournament
    // tier sort just above uses for a null risk_tier.
    const pa = a.displayOrder ?? Number.MAX_SAFE_INTEGER;
    const pb = b.displayOrder ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return (a.label ?? "").localeCompare(b.label ?? "", undefined, {
      sensitivity: "base",
    });
  });
  if (ungrouped.length > 0) {
    groups.unshift({
      key: "__ungrouped",
      label: null,
      categoryId: null,
      hiddenFromLists: false,
      displayOrder: null,
      logoUrl: null,
      liveCount: 0,
      tournaments: ungrouped,
    });
  }
  return groups;
}

// Header for a category bucket: two controls sharing one row.
//
// The caret collapses the bucket; the label FILTERS the sport page to
// this category (`/sport/<slug>?category=<id>`). They were a single
// button until the list-exclusion flag landed (migration 0102) — a
// bucket the match lists deliberately skip has to be reachable, and
// "expand it, then pick one of seventeen tournaments" is not reachable
// in any useful sense. Splitting them also pays off on the ordinary
// country buckets: one click on "England" is now every English league.
//
// Kept from the previous version:
//   - Reads as normal text, not tiny letterspaced uppercase mono. The
//     old treatment was 9.5px --fg-dim on the page background, which
//     failed on contrast and was the operator's first complaint.
//   - The hover surface spans the whole row, so the two halves still
//     read as one header and not as two unrelated widgets.
//   - The flag comes from Fonbet's circle-flag set via the api proxy
//     (see lib/category-flags.ts); a category that isn't a country
//     falls back to the bucket's own logo when it has one, and to
//     nothing at all when it doesn't.
function CategoryHeader({
  label,
  href,
  logoUrl,
  liveCount,
  tournamentCount,
  hiddenFromLists,
  active,
  expanded,
  onToggle,
}: {
  label: string;
  /** Null when the bucket carries no category id — the label falls back to toggling. */
  href: string | null;
  logoUrl: string | null;
  liveCount: number;
  tournamentCount: number;
  hiddenFromLists: boolean;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tShell = useTranslations("shell");
  const [hover, setHover] = useState(false);

  const count =
    liveCount > 0 ? (
      <span
        className="mono tnum"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          fontSize: 10,
          color: "var(--live)",
          fontWeight: 600,
          flexShrink: 0,
        }}
        title={`${liveCount} live now`}
      >
        <LiveDot size={5} />
        {liveCount}
      </span>
    ) : (
      <span
        className="mono tnum"
        style={{
          fontSize: 10,
          color: "var(--fg-dim)",
          fontWeight: 500,
          flexShrink: 0,
        }}
      >
        {tournamentCount}
      </span>
    );

  const inner = (
    <>
      <CategoryMark label={label} logoUrl={logoUrl} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {/* Quiet marker, not a warning: the bucket exists, the lists just
          skip it, and this header is the way in. Without it a bettor has
          nothing to explain why the sport's own live badge is smaller
          than the counts in its tree add up to. */}
      {hiddenFromLists && (
        <I.EyeOff size={11} style={{ color: "var(--fg-dim)", flexShrink: 0 }} />
      )}
      {count}
    </>
  );

  const labelStyle = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flex: 1,
    minWidth: 0,
    padding: "6px 6px 6px 2px",
    borderRadius: 6,
    color: active ? "var(--accent)" : "var(--fg)",
    font: "inherit",
    fontSize: 12,
    fontWeight: 600,
    textAlign: "left" as const,
    textDecoration: "none",
    border: 0,
    background: "transparent",
    cursor: "pointer",
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        marginTop: 2,
        borderRadius: 6,
        background: active || hover ? "var(--surface-2)" : "transparent",
        transition: "background 140ms var(--ease)",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={
          expanded ? tShell("hideTournaments") : tShell("showTournaments")
        }
        // Same touch problem as the sport caret, one level down, and with
        // a worse consequence: the sibling here is a Link that filters the
        // whole sport page to this category, so a miss both navigates and
        // closes the drawer. `.oz-cat-caret` widens the hit area on coarse
        // pointers; the label keeps the rest of the row.
        className="oz-cat-caret"
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "6px 2px 6px 6px",
          border: 0,
          background: "transparent",
          color: "inherit",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <Caret open={expanded} size={9} />
      </button>
      {href ? (
        <Link
          href={href}
          title={
            hiddenFromLists
              ? `${label} — ${tShell("categoryHiddenFromLists")}`
              : label
          }
          aria-current={active ? "page" : undefined}
          style={labelStyle}
        >
          {inner}
        </Link>
      ) : (
        <button type="button" onClick={onToggle} title={label} style={labelStyle}>
          {inner}
        </button>
      )}
    </div>
  );
}

// 15-px mark for a category: the country's flag when we have one,
// otherwise the bucket's own logo (a cycling category IS a race, and
// the race's crest is on its tournaments), otherwise NOTHING.
//
// There used to be a two-letter initials disc here so every row kept
// the same left edge. It was the wrong trade: on a cycling tree it
// stamped invented monograms — "TO" on Tour of Britain, "VE" on Vuelta
// Espana, "ZT" on ZLM Tour — beside names that already say those words,
// which reads as machine filler rather than as branding. A missing
// logo is better shown as absent; the caret still holds the left edge.
function CategoryMark({ label, logoUrl }: { label: string; logoUrl: string | null }) {
  const url = categoryFlagUrl(label);
  const [flagErrored, setFlagErrored] = useState(false);
  const [logoErrored, setLogoErrored] = useState(false);
  if (url && !flagErrored) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden
        width={15}
        height={15}
        // A big sport's tree opens ~105 of these at once, and the drawer
        // shows maybe a dozen of them without scrolling. Lazy keeps the
        // rest off the wire until they're scrolled to; `async` decoding
        // keeps whichever do load off the main thread, so the expand
        // animation doesn't stutter behind image decode work.
        loading="lazy"
        decoding="async"
        onError={() => setFlagErrored(true)}
        style={{
          width: 15,
          height: 15,
          borderRadius: "50%",
          objectFit: "cover",
          flexShrink: 0,
        }}
      />
    );
  }
  if (logoUrl && !logoErrored) {
    return (
      <img
        src={logoUrl}
        alt=""
        aria-hidden
        width={15}
        height={15}
        loading="lazy"
        decoding="async"
        onError={() => setLogoErrored(true)}
        style={{
          width: 15,
          height: 15,
          objectFit: "contain",
          flexShrink: 0,
        }}
      />
    );
  }
  return null;
}

// Disclosure caret. Rotates rather than swapping glyphs so the
// open/close transition reads as one control.
function Caret({ open, size = 10 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{
        flexShrink: 0,
        opacity: 0.75,
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform 140ms var(--ease)",
      }}
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

function TournamentItem({
  sportSlug,
  tournament,
  active,
  stripPrefix,
  reserveLogoSlot,
}: {
  sportSlug: string;
  tournament: Tournament;
  active: boolean;
  // Category the row is rendered under, if any. Fonbet's tournament
  // names carry their own country prefix ("Russia. IPBL. Pro Division"),
  // which is pure duplication once the row sits under a "Russia"
  // header — and on a 240px panel it's duplication that costs the part
  // of the name you actually need to tell two leagues apart.
  stripPrefix?: string | null;
  // Keep the logo square occupied even with nothing to draw, so rows in
  // a partly-logo'd group share a left edge. Set by CategoryGroup.
  reserveLogoSlot?: boolean;
}) {
  const tMatch = useTranslations("match");
  const tier = tournament.riskTier ?? null;
  const featured = isFeaturedTier(tier);
  const hasLive = tournament.liveCount > 0;
  const displayName = stripCategoryPrefix(tournament.name, stripPrefix);
  return (
    <Link
      href={`/sport/${sportSlug}?tournament=${tournament.id}`}
      title={tournament.name}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 6px",
        borderRadius: 6,
        fontSize: 12,
        textDecoration: "none",
        color: active || featured ? "var(--fg)" : "var(--fg-muted)",
        background: active ? "var(--surface-2)" : "transparent",
        position: "relative",
        transition: "background 140ms var(--ease), color 140ms var(--ease)",
      }}
    >
      <TierMark tier={tier} size={11} label={tMatch("topTournamentTitle")} />
      <TournamentLogoMark
        logoUrl={tournament.logoUrl ?? null}
        name={tournament.name}
        reserveSlot={reserveLogoSlot ?? false}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontWeight: featured ? 600 : undefined,
        }}
      >
        {displayName}
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

// Drops a redundant leading category prefix from a tournament name.
// Fonbet composes its segment names as "<Country>. <League>. <Season>",
// and the category is derived from that same first token — so under a
// "Russia" header, "Russia. IPBL. Pro Division" spends a third of the
// available width restating where you already are. Matches only a
// whole leading token followed by a separator, case-insensitively, so
// "Russian Championship" under "Russia" is left alone. The full name
// stays on the link's title attribute.
function stripCategoryPrefix(
  name: string,
  prefix: string | null | undefined,
): string {
  if (!prefix) return name;
  const p = prefix.trim();
  if (p.length === 0 || name.length <= p.length) return name;
  if (name.slice(0, p.length).toLowerCase() !== p.toLowerCase()) return name;
  const rest = name.slice(p.length).replace(/^\s*[.\-:—]\s*/, "");
  // No separator consumed means the prefix ran into the middle of a
  // word ("Russian" starts with "Russia"); leave the name untouched.
  if (rest === name.slice(p.length) || rest.length === 0) return name;
  return rest;
}

// 14-px square renderer for a tournament logo. Draws nothing when logoUrl
// is null OR when the <img> errors out, so a stale/blocked URL never breaks
// the sidebar layout — deliberately no monogram or flag stand-in, same call
// as TeamMark: an invented mark abbreviating the words already on the row
// reads as a badge that means something. With reserveSlot the square is
// still occupied, so the row keeps its neighbours' left edge.
function TournamentLogoMark({
  logoUrl,
  name,
  reserveSlot,
}: {
  logoUrl: string | null;
  name: string;
  reserveSlot: boolean;
}) {
  const [errored, setErrored] = useState(false);
  if (!logoUrl || errored) {
    return reserveSlot ? (
      <span aria-hidden style={{ width: 14, height: 14, flexShrink: 0 }} />
    ) : null;
  }
  return (
    <img
      src={logoUrl}
      alt=""
      aria-hidden
      width={14}
      height={14}
      title={name}
      loading="lazy"
      decoding="async"
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
  boosted,
  expanded,
  onToggleExpand,
  expandLabel,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  tag?: string;
  liveCount?: number;
  // ZillaBoost sport banner (migration 0086): a banner-enabled
  // sport-scope boost renders a small green bolt next to the sport.
  boosted?: boolean;
  // Sport rows carry a disclosure caret that opens the tournament tree
  // WITHOUT navigating. Before this the tree only appeared once you
  // were on /sport/:slug, so there was no way to look at what's on
  // offer in another sport without leaving the page you were reading.
  // Omitted (with onToggleExpand) on the non-sport nav entries.
  expanded?: boolean;
  onToggleExpand?: () => void;
  expandLabel?: string;
}) {
  const hasLive = (liveCount ?? 0) > 0;
  const row = (
    <Link
      href={href}
      // Only carries the class when there IS a caret — the coarse-pointer
      // rule widens the right padding to clear the enlarged hit area, and
      // a row without a caret has nothing to clear.
      className={onToggleExpand ? "oz-sport-row" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        justifyContent: "flex-start",
        width: "100%",
        // Reserve the caret's column so a long sport name or a live
        // badge never slides underneath it.
        padding: onToggleExpand ? "8px 30px 8px 10px" : "8px 10px",
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
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {boosted && (
        <svg
          width={11}
          height={11}
          viewBox="0 0 24 24"
          fill="var(--positive, #16a34a)"
          aria-label="ZillaBoost"
          style={{ flexShrink: 0 }}
        >
          <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z" />
        </svg>
      )}
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

  if (!onToggleExpand) return row;

  // The caret is a SIBLING of the link, absolutely positioned over the
  // padding the link reserves for it — not a child. Nesting a button
  // inside an <a> is non-conforming HTML, and the alternative (a
  // role="button" span cancelling the click) leaves a control that
  // screen readers announce as part of the link and that swallows
  // events the router has already seen.
  return (
    <div style={{ position: "relative" }}>
      {row}
      <button
        type="button"
        aria-expanded={expanded ?? false}
        aria-label={expandLabel}
        title={expandLabel}
        className="oz-sport-caret"
        onClick={() => onToggleExpand()}
        style={{
          position: "absolute",
          right: 4,
          top: "50%",
          transform: "translateY(-50%)",
          // Mouse size. 24px was ALSO the touch size until 2026-09-06,
          // and it was too small to hit reliably: a finger aiming at the
          // chevron regularly landed on the link instead, which both
          // navigated away and — because the drawer auto-closes on
          // navigation — dismissed the sidebar the bettor was browsing.
          // `.oz-sport-caret` under `(pointer: coarse)` in globals.css
          // grows this to 48x40 without moving the glyph.
          width: 24,
          height: 24,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: 0,
          borderRadius: 5,
          padding: 0,
          color: "var(--fg-dim)",
          cursor: "pointer",
        }}
      >
        <Caret open={expanded ?? false} size={10} />
      </button>
    </div>
  );
}
