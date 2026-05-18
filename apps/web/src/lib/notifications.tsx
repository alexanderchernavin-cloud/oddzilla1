"use client";

// Client-side notification state for the bell + panel.
//
// The provider polls /community/notifications on a 60s cadence and on
// window focus. Polling (vs. WebSocket / SSE) is the simplest path for
// V1 and matches the rest of the app's freshness assumptions
// (settlement / wallet panes refresh similarly). A future PR can swap
// the polling for SSE driven by ws-gateway without changing the hook
// API the bell + panel consume.
//
// Rendering rules — kept here, not on the BE — because UI copy/icon
// choices are visual concerns that change without a schema migration.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  NotificationItem,
  NotificationListResponse,
  NotificationType,
  MarkReadResponse,
} from "@oddzilla/types";
// Subpath import — webpack rejects @oddzilla/types root-path runtime
// imports (the barrel index.ts re-exports .js paths that the bundler
// can't resolve). See user memory note on @oddzilla/types subpath
// imports + the pattern used elsewhere in apps/web/.
import { fromMicroMoney } from "@oddzilla/types/money";
import { clientApi } from "./api-client";

// 60s background refresh when the tab is visible. Tight enough to
// feel live for the "someone copied your bet" moment without burning
// the API rate limit (cap is 60/min, this consumes 1). When the tab
// is hidden we pause entirely; visibilitychange triggers an immediate
// refresh on return.
//
// Earlier this hook backed off to 5min when unreadCount === 0 to save
// requests on an empty inbox. The cost in user-perceived freshness was
// too high — an arrival in an empty inbox could take up to 5min to
// surface even on an active tab. Reverted to a single 60s cadence;
// SSE via ws-gateway is the right long-term replacement.
const POLL_INTERVAL_MS = 60_000;

