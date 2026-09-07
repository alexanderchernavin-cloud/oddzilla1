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
//   POST /support/me/messages   multipart/form-data: `body` text field
//                               + up to 5 `files[]` parts (10 MiB each).
//                               Bare fetch because clientApi force-sets
//                               application/json which would corrupt
//                               the multipart boundary — same convention
//                               every admin file-upload component uses.
//   POST /support/me/mark-read  whenever the panel opens + after each
//                               admin frame while open

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { useSessionUserId } from "@/lib/session-user";
import { useLocale, useTranslations } from "@/lib/i18n";
import { useSupportStream } from "@/lib/use-support-stream";
import type {
  SupportAttachment,
  SupportMessage,
  SupportMessageFrame,
  SupportMyThreadResponse,
  SupportThread,
} from "@oddzilla/types";
// Value imports go through the deep subpath so Next's webpack doesn't
// have to chase every `export * from './*.js'` re-export in the
// barrel index — same convention as `@oddzilla/types/money`,
// `@oddzilla/types/odds`, etc. Type-only imports above can ride
// the barrel because TS strips them before bundling.
import {
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENT_MAX_PER_MESSAGE,
} from "@oddzilla/types/support";

const MAX_BODY = 2000;

interface PendingFile {
  /** Stable per-pick id so the chip list keys + the X-button removal
   * stays stable across re-renders even when filenames collide. */
  key: string;
  file: File;
}

