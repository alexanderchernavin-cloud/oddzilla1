// /admin/emails/[id] — thread detail.
//
// Server-fetches the full thread (interleaved inbound + outbound
// messages) and hands off to a client component for the reply form,
// archive toggle, and mark-read action.

import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { ThreadClient } from "./thread-client";

interface ThreadMessage {
  direction: "inbound" | "outbound";
  id: string;
  who: string;
  whoName: string | null;
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  ts: string;
  status: "received" | "queued" | "sent" | "failed";
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
}

interface ThreadResponse {
  thread: ThreadSummary;
  messages: ThreadMessage[];
}

export const dynamic = "force-dynamic";

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await serverApi<ThreadResponse>(`/admin/emails/threads/${id}`);
  if (!data) notFound();

  return (
    <div>
      <div className="flex items-start gap-3">
        <Link
          href="/admin/emails"
          className="mt-1 text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          ← Inbox
        </Link>
      </div>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        {data.thread.subject}
      </h1>
      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
        with {data.thread.firstFrom ?? data.thread.firstTo ?? "—"} ·{" "}
        {data.thread.inboundCount + data.thread.outboundCount} message
        {data.thread.inboundCount + data.thread.outboundCount === 1 ? "" : "s"}
        {data.thread.archived && " · Archived"}
      </p>

      <ThreadClient
        threadId={id}
        initial={data}
      />
    </div>
  );
}
