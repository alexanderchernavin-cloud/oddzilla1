"use client";

import { useState } from "react";
import { I } from "@/components/ui/icons";
import { NotificationPanel } from "./notification-panel";
import { useNotifications } from "@/lib/notifications";

// Static style objects hoisted to module scope — they don't depend on
// any per-render value, so re-using the same identity avoids a fresh
// object allocation on every poll-driven re-render of the bell.
const WRAPPER_STYLE = { position: "relative" as const };
const BUTTON_STYLE = {
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
const BADGE_STYLE = {
  position: "absolute" as const,
  top: 4,
  right: 2,
  minWidth: 16,
  height: 16,
  padding: "0 4px",
  borderRadius: 999,
  background: "var(--negative, #EF4444)",
  color: "#fff",
  fontSize: 10,
  fontWeight: 700,
  display: "inline-flex" as const,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  lineHeight: 1,
};

// Bell + popover. Lives next to the user-controls layout because
// anchor positioning requires a positioned wrapper around both the
// button and the panel. The optional `className` lets the caller
// add a CSS hook (the top bar passes `oz-topbar-bell` so the
// existing mobile @media rule that hides it on narrow phones still
// applies; the right rail mounts it without a class).
export function NotificationBell({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const { unreadCount } = useNotifications();
  return (
    <div style={WRAPPER_STYLE}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        aria-expanded={open}
        title={unreadCount > 0 ? `${unreadCount} unread` : "Notifications"}
        className={className}
        style={BUTTON_STYLE}
      >
        <I.Bell size={16} />
        {unreadCount > 0 ? (
          <span style={BADGE_STYLE}>
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>
      <NotificationPanel open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