function nextPendingKey(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function SupportWidget() {
  const t = useTranslations("supportChat");
  const userId = useSessionUserId();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [thread, setThread] = useState<SupportThread | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const unreadUser = thread?.unreadUser ?? 0;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await clientApi<SupportMyThreadResponse>("/support/me/thread");
      setThread(data.thread);
      setMessages(data.messages);
      setLoaded(true);
    } catch (e) {
      if (!(e instanceof ApiFetchError && e.status === 401)) {
        setError(t("loadError"));
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  const markRead = useCallback(async () => {
    try {
      await clientApi("/support/me/mark-read", { method: "POST" });
      setThread((prev) => (prev ? { ...prev, unreadUser: 0 } : prev));
    } catch {
      // best-effort
    }
  }, []);

  const handleOpen = useCallback(() => {
    setOpen(true);
    setError(null);
    if (!loaded) void refresh();
    if (unreadUser > 0) void markRead();
  }, [loaded, markRead, refresh, unreadUser]);

  const handleClose = useCallback(() => setOpen(false), []);

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
          if (!prev || prev.id !== frame.threadId) {
            void refresh();
            return prev;
          }
          return prev;
        });
        setMessages((prev) => {
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

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [open, messages.length]);

  const pickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const list = Array.from(incoming);
      if (list.length === 0) return;
      setError(null);
      setPending((prev) => {
        const next = [...prev];
        for (const f of list) {
          if (next.length >= SUPPORT_ATTACHMENT_MAX_PER_MESSAGE) {
            setError(
              t("tooManyFiles", { count: SUPPORT_ATTACHMENT_MAX_PER_MESSAGE }),
            );
            break;
          }
          if (f.size > SUPPORT_ATTACHMENT_MAX_BYTES) {
            setError(
              t("fileTooLarge", {
                name: f.name,
                limit: formatBytes(SUPPORT_ATTACHMENT_MAX_BYTES),
              }),
            );
            continue;
          }
          if (f.size === 0) {
            setError(t("fileEmpty", { name: f.name }));
            continue;
          }
          next.push({ key: nextPendingKey(), file: f });
        }
        return next;
      });
    },
    [t],
  );

  const removePending = useCallback((key: string) => {
    setPending((prev) => prev.filter((p) => p.key !== key));
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = draft.trim();
    if (sending) return;
    if (!trimmed && pending.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("body", trimmed);
      for (const p of pending) fd.append("files", p.file, p.file.name);
      // Bare fetch — clientApi would stamp content-type: application/json
      // and break the multipart boundary. Cookie auth rides via
      // credentials: 'include' (same-origin so SameSite=Lax allows it).
      const res = await fetch("/api/support/me/messages", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        let msg = t("sendError");
        try {
          const body = (await res.json()) as {
            error?: string;
            message?: string;
          };
          msg = body.message || body.error || msg;
        } catch {
          // non-JSON body
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as {
        threadId: string;
        message: SupportMessage;
      };
      setMessages((prev) => {
        if (prev.some((m) => m.id === data.message.id)) return prev;
        return [...prev, data.message];
      });
      setThread((prev) =>
        prev && prev.id === data.threadId
          ? { ...prev, lastMessageAt: data.message.createdAt }
          : prev ?? null,
      );
      setDraft("");
      setPending([]);
      if (!thread) void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("sendError"));
    } finally {
      setSending(false);
    }
  }, [draft, pending, refresh, sending, thread, t]);

  const buttonAria = useMemo(
    () =>
      open
        ? t("closeAria")
        : unreadUser > 0
          ? t("openUnreadAria", { count: unreadUser })
          : t("openAria"),
    [open, unreadUser, t],
  );

  if (!userId) return null;

  return (
    <>
      {/* `oz-support-fab` is a styling hook, not a style carrier: the
          responsive block in globals.css uses it to take the button out
          of the way of the mobile bet-slip chrome. It is hidden while
          the slip's bottom sheet is open, where it floated at z-index
          9000 over the sheet's own Place bet button (operator,
          2026-09-07); the collapsed peek bar keeps clear of it by
          reserving room at its right edge instead. */}
      <button
        type="button"
        className="oz-support-fab"
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
          pending={pending}
          onPickFiles={pickFiles}
          onRemovePending={removePending}
          fileInputRef={fileInputRef}
          onFilesPicked={(files) => addFiles(files)}
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

function PaperclipGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M10.5 4.5L6 9a1.5 1.5 0 0 0 2.121 2.121L13 6.243a3 3 0 1 0-4.243-4.243L4 6.757a4.5 4.5 0 1 0 6.364 6.364L14 9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
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
  pending: PendingFile[];
  onPickFiles: () => void;
  onRemovePending: (key: string) => void;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  onFilesPicked: (files: FileList) => void;
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
  pending,
  onPickFiles,
  onRemovePending,
  fileInputRef,
  onFilesPicked,
}: PanelProps) {
  const t = useTranslations("supportChat");
  const closed = threadStatus === "closed";
  const canSend = !sending && (draft.trim().length > 0 || pending.length > 0);
  const attachLimit = pending.length >= SUPPORT_ATTACHMENT_MAX_PER_MESSAGE;

  return (
    <div
      role="dialog"
      className="oz-support-panel"
      aria-label={t("dialogAria")}
      style={{
        position: "fixed",
        right: 20,
        bottom: 84,
        width: "min(380px, calc(100vw - 32px))",
        height: "min(540px, calc(100vh - 120px))",
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
          <strong style={{ fontSize: 14 }}>{t("title")}</strong>
          <span
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--color-fg-subtle, var(--fg-dim))",
            }}
          >
            {t("subtitle")}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("closeAria")}
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
          <EmptyState text={t("loading")} />
        ) : messages.length === 0 ? (
          <EmptyState text={t("emptyState")} />
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
            {t("closedNotice")}
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
        {pending.length > 0 ? (
          <ul
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              margin: 0,
              padding: 0,
              listStyle: "none",
            }}
          >
            {pending.map((p) => (
              <PendingChip
                key={p.key}
                file={p.file}
                onRemove={() => onRemovePending(p.key)}
                disabled={sending}
              />
            ))}
          </ul>
        ) : null}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, MAX_BODY))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          placeholder={t("messagePlaceholder")}
          rows={2}
          aria-label={t("messageAria")}
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
        <input
          ref={fileInputRef}
          type="file"
          multiple
          // No accept filter — any file format is allowed. Size + count
          // caps still apply (10 MiB per file, 5 files per message).
          style={{ display: "none" }}
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) onFilesPicked(files);
            // Reset so picking the same file again still fires onChange.
            e.target.value = "";
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
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={onPickFiles}
              disabled={sending || attachLimit}
              aria-label={t("attachAria")}
              title={
                attachLimit
                  ? t("attachMax", { count: SUPPORT_ATTACHMENT_MAX_PER_MESSAGE })
                  : t("attachHint", {
                      limit: formatBytes(SUPPORT_ATTACHMENT_MAX_BYTES),
                    })
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 30,
                height: 30,
                borderRadius: 8,
                border: "1px solid var(--color-border, var(--border))",
                background: "transparent",
                color: "inherit",
                cursor: sending || attachLimit ? "not-allowed" : "pointer",
                opacity: sending || attachLimit ? 0.5 : 1,
                fontFamily: "inherit",
              }}
            >
              <PaperclipGlyph />
            </button>
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--color-fg-subtle, var(--fg-dim))",
              }}
            >
              {draft.length}/{MAX_BODY}
            </span>
          </div>
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              border: "1px solid var(--color-border, var(--border))",
              background: "var(--color-fg, var(--fg))",
              color: "var(--color-bg, var(--bg))",
              fontFamily: "inherit",
              fontSize: 13,
              cursor: canSend ? "pointer" : "not-allowed",
              opacity: canSend ? 1 : 0.5,
            }}
          >
            {sending ? t("sending") : t("send")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PendingChip({
  file,
  onRemove,
  disabled,
}: {
  file: File;
  onRemove: () => void;
  disabled: boolean;
}) {
  const t = useTranslations("supportChat");
  const isImage = file.type.startsWith("image/");
  return (
    <li
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 6px",
        borderRadius: 6,
        border: "1px solid var(--color-border, var(--border))",
        background: "var(--color-bg-subtle, var(--surface-2))",
        fontSize: 11,
        maxWidth: 220,
      }}
    >
      <span
        aria-hidden
        style={{
          fontSize: 10,
          padding: "1px 4px",
          borderRadius: 3,
          background: "var(--color-bg, var(--bg))",
          color: "var(--color-fg-muted, var(--fg-muted))",
          fontFamily: "var(--mono, monospace)",
        }}
      >
        {isImage ? "IMG" : "FILE"}
      </span>
      <span
        style={{
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          flex: 1,
        }}
        title={file.name}
      >
        {file.name}
      </span>
      <span style={{ color: "var(--color-fg-subtle, var(--fg-dim))" }}>
        {formatBytes(file.size)}
      </span>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={t("removeAria", { name: file.name })}
        style={{
          marginLeft: 2,
          width: 18,
          height: 18,
          borderRadius: 4,
          border: "0",
          background: "transparent",
          color: "inherit",
          cursor: disabled ? "not-allowed" : "pointer",
          fontFamily: "inherit",
          fontSize: 12,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </li>
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
  const t = useTranslations("supportChat");
  const locale = useLocale();
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
        gap: 4,
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
          {message.senderName ?? t("senderFallback")}
        </span>
      ) : null}
      {message.body.length > 0 ? (
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
      ) : null}
      {message.attachments.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            alignItems: align,
            width: "100%",
          }}
        >
          {message.attachments.map((a) => (
            <AttachmentTile key={a.id} attachment={a} mineAlign={fromUser} />
          ))}
        </div>
      ) : null}
      <span
        style={{
          fontSize: 10,
          color: "var(--color-fg-subtle, var(--fg-dim))",
          padding: "0 4px",
        }}
      >
        {formatTime(message.createdAt, locale)}
      </span>
    </div>
  );
}

