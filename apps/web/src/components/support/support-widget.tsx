"use client";

// Floating live-support chat widget. Bottom-right pinned button +
// panel for authenticated bettors. Anonymous renders self-hide.
//
// Hooks:
//   - useSessionUserId(): gate render on signed-in state
//   - useSupportStream(): live admin-reply frames push into the local
//                         message list without polling
//
// Data:
//   GET  /support/me/thread     on first open + on incoming frame for
//                               a not-yet-loaded thread (handles the
//                               "operator replied while widget was
//                               closed" edge — fetch fills the history).
//   POST /support/me/messages   on send (optimistic-append on success)
//   POST /support/me/mark-read  whenever the panel opens + after each
//                               admin frame while open
//
// The widget is permission-mode-friendly: every fetch uses clientApi
// (cookie-credentialed) and there's no SSR data dependency, so it
// mounts cleanly into the (main) layout for anonymous renders too —
// they just don't see anything.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { useSessionUserId } from "@/lib/session-user";
import { useSupportStream } from "@/lib/use-support-stream";
import type {
  SupportMessage,
  SupportMessageFrame,
  SupportMyThreadResponse,
  SupportThread,
} from "@oddzilla/types";

const MAX_BODY = 2000;

export function SupportWidget() {
  const userId = useSessionUserId();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [thread, setThread] = useState<SupportThread | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Server-authoritative unread counter; falls back to 0 until the
  // first /thread fetch completes. Stays accurate across tabs because
  // every admin reply ships its own unreadUser in the frame.
  const unreadUser = thread?.unreadUser ?? 0;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await clientApi<SupportMyThreadResponse>("/support/me/thread");
      setThread(data.thread);
      setMessages(data.messages);
      setLoaded(true);
    } catch (e) {
      // 401 means the cookie expired between SSR and this fetch — the
      // shell will redirect on the next mutation; silently ignore here.
      if (!(e instanceof ApiFetchError && e.status === 401)) {
        setError("Could not load chat.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const markRead = useCallback(async () => {
    try {
      await clientApi("/support/me/mark-read", { method: "POST" });
      setThread((prev) => (prev ? { ...prev, unreadUser: 0 } : prev));
    } catch {
      // best-effort
    }
  }, []);

  // Open handler: lazy-load + mark read so the badge clears as soon
  // as the operator's reply is on screen.
  const handleOpen = useCallback(() => {
    setOpen(true);
    setError(null);
    if (!loaded) void refresh();
    if (unreadUser > 0) void markRead();
  }, [loaded, markRead, refresh, unreadUser]);

  const handleClose = useCallback(() => setOpen(false), []);

  // Live frame handler. Append in chronological order (server emits
  // ascending ids) and update the unread counter for the closed-panel
  // case. If the panel is open we eagerly mark-read so the badge stays
  // at zero while the operator is replying live.
  useSupportStream(
    useCallback(
      (frame: SupportMessageFrame) => {
        setThread((prev) => {
          if (prev && prev.id === frame.threadId) {
            return {
              ...prev,
              lastMessageAt: frame.message.createdAt,
              unreadUser: frame.unreadUser,
            };
          }
          // First frame and we never loaded the thread yet — trigger
          // a backfill rather than guessing fields.
          if (!prev || prev.id !== frame.threadId) {
            void refresh();
            return prev;
          }
          return prev;
        });
        setMessages((prev) => {
          // Dedup by id — our own post lands here through the WS frame
          // too, but the optimistic insert ran first.
          if (prev.some((m) => m.id === frame.message.id)) return prev;
          return [...prev, frame.message];
        });
        if (open && frame.message.senderKind !== "user") {
          void markRead();
        }
      },
      [markRead, open, refresh],
    ),
  );

  // Scroll to bottom when the panel opens or new messages arrive.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [open, messages.length]);

  const handleSend = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await clientApi<{ threadId: string; message: SupportMessage }>(
        "/support/me/messages",
        {
          method: "POST",
          body: JSON.stringify({ body: trimmed }),
        },
      );
      setMessages((prev) => {
        if (prev.some((m) => m.id === res.message.id)) return prev;
        return [...prev, res.message];
      });
      setThread((prev) =>
        prev && prev.id === res.threadId
          ? { ...prev, lastMessageAt: res.message.createdAt }
          : prev ?? null,
      );
      setDraft("");
      if (!thread) void refresh();
    } catch (e) {
      const msg = e instanceof ApiFetchError ? e.body.message : "Could not send.";
      setError(msg || "Could not send.");
    } finally {
      setSending(false);
    }
  }, [draft, refresh, sending, thread]);

  const buttonAria = useMemo(
    () =>
      open
        ? "Close support chat"
        : unreadUser > 0
          ? `Open support chat (${unreadUser} new)`
          : "Open support chat",
    [open, unreadUser],
  );

  if (!userId) return null;

  return (
    <>
      <button
        type="button"
        onClick={open ? handleClose : handleOpen}
        aria-label={buttonAria}
        aria-expanded={open}
        style={{
          position: "fixed",
          right: 20,
          bottom: 20,
          zIndex: 9000,
          width: 52,
          height: 52,
          borderRadius: 26,
          border: "1px solid var(--color-border, var(--border))",
          background: "var(--color-fg, var(--fg))",
          color: "var(--color-bg, var(--bg))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
          fontFamily: "inherit",
        }}
      >
        <ChatGlyph open={open} />
        {!open && unreadUser > 0 ? (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              minWidth: 18,
              height: 18,
              padding: "0 5px",
              borderRadius: 9,
              background: "var(--color-negative, #c1342f)",
              color: "white",
              fontSize: 10,
              fontWeight: 700,
              lineHeight: "18px",
              textAlign: "center",
              border: "2px solid var(--color-bg, var(--bg))",
              boxSizing: "content-box",
            }}
          >
            {unreadUser > 9 ? "9+" : unreadUser}
          </span>
        ) : null}
      </button>

      {open ? (
        <SupportPanel
          loading={loading}
          loaded={loaded}
          messages={messages}
          draft={draft}
          setDraft={setDraft}
          sending={sending}
          error={error}
          onSend={handleSend}
          onClose={handleClose}
          listRef={listRef}
          threadStatus={thread?.status ?? "open"}
        />
      ) : null}
    </>
  );
}

