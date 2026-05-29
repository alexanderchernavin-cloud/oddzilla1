"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiFetchError, clientApi } from "@/lib/api-client";
import type {
  AdminSupportThreadDetail,
  SupportAttachment,
  SupportMessage,
} from "@oddzilla/types";
// Deep subpath for value imports — Next's webpack can't chase every
// `export * from './*.js'` re-export in the barrel index, so we hit
// the leaf module directly. Mirrors the @oddzilla/types/money pattern.
import {
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENT_MAX_PER_MESSAGE,
} from "@oddzilla/types/support";

interface PendingFile {
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

export function SupportThreadClient({
  threadId,
  initial,
}: {
  threadId: string;
  initial: AdminSupportThreadDetail;
}) {
  const router = useRouter();
  const [thread, setThread] = useState(initial.thread);
  const [messages, setMessages] = useState(initial.messages);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (thread.unreadAdmin === 0) return;
    let cancelled = false;
    (async () => {
      try {
        await clientApi(`/admin/support/threads/${threadId}/mark-read`, {
          method: "POST",
        });
        if (cancelled) return;
        setThread((t) => ({ ...t, unreadAdmin: 0 }));
      } catch {
        // best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId, thread.unreadAdmin]);

  const refresh = useCallback(async () => {
    const data = await clientApi<AdminSupportThreadDetail>(
      `/admin/support/threads/${threadId}`,
    );
    setThread(data.thread);
    setMessages(data.messages);
  }, [threadId]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages.length]);

  const pickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const list = Array.from(incoming);
    if (list.length === 0) return;
    setError(null);
    setPending((prev) => {
      const next = [...prev];
      for (const f of list) {
        if (next.length >= SUPPORT_ATTACHMENT_MAX_PER_MESSAGE) {
          setError(
            `Up to ${SUPPORT_ATTACHMENT_MAX_PER_MESSAGE} files per reply.`,
          );
          break;
        }
        if (f.size > SUPPORT_ATTACHMENT_MAX_BYTES) {
          setError(
            `${f.name} is over the ${formatBytes(SUPPORT_ATTACHMENT_MAX_BYTES)} limit.`,
          );
          continue;
        }
        if (f.size === 0) {
          setError(`${f.name} is empty.`);
          continue;
        }
        next.push({ key: nextPendingKey(), file: f });
      }
      return next;
    });
  }, []);

  const removePending = useCallback((key: string) => {
    setPending((prev) => prev.filter((p) => p.key !== key));
  }, []);

  async function onReply(e: FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (sending) return;
    if (!body && pending.length === 0) return;
    if (thread.status !== "open") return;
    setSending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("body", body);
      for (const p of pending) fd.append("files", p.file, p.file.name);
      const res = await fetch(`/api/admin/support/threads/${threadId}/reply`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        let msg = "send_failed";
        try {
          const body = (await res.json()) as {
            error?: string;
            message?: string;
          };
          msg = body.message || body.error || msg;
        } catch {
          // non-JSON
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as { message: SupportMessage };
      setDraft("");
      setPending([]);
      setMessages((prev) => {
        if (prev.some((m) => m.id === data.message.id)) return prev;
        return [...prev, data.message];
      });
      await refresh();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setSending(false);
    }
  }

  async function toggleStatus() {
    const action = thread.status === "open" ? "close" : "reopen";
    setActionBusy(action);
    setError(null);
    try {
      await clientApi(`/admin/support/threads/${threadId}/${action}`, {
        method: "POST",
      });
      await refresh();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiFetchError) {
        setError(err.body.message || err.body.error || "action_failed");
      } else {
        setError("Network error.");
      }
    } finally {
      setActionBusy(null);
    }
  }

  const canReply =
    thread.status === "open" &&
    !sending &&
    (draft.trim().length > 0 || pending.length > 0);
  const attachLimit = pending.length >= SUPPORT_ATTACHMENT_MAX_PER_MESSAGE;

  return (
    <div className="mt-6 space-y-4">
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={toggleStatus}
          disabled={actionBusy !== null}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-card)] px-3 py-1.5 text-sm hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
        >
          {thread.status === "open" ? "Close thread" : "Reopen thread"}
        </button>
      </div>