function AttachmentTile({
  attachment,
  mineAlign,
}: {
  attachment: SupportAttachment;
  mineAlign: boolean;
}) {
  const url = `/api${attachment.url}`;
  const isImage = attachment.contentType.startsWith("image/");
  if (isImage) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        title={attachment.filename}
        style={{
          alignSelf: mineAlign ? "flex-end" : "flex-start",
          maxWidth: "100%",
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid var(--color-border, var(--border))",
          display: "block",
        }}
      >
        <img
          src={url}
          alt={attachment.filename}
          style={{
            display: "block",
            maxWidth: 240,
            maxHeight: 240,
            objectFit: "cover",
          }}
        />
      </a>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      title={attachment.filename}
      style={{
        alignSelf: mineAlign ? "flex-end" : "flex-start",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        borderRadius: 8,
        border: "1px solid var(--color-border, var(--border))",
        background: "var(--color-bg, var(--bg))",
        color: "var(--color-fg, var(--fg))",
        fontSize: 12,
        textDecoration: "none",
        maxWidth: "100%",
      }}
    >
      <span
        aria-hidden
        style={{
          fontSize: 10,
          padding: "1px 4px",
          borderRadius: 3,
          background: "var(--color-bg-subtle, var(--surface-2))",
          color: "var(--color-fg-muted, var(--fg-muted))",
          fontFamily: "var(--mono, monospace)",
        }}
      >
        {labelFor(attachment.contentType)}
      </span>
      <span
        style={{
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: 200,
        }}
      >
        {attachment.filename}
      </span>
      <span style={{ color: "var(--color-fg-subtle, var(--fg-dim))" }}>
        {formatBytes(attachment.sizeBytes)}
      </span>
    </a>
  );
}

function labelFor(mime: string): string {
  if (mime === "application/pdf") return "PDF";
  if (mime === "text/plain") return "TXT";
  if (mime.startsWith("image/")) return "IMG";
  return "FILE";
}

function formatTime(iso: string, locale: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const time = d.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
    if (sameDay) return time;
    const date = d.toLocaleDateString(locale, {
      day: "2-digit",
      month: "2-digit",
    });
    return `${date} ${time}`;
  } catch {
    return "";
  }
}