function ChatGlyph({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M5 5l10 10M15 5L5 15"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
      <path
        d="M4 5h14a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1H8.5L5 18.8a.6.6 0 0 1-1-.42V6a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface PanelProps {
  loading: boolean;
  loaded: boolean;
  messages: SupportMessage[];
  draft: string;
  setDraft: (v: string) => void;
  sending: boolean;
  error: string | null;
  onSend: () => void;
  onClose: () => void;
  listRef: React.MutableRefObject<HTMLDivElement | null>;
  threadStatus: "open" | "closed";
}

function SupportPanel({
  loading,
  loaded,
  messages,
  draft,
  setDraft,
  sending,
  error,
  onSend,
  onClose,
  listRef,
  threadStatus,
}: PanelProps) {
  const closed = threadStatus === "closed";

  return (
    <div
      role="dialog"
      aria-label="Support chat"
      style={{
        position: "fixed",
        right: 20,
        bottom: 84,
        width: "min(380px, calc(100vw - 32px))",
        height: "min(520px, calc(100vh - 120px))",
        zIndex: 9001,
        display: "flex",
        flexDirection: "column",
        background: "var(--color-bg, var(--bg))",
        color: "var(--color-fg, var(--fg))",
        border: "1px solid var(--color-border, var(--border))",
        borderRadius: 12,
        boxShadow: "0 24px 60px rgba(0,0,0,0.22)",
        overflow: "hidden",
        fontFamily: "inherit",
      }}
    >
      <header
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--color-border, var(--border))",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <strong style={{ fontSize: 14 }}>Support</strong>
          <span
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--color-fg-subtle, var(--fg-dim))",
            }}
          >
            We usually reply within a few minutes
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close support chat"
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            border: "1px solid var(--color-border, var(--border))",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          ×
        </button>
      </header>

      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          background: "var(--color-bg-subtle, var(--surface-2))",
        }}
      >
        {!loaded && loading ? (
          <EmptyState text="Loading…" />
        ) : messages.length === 0 ? (
          <EmptyState text="Say hi — our team will get back to you here." />
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </div>

      <div
        style={{
          borderTop: "1px solid var(--color-border, var(--border))",
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          background: "var(--color-bg, var(--bg))",
        }}
      >
        {closed ? (
          <div
            style={{
              padding: 8,
              fontSize: 12,
              color: "var(--color-fg-muted, var(--fg-muted))",
            }}
          >
            This conversation was closed. Send a new message to start a fresh
            thread.
          </div>
        ) : null}
        {error ? (
          <div
            role="alert"
            style={{
              padding: 8,
              fontSize: 12,
              color: "var(--color-negative, #c1342f)",
            }}
          >
            {error}
          </div>
        ) : null}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, MAX_BODY))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="Type your message…"
          rows={2}
          aria-label="Message"
          style={{
            width: "100%",
            resize: "none",
            border: "1px solid var(--color-border, var(--border))",
            borderRadius: 8,
            background: "var(--color-bg, var(--bg))",
            color: "inherit",
            padding: 8,
            fontFamily: "inherit",
            fontSize: 13,
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: "var(--color-fg-subtle, var(--fg-dim))",
            }}
          >
            {draft.length}/{MAX_BODY}
          </span>
          <button
            type="button"
            onClick={onSend}
            disabled={sending || draft.trim().length === 0}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              border: "1px solid var(--color-border, var(--border))",
              background: "var(--color-fg, var(--fg))",
              color: "var(--color-bg, var(--bg))",
              fontFamily: "inherit",
              fontSize: 13,
              cursor: sending || !draft.trim() ? "not-allowed" : "pointer",
              opacity: sending || !draft.trim() ? 0.5 : 1,
            }}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div
      style={{
        margin: "auto",
        padding: 12,
        fontSize: 12,
        color: "var(--color-fg-muted, var(--fg-muted))",
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}

function MessageBubble({ message }: { message: SupportMessage }) {
  const fromUser = message.senderKind === "user";
  const fromSystem = message.senderKind === "system";
  const align = fromUser ? "flex-end" : "flex-start";
  const bg = fromSystem
    ? "transparent"
    : fromUser
      ? "var(--color-fg, var(--fg))"
      : "var(--color-bg, var(--bg))";
  const color = fromSystem
    ? "var(--color-fg-subtle, var(--fg-dim))"
    : fromUser
      ? "var(--color-bg, var(--bg))"
      : "var(--color-fg, var(--fg))";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align,
        gap: 2,
        maxWidth: "85%",
        alignSelf: align,
      }}
    >
      {!fromUser && !fromSystem ? (
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--color-fg-subtle, var(--fg-dim))",
            padding: "0 4px",
          }}
        >
          {message.senderName ?? "Support"}
        </span>
      ) : null}
      <div
        style={{
          padding: fromSystem ? "4px 8px" : "8px 10px",
          borderRadius: 10,
          border: fromSystem
            ? "0"
            : "1px solid var(--color-border, var(--border))",
          background: bg,
          color,
          fontSize: 13,
          lineHeight: 1.4,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {message.body}
      </div>
      <span
        style={{
          fontSize: 10,
          color: "var(--color-fg-subtle, var(--fg-dim))",
          padding: "0 4px",
        }}
      >
        {formatTime(message.createdAt)}
      </span>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    if (sameDay) return `${hh}:${mm}`;
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    return `${day}.${month} ${hh}:${mm}`;
  } catch {
    return "";
  }
}
