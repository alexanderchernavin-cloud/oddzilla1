"use client";

// Dropdown popover anchored under the bell. Renders the most recent
// notifications, supports per-item mark-read on click, and exposes
// the "Mark all read" affordance.
//
// Built without a popover library so the bundle stays lean — the
// click-outside detection is a single window listener, the
// positioning is portal-mounted to document.body so the panel
// escapes any overflow context above the bell (the bet-slip rail
// clips overflow-x to keep COMBI BOOST inner grids from leaking;
// the same clip would chop ~280px off this 360-wide panel without
// the portal). Visual polish (animation, focus trap) is
// intentionally minimal for V1.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { I } from "@/components/ui/icons";
import {
  useNotifications,
  NOTIFICATION_DISPLAY,
  formatRelativeTime,
} from "@/lib/notifications";
import { useTranslations } from "@/lib/i18n";
import type { NotificationItem } from "@oddzilla/types";

// Inline styles that have no per-row dynamic input are hoisted here so
// React doesn't see a fresh object identity on every render of every
// row. Same shape `top-bar.tsx`'s `iconBtn` uses for the same reason.
const ROW_TEXT_BLOCK_STYLE: CSSProperties = { flex: 1, minWidth: 0 };
const ROW_HEADLINE_STYLE: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.35,
  display: "block",
};
const ROW_ACTOR_STYLE: CSSProperties = { fontWeight: 600 };
const ROW_CTX_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--color-fg-muted, var(--fg-muted))",
  display: "block",
  marginTop: 2,
};
const ROW_TIMESTAMP_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--color-fg-subtle, var(--fg-muted))",
  display: "block",
  marginTop: 4,
};
const ROW_UNREAD_DOT_STYLE: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
  background: "#10B981",
  marginTop: 8,
  flexShrink: 0,
};
// Base of the row button. The `cursor` field is overridden per-row
// based on whether item.deepLink is set; merging with a fresh literal
// at render time is cheaper than rebuilding the whole 12-key object.
const ROW_BUTTON_BASE_STYLE: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
  padding: "10px 12px",
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: 0,
  borderBottom: "1px solid var(--color-border, var(--hairline))",
  color: "inherit",
};
// Base of the per-type icon disc. `background` + `color` are mixed in
// per row from cfg.color.
const ROW_ICON_BASE_STYLE: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 999,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  marginTop: 2,
};

interface PanelProps {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
}

// Panel width matches the original layout. Clamped to viewport with
// an 8px gutter so a 320-414px phone (where the bell lives in the
// top bar, not the rail) still shows a fully-visible popover.
const PANEL_WIDTH = 360;
const VIEWPORT_GUTTER = 8;

