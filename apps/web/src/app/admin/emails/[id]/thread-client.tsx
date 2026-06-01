"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiFetchError, clientApi } from "@/lib/api-client";

interface ThreadMessage {
  direction: "inbound" | "outbound";
  id: string;
  who: string;
  whoName: string | null;
  toAddress: string | null;
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  ts: string;
  status: "received" | "queued" | "sent" | "failed";
  failureReason?: string | null;
  attachments?: Array<{ filename: string; contentType: string | null; sizeBytes: number }>;
  spamScore?: number | null;
}

interface ThreadSummary {
  id: string;
  subject: string;
  firstFrom: string | null;
  firstTo: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  inboundCount: number;
  outboundCount: number;
  unreadInbound: number;
  archived: boolean;
  preview: string | null;
  hasFailedOutbound: boolean;
}

interface ThreadResponse {
  thread: ThreadSummary;
  messages: ThreadMessage[];
}

export function ThreadClient({
  threadId,
  initial,
}: {
  threadId: string;
  initial: ThreadResponse;
}) {
  const router = useRouter();
  const [thread, setThread] = useState(initial.thread);
  const [messages, setMessages] = useState(initial.messages);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  // Auto-mark-read on mount when there are unread inbound messages.
  // Fire-and-forget; if the user immediately navigates away the badge
  // stays stale until the next 60 s sidebar poll.
  useEffect(() => {
    if (thread.unreadInbound === 0) return;
    let cancelled = false;
    (async () => {
      try {
        await clientApi(`/admin/emails/threads/${threadId}/mark-read`, {
          method: "POST",
        });
        if (cancelled) return;
        setThread((t) => ({ ...t, unreadInbound: 0 }));
      } catch {
        // Best-effort — don't surface to the operator.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId, thread.unreadInbound]);

  async function refresh() {
    const data = await clientApi<ThreadResponse>(`/admin/emails/threads/${threadId}`);
    setThread(data.thread);
    setMessages(data.messages);
  }

  async function onReply(e: FormEvent) {
    e.preventDefault();
    if (!replyText.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      await clientApi(`/admin/emails/threads/${threadId}/reply`, {
        method: "POST",
        body: JSON.stringify({ textBody: replyText }),
      });
      setReplyText("");
      await refresh();
    } catch (err) {
      if (err instanceof ApiFetchError) {
        setSendError(err.body.message || err.body.error || "send_failed");
      } else {
        setSendError("Network error.");
      }
    } finally {
      setSending(false);
    }
  }

  async function toggleArchive() {
    setActionBusy(thread.archived ? "unarchive" : "archive");
    try {
      await clientApi(
        `/admin/emails/threads/${threadId}/${thread.archived ? "unarchive" : "archive"}`,
        { method: "POST" },
      );
      setThread((t) => ({ ...t, archived: !t.archived }));
      router.refresh();
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={toggleArchive}
          disabled={actionBusy !== null}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-card)] px-3 py-1.5 text-sm hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
        >
          {thread.archived ? "Unarchive" : "Archive"}
        </button>
      </div>

      <ol className="space-y-4">
        {messages.map((m) => (
          <li key={`${m.direction}-${m.id}`}>
            <MessageCard message={m} />
          </li>
        ))}
      </ol>

      <form onSubmit={onReply} className="space-y-2 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4">
        <div className="text-xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
          Reply
        </div>
        <textarea
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          rows={6}
          placeholder="Type your reply…"
          className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm outline-none focus:border-[var(--color-fg)]"
        />
        {sendError && (
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {sendError}
          </p>
        )}
        <div className="flex items-center justify-between">
          <span className="text-xs text-[var(--color-fg-subtle)]">
            Goes to{" "}
            <code>{lastInboundFrom(messages) ?? thread.firstFrom ?? "—"}</code>
          </span>
          <button
            type="submit"
            disabled={sending || replyText.trim().length === 0}
            className="rounded-md bg-[var(--color-fg)] px-4 py-1.5 text-sm font-medium text-[var(--color-bg)] disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send reply"}
          </button>
        </div>
      </form>
    </div>
  );
}

function lastInboundFrom(messages: ThreadMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.direction === "inbound") return messages[i]!.who;
  }
  return null;
}

function MessageCard({ message }: { message: ThreadMessage }) {
  const date = new Date(message.ts).toLocaleString();
  const inbound = message.direction === "inbound";
  return (
    <div
      className={`rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4 ${
        inbound ? "" : "ml-8"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <div className="min-w-0">
          <div className="font-medium">
            {inbound ? (
              <>
                {message.whoName ? `${message.whoName} ` : ""}
                <span className="text-[var(--color-fg-muted)]">{message.who}</span>
              </>
            ) : (
              <>
                <span className="text-[var(--color-fg-muted)]">to</span>{" "}
                {message.who}
              </>
            )}
          </div>
          {inbound && message.toAddress && (
            <div className="mt-0.5 break-all text-xs text-[var(--color-fg-subtle)]">
              <span className="text-[var(--color-fg-muted)]">To</span>{" "}
              {message.toAddress}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--color-fg-subtle)]">
          {!inbound && (
            <span
              className={`rounded-sm px-1.5 py-0.5 ${
                message.status === "failed"
                  ? "bg-[var(--color-danger)] text-white"
                  : message.status === "queued"
                    ? "bg-[var(--color-bg-hover)] text-[var(--color-fg-muted)]"
                    : "bg-[var(--color-bg-hover)] text-[var(--color-fg-subtle)]"
              }`}
            >
              {message.status}
            </span>
          )}
          {typeof message.spamScore === "number" && message.spamScore > 4 && (
            <span className="rounded-sm bg-amber-200 px-1.5 py-0.5 text-[10px] text-amber-900 dark:bg-amber-900 dark:text-amber-100">
              spam {message.spamScore.toFixed(1)}
            </span>
          )}
          <span>{date}</span>
        </div>
      </div>
      {!inbound && message.status === "failed" && message.failureReason && (
        <div
          className="mt-3 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger)]/10 p-3 text-xs leading-relaxed text-[var(--color-danger)]"
          role="alert"
        >
          <div className="font-semibold uppercase tracking-wider">Delivery failed</div>
          <div className="mt-1 break-words font-mono text-[var(--color-fg)]">
            {message.failureReason}
          </div>
        </div>
      )}
      {message.textBody ? (
        <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-[var(--color-fg)]">
          {message.textBody}
        </pre>
      ) : message.htmlBody ? (
        // HTML render is opt-in; we show plain "this message is HTML"
        // by default so a malicious incoming HTML body can't run JS.
        // The body is escaped because we'd need an iframe sandbox to
        // render safely. For now the operator sees the visible text.
        <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm text-[var(--color-fg-muted)]">
          {stripHtml(message.htmlBody)}
        </pre>
      ) : (
        <p className="mt-3 text-sm italic text-[var(--color-fg-subtle)]">
          (empty body)
        </p>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {message.attachments.map((a, i) => (
            <span
              key={i}
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg-hover)] px-2 py-1 text-xs"
              title="Attachment metadata only — file contents are not stored."
            >
              {a.filename} · {a.contentType ?? "?"} · {prettyBytes(a.sizeBytes)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