interface NotificationContextValue {
  items: NotificationItem[];
  unreadCount: number;
  loading: boolean;
  // Force a refresh — called when the panel opens, after a mark-read,
  // and on window focus.
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const Ctx = createContext<NotificationContextValue | null>(null);

export function useNotifications(): NotificationContextValue {
  const v = useContext(Ctx);
  // Returning a no-op default rather than throwing means anonymous
  // pages (where the provider isn't mounted) can still call the hook
  // safely. The bell renders nothing in that case.
  return (
    v ?? {
      items: [],
      unreadCount: 0,
      loading: false,
      refresh: async () => {},
      markRead: async () => {},
      markAllRead: async () => {},
    }
  );
}

interface ProviderProps {
  enabled: boolean; // false for anonymous viewers
  children: ReactNode;
}

export function NotificationProvider({ enabled, children }: ProviderProps) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  // Guards against overlapping fetches when poll + focus + open
  // collide. We don't queue; whichever wins owns the state for the
  // round-trip.
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const res = await clientApi<NotificationListResponse>(
        "/community/notifications",
      );
      setItems(res.items);
      setUnreadCount(res.unreadCount);
    } catch {
      // Network blip — keep last-known state. The next tick recovers.
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [enabled]);

  const markRead = useCallback(
    async (id: string) => {
      if (!enabled) return;
      // Optimistic: flip local state first, reconcile with server
      // truth from the response (the server returns the canonical
      // unread count).
      setItems((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
      );
      setUnreadCount((c) => Math.max(0, c - 1));
      try {
        const res = await clientApi<MarkReadResponse>(
          `/community/notifications/${id}/read`,
          { method: "POST" },
        );
        setUnreadCount(res.unreadCount);
      } catch {
        // Revert is awkward (we'd need to remember the prior state)
        // — instead, the next refresh overwrites with server truth.
        await refresh();
      }
    },
    [enabled, refresh],
  );

  const markAllRead = useCallback(async () => {
    if (!enabled) return;
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
    try {
      await clientApi<MarkReadResponse>(
        "/community/notifications/read-all",
        { method: "POST" },
      );
    } catch {
      await refresh();
    }
  }, [enabled, refresh]);

  // Mount + interval + focus + visibility refresh.
  //
  // The interval fires every POLL_INTERVAL_MS while the tab is
  // visible. Hidden tabs skip the refresh entirely;
  // visibilitychange / focus drive an immediate catch-up on return.
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh();
    }, POLL_INTERVAL_MS);

    const onFocus = () => {
      void refresh();
    };
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        void refresh();
      }
    };

    window.addEventListener("focus", onFocus);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [enabled, refresh]);

  const value = useMemo<NotificationContextValue>(
    () => ({ items, unreadCount, loading, refresh, markRead, markAllRead }),
    [items, unreadCount, loading, refresh, markRead, markAllRead],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ─── Render helpers ──────────────────────────────────────────────────────────

// Per-type display config. Icons are intentionally drawn from the
// existing icon set in components/ui/icons.tsx so we don't grow the
// dependency surface for V1; richer icons land alongside richer copy
// in a follow-up.
//
// `category` informs which preference toggle suppresses the type in
// the settings UI — kept in lockstep with TYPE_TO_PREF on the BE.
export type NotificationCategory =
  | "Picks Copied"
  | "New Followers"
  | "Community Highlights"
  | "Competition Updates"
  | "Achievements & Rewards"
  | "Bet Settlements";

export interface NotificationDisplay {
  iconKey:
    | "Star"
    | "User"
    | "Trophy"
    | "Clock"
    | "Bell"
    | "Arrow"
    | "Ticket";
  // CSS variable or explicit color string — passed straight to
  // `color` on the icon element.
  color: string;
  // Headline format. {actor} interpolates the bold-actor name.
  // The renderer composes: <bold>{actor}</bold> + headline text.
  headline: (item: NotificationItem) => string;
  // Optional context line below the headline.
  context: (item: NotificationItem) => string | null;
  category: NotificationCategory;
}

// PRD copy verbatim (per the notification-types table). When the
// payload is missing fields we fall back to neutral phrasing rather
// than rendering "undefined".
export const NOTIFICATION_DISPLAY: Record<NotificationType, NotificationDisplay> = {
  pick_copied: {
    iconKey: "Star",
    color: "#06B6D4",
    headline: (i) => (i.groupCount > 1 ? `+${i.groupCount - 1} more copied your bet` : "copied your bet"),
    context: (i) => (i.payload.context as string | undefined) ?? null,
    category: "Picks Copied",
  },
  bet_inspired: {
    iconKey: "Star",
    color: "#F59E0B",
    headline: () => "was inspired by your bet",
    context: (i) => (i.payload.context as string | undefined) ?? null,
    category: "Picks Copied",
  },
  new_follower: {
    iconKey: "User",
    color: "#3B82F6",
    headline: () => "started following you",
    context: () => null,
    category: "New Followers",
  },
  analysis_shared: {
    iconKey: "Star",
    color: "#8B5CF6",
    headline: (i) => (i.groupCount > 1 ? `+${i.groupCount - 1} more liked your analysis` : "liked your analysis"),
    context: (i) => (i.payload.context as string | undefined) ?? null,
    category: "Community Highlights",
  },
  leaderboard_move: {
    iconKey: "Trophy",
    color: "#F59E0B",
    headline: (i) => {
      const rank = i.payload.newRank as number | undefined;
      const dir = i.payload.direction as "up" | "down" | undefined;
      const verb = dir === "down" ? "dropped to" : "moved up to";
      return `You ${verb} #${rank ?? "?"}`;
    },
    context: (i) => (i.payload.competitionTitle as string | undefined) ?? null,
    category: "Competition Updates",
  },
  competition_deadline: {
    iconKey: "Clock",
    color: "#F97316",
    headline: (i) => {
      const t = i.payload.competitionTitle as string | undefined;
      const h = i.payload.hoursRemaining as number | undefined;
      return `${t ? `"${t}"` : "Competition"} closes in ${h ?? "?"} hours`;
    },
    context: () => null,
    category: "Competition Updates",
  },
  community_digest: {
    iconKey: "Star",
    color: "#EC4899",
    headline: (i) => (i.payload.headline as string | undefined) ?? "This week in Community",
    context: () => null,
    category: "Community Highlights",
  },
  challenge_completed: {
    iconKey: "Trophy",
    color: "#10B981",
    headline: (i) => {
      const t = i.payload.challengeTitle as string | undefined;
      return t ? `Completed "${t}"` : "Challenge completed";
    },
    context: (i) => {
      const xp = i.payload.xp as number | undefined;
      const coins = i.payload.coins as number | undefined;
      const parts: string[] = [];
      if (xp) parts.push(`+${xp} XP`);
      if (coins) parts.push(`+${coins} Coins`);
      return parts.length ? parts.join(" · ") : null;
    },
    category: "Achievements & Rewards",
  },
  achievement_unlocked: {
    iconKey: "Trophy",
    color: "#F59E0B",
    headline: (i) => {
      const t = i.payload.achievementTitle as string | undefined;
      return t ? `Achievement: "${t}"` : "Achievement unlocked";
    },
    context: (i) => {
      const xp = i.payload.xp as number | undefined;
      return xp ? `+${xp} XP` : null;
    },
    category: "Achievements & Rewards",
  },
  level_up: {
    iconKey: "Arrow",
    color: "#6366F1",
    headline: (i) => {
      const lvl = i.payload.newLevel as number | undefined;
      const tier = i.payload.tierName as string | undefined;
      return `Reached Level ${lvl ?? "?"}${tier ? ` — ${tier} Tier` : ""}`;
    },
    context: () => null,
    category: "Achievements & Rewards",
  },
  loot_acquired: {
    iconKey: "Ticket",
    color: "#D946EF",
    headline: (i) => {
      const name = i.payload.cosmeticName as string | undefined;
      const r = i.payload.rarity as string | undefined;
      return `New cosmetic: ${name ?? "?"}${r ? ` (${r})` : ""}`;
    },
    context: () => null,
    category: "Achievements & Rewards",
  },
  bet_won: {
    iconKey: "Trophy",
    color: "#10B981",
    headline: (i) => {
      const payout = formatMicroMoney(i.payload.actualPayoutMicro);
      const currency = (i.payload.currency as string | undefined) ?? "";
      return `You won ${payout}${currency ? ` ${currency}` : ""}`;
    },
    context: (i) => settlementContext(i.payload),
    category: "Bet Settlements",
  },
  bet_cashed_out: {
    iconKey: "Ticket",
    color: "#06B6D4",
    headline: (i) => {
      const payout = formatMicroMoney(i.payload.actualPayoutMicro);
      const currency = (i.payload.currency as string | undefined) ?? "";
      return `Cashed out ${payout}${currency ? ` ${currency}` : ""}`;
    },
    context: (i) => settlementContext(i.payload),
    category: "Bet Settlements",
  },
};

// Shared formatter for bet_won + bet_cashed_out. Mirrors the server-
// side render.ts logic — micro strings parsed as BigInt to avoid the
// 2^53 precision loss on combo payouts.
function formatMicroMoney(raw: unknown): string {
  if (typeof raw !== "string") return "?";
  try {
    return fromMicroMoney(BigInt(raw), { decimals: 2 });
  } catch {
    return raw;
  }
}

// Secondary line for settlement notifications: "3-leg combo from a
// 25 USDC stake" / "Single bet from 10 OZ". Bet type + leg count is
// the disambiguator when a user has several tickets in flight.
function settlementContext(payload: Record<string, unknown>): string | null {
  const numLegs = typeof payload.numLegs === "number" ? payload.numLegs : 1;
  const betType =
    typeof payload.betType === "string" ? payload.betType : "single";
  const currency =
    typeof payload.currency === "string" ? payload.currency : "";
  const stake = formatMicroMoney(payload.stakeMicro);
  const noun =
    numLegs > 1 ? `${numLegs}-leg ${prettyBetType(betType)}` : "single bet";
  return `${noun} · ${stake}${currency ? ` ${currency}` : ""} stake`;
}

function prettyBetType(betType: string): string {
  switch (betType) {
    case "combo":
      return "combo";
    case "tiple":
      return "Tiple";
    case "tippot":
      return "Tippot";
    case "betbuilder":
      return "Bet Builder";
    default:
      return "bet";
  }
}

// Coarse "X minutes ago" for the panel timestamp.
export function formatRelativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  const sec = Math.max(1, Math.round((Date.now() - d) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}