      <div
        ref={listRef}
        className="max-h-[60vh] space-y-3 overflow-y-auto rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4"
      >
        {messages.length === 0 ? (
          <p className="text-sm italic text-[var(--color-fg-subtle)]">
            No messages yet.
          </p>
        ) : (
          messages.map((m) => <MessageRow key={m.id} message={m} />)
        )}
      </div>

      <form
        onSubmit={onReply}
        className="space-y-2 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4"
      >
        <div className="text-xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
          Reply
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 4000))}
          rows={5}
          placeholder={
            thread.status === "open"
              ? "Type your reply…"
              : "Reopen the thread to reply."
          }
          disabled={thread.status !== "open"}
          className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm outline-none focus:border-[var(--color-fg)] disabled:opacity-60"
        />
        {pending.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {pending.map((p) => (
              <li
                key={p.key}
                className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
              >
                <span className="font-mono text-[10px] text-[var(--color-fg-muted)]">
                  {p.file.type.startsWith("image/") ? "IMG" : "FILE"}
                </span>
                <span
                  className="max-w-[200px] truncate"
                  title={p.file.name}
                >
                  {p.file.name}
                </span>
                <span className="text-[var(--color-fg-subtle)]">
                  {formatBytes(p.file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => removePending(p.key)}
                  disabled={sending}
                  aria-label={`Remove ${p.file.name}`}
                  className="ml-1 text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          // No accept filter — any format goes, size + count caps still apply.
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) addFiles(files);
            e.target.value = "";
          }}
        />
        {error && (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={pickFiles}
              disabled={
                sending || attachLimit || thread.status !== "open"
              }
              title={
                attachLimit
                  ? `Max ${SUPPORT_ATTACHMENT_MAX_PER_MESSAGE} files`
                  : `Attach files (max ${formatBytes(SUPPORT_ATTACHMENT_MAX_BYTES)} each)`
              }
              className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden
              >
                <path
                  d="M10.5 4.5L6 9a1.5 1.5 0 0 0 2.121 2.121L13 6.243a3 3 0 1 0-4.243-4.243L4 6.757a4.5 4.5 0 1 0 6.364 6.364L14 9.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>Attach</span>
            </button>
            <span className="text-xs text-[var(--color-fg-subtle)]">
              {draft.length}/4000
            </span>
          </div>
          <button
            type="submit"
            disabled={!canReply}
            className="rounded-md bg-[var(--color-fg)] px-4 py-1.5 text-sm font-medium text-[var(--color-bg)] disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send reply"}
          </button>
        </div>
      </form>
    </div>
  );
}

function MessageRow({ message }: { message: SupportMessage }) {
  const fromUser = message.senderKind === "user";
  const fromSystem = message.senderKind === "system";
  const date = new Date(message.createdAt).toLocaleString();
  return (
    <div
      className={`rounded-[10px] border p-3 ${
        fromUser
          ? "border-[var(--color-border)] bg-[var(--color-bg)]"
          : fromSystem
            ? "border-transparent bg-transparent"
            : "border-[var(--color-border)] bg-[var(--color-bg-hover)] ml-8"
      }`}
    >
      <div className="mb-1 flex items-baseline justify-between gap-3 text-xs text-[var(--color-fg-subtle)]">
        <span>
          {fromSystem
            ? "System"
            : fromUser
              ? "Bettor"
              : (message.senderName ?? "Support")}
        </span>
        <span>{date}</span>
      </div>
      {message.body.length > 0 && (
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-[var(--color-fg)]">
          {message.body}
        </pre>
      )}
      {message.attachments.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {message.attachments.map((a) => (
            <AttachmentTile key={a.id} attachment={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function AttachmentTile({ attachment }: { attachment: SupportAttachment }) {
  const url = `/api${attachment.url}`;
  const isImage = attachment.contentType.startsWith("image/");
  if (isImage) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        title={attachment.filename}
        className="block overflow-hidden rounded-md border border-[var(--color-border)]"
      >
        <img
          src={url}
          alt={attachment.filename}
          className="block max-h-48 max-w-xs object-cover"
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
      className="inline-flex max-w-full items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs no-underline hover:bg-[var(--color-bg-hover)]"
    >
      <span className="rounded bg-[var(--color-bg-card)] px-1 py-0.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
        {labelFor(attachment.contentType)}
      </span>
      <span className="max-w-[220px] truncate">{attachment.filename}</span>
      <span className="text-[var(--color-fg-subtle)]">
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