export function NotificationPanel({ open, onClose, triggerRef }: PanelProps) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement | null>(null);
  const { items, unreadCount, markRead, markAllRead, refresh, loading } =
    useNotifications();
  const tNot = useTranslations("notifications");
  const tCommon = useTranslations("common");

  // Portal-mount guard — createPortal needs document.body which doesn't
  // exist during SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Computed viewport-coord position for the portaled panel. null until
  // the first measurement so we don't render at (0,0) for a frame.
  const [pos, setPos] = useState<CSSProperties | null>(null);

  // Refresh when the panel opens — gives the user a fresh view
  // regardless of where in the 60s polling cycle they happen to land.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Re-measure the trigger's screen rect on open + on resize + on any
  // scroll (capture-phase so we catch scrolls inside the rail / main
  // grid, not just the document — scroll events don't bubble). The
  // bell can move when the user scrolls the rail content under it.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const width = Math.min(PANEL_WIDTH, vw - 2 * VIEWPORT_GUTTER);
      // Right-anchored to the trigger: align the panel's right edge
      // to the trigger's right edge, extending leftward.
      let left = rect.right - width;
      // Clamp to viewport so a narrow-screen trigger (e.g. mobile top
      // bar bell near the right edge) doesn't push the panel off the
      // left side.
      if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER;
      if (left + width > vw - VIEWPORT_GUTTER) {
        left = vw - VIEWPORT_GUTTER - width;
      }
      setPos({
        position: "fixed",
        top: rect.bottom + 6,
        left,
        width,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, triggerRef]);

  // Click-outside-to-close. Mousedown (not click) so we close before
  // the same event re-opens via the bell button.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      // The bell itself triggers its own toggle; ignore clicks on it
      // (either variant) so we don't double-close+open.
      if (triggerRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open, onClose, triggerRef]);

  if (!open || !mounted || !pos) return null;

  function onItemClick(item: NotificationItem) {
    if (!item.read) void markRead(item.id);
    if (item.deepLink) {
      router.push(item.deepLink);
      onClose();
    }
  }

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={tNot("title")}
      style={{
        ...pos,
        maxHeight: 480,
        overflow: "hidden",
        background: "var(--color-bg-elevated, var(--bg))",
        border: "1px solid var(--color-border-strong, var(--hairline))",
        borderRadius: 12,
        boxShadow: "0 12px 32px rgba(0,0,0,0.32)",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          borderBottom: "1px solid var(--color-border-strong, var(--hairline))",
        }}
      >
        <strong style={{ fontSize: 13, letterSpacing: 0.2 }}>
          {tNot("title")}
        </strong>
        {unreadCount > 0 ? (
          <span
            style={{
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 999,
              background: "color-mix(in oklab, #10B981 24%, transparent)",
              color: "#10B981",
              fontWeight: 600,
            }}
          >
            {unreadCount} new
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        {unreadCount > 0 ? (
          <button
            type="button"
            onClick={() => void markAllRead()}
            style={{
              fontSize: 11,
              color: "var(--color-fg-muted, var(--fg-muted))",
              background: "transparent",
              border: 0,
              cursor: "pointer",
              padding: 4,
            }}
          >
            {tNot("markAllRead")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label={tCommon("close")}
          style={{
            background: "transparent",
            border: 0,
            cursor: "pointer",
            color: "var(--color-fg-muted, var(--fg-muted))",
            padding: 4,
            display: "inline-flex",
          }}
        >
          <I.Close size={14} />
        </button>
      </header>

      <div style={{ overflowY: "auto", flex: 1 }}>
        {items.length === 0 ? (
          <p
            style={{
              padding: "24px 16px",
              textAlign: "center",
              fontSize: 13,
              color: "var(--color-fg-muted, var(--fg-muted))",
            }}
          >
            {loading ? tCommon("loading") : tNot("empty")}
          </p>
        ) : (
          items.map((item) => (
            <NotificationRow
              key={item.id}
              item={item}
              onClick={() => onItemClick(item)}
            />
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}

function NotificationRow({
  item,
  onClick,
}: {
  item: NotificationItem;
  onClick: () => void;
}) {
  const cfg = NOTIFICATION_DISPLAY[item.type];
  // `as keyof typeof I` resolves the icon component lazily so a
  // missing entry falls back gracefully to the bell.
  const Icon =
    (I as Record<string, (p: { size?: number }) => ReactElement>)[cfg.iconKey] ??
    I.Bell;

  const headline = cfg.headline(item);
  const ctx = cfg.context(item);
  const actor = item.actorNickname;

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...ROW_BUTTON_BASE_STYLE,
        cursor: item.deepLink ? "pointer" : "default",
      }}
    >
      <span
        style={{
          ...ROW_ICON_BASE_STYLE,
          background: `color-mix(in oklab, ${cfg.color} 20%, transparent)`,
          color: cfg.color,
        }}
      >
        <Icon size={14} />
      </span>
      <span style={ROW_TEXT_BLOCK_STYLE}>
        <span style={ROW_HEADLINE_STYLE}>
          {actor ? <strong style={ROW_ACTOR_STYLE}>{actor}</strong> : null}
          {actor ? " " : ""}
          {headline}
        </span>
        {ctx ? <span style={ROW_CTX_STYLE}>{ctx}</span> : null}
        <span style={ROW_TIMESTAMP_STYLE}>
          {formatRelativeTime(item.createdAt)}
        </span>
      </span>
      {!item.read ? (
        <span aria-label="Unread" style={ROW_UNREAD_DOT_STYLE} />
      ) : null}
    </button>
  );
}
