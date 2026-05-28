"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiFetchError, clientApi } from "@/lib/api-client";
import type {
  AdminSupportThreadDetail,
  SupportMessage,
} from "@oddzilla/types";

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
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Mark this thread read on mount whenever there are bettor-side
  // messages the admin hasn't acked. Fire-and-forget; the next 60 s
  // sidebar poll will reconcile if this errors.
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

  // Auto-scroll on new messages.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages.length]);

  async function onReply(e: FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    if (thread.status !== "open") return;
    setSending(true);
    setError(null);
    try {
      const res = await clientApi<{ ok: boolean; message: SupportMessage }>(
        `/admin/support/threads/${threadId}/reply`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
        },
      );
      setDraft("");
      setMessages((prev) => {
        if (prev.some((m) => m.id === res.message.id)) return prev;
        return [...prev, res.message];
      });
      // refresh thread summary so unreadUser bumps + lastMessageAt updates.
      await refresh();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiFetchError) {
        setError(err.body.message || err.body.error || "send_failed");
      } else {
        setError("Network error.");
      }
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
        {error && (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between">
          <span className="text-xs text-[var(--color-fg-subtle)]">
            {draft.length}/4000 · pressing Enter sends, Shift+Enter for newline
          </span>
          <button
            type="submit"
            disabled={
              sending || draft.trim().length === 0 || thread.status !== "open"
            }
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
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-[var(--color-fg)]">
        {message.body}
      </pre>
    </div>
  );
}
