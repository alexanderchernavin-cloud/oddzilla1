// /admin/emails — backoffice inbox list.
//
// Server-rendered list of threads with filter tabs (Inbox / Unread /
// Archived / All) and a search box. Click a thread to open the detail
// view. "New email" link routes to /admin/emails/new for an admin-
// initiated outbound conversation.

import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import { EmailsClient } from "./emails-client";

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

interface ListResponse {
  threads: ThreadSummary[];
  nextCursor: string | null;
}

export const metadata = {
  title: "Emails — Oddzilla Admin",
};

export const dynamic = "force-dynamic";

export default async function EmailsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string }>;
}) {
  const params = await searchParams;
  const filter = ["inbox", "unread", "archived", "all"].includes(params.filter ?? "")
    ? (params.filter as "inbox" | "unread" | "archived" | "all")
    : "inbox";
  const q = params.q?.trim() ?? "";

  const qs = new URLSearchParams({ filter });
  if (q) qs.set("q", q);
  const initial = await serverApi<ListResponse>(`/admin/emails/threads?${qs}`);
  const threads = initial?.threads ?? [];
  const nextCursor = initial?.nextCursor ?? null;

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Emails</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">
            Inbox for inbound mail received via SendGrid Inbound Parse, plus
            replies sent from this dashboard. Send a new email with{" "}
            <strong>New email</strong>; click a thread to view and reply.
          </p>
        </div>
        <Link
          href="/admin/emails/new"
          className="inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-card)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-bg-hover)]"
        >
          New email
        </Link>
      </div>

      <EmailsClient
        initialThreads={threads}
        initialCursor={nextCursor}
        initialFilter={filter}
        initialQuery={q}
      />
    </div>
  );
}
