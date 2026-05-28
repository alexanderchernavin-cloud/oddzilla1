// /admin/support — backoffice inbox for the live support chat.
//
// SSR-renders the initial thread list; the client component handles
// filter tabs, search, and pagination.

import { serverApi } from "@/lib/server-fetch";
import type { AdminSupportThreadSummary } from "@oddzilla/types";
import { SupportInboxClient } from "./support-client";

interface ListResponse {
  threads: AdminSupportThreadSummary[];
  nextCursor: string | null;
}

export const metadata = {
  title: "Support — Oddzilla Admin",
};

export const dynamic = "force-dynamic";

export default async function AdminSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string }>;
}) {
  const params = await searchParams;
  const filter = ["open", "unread", "closed", "all"].includes(params.filter ?? "")
    ? (params.filter as "open" | "unread" | "closed" | "all")
    : "open";
  const q = params.q?.trim() ?? "";

  const qs = new URLSearchParams({ filter });
  if (q) qs.set("q", q);
  const initial = await serverApi<ListResponse>(`/admin/support/threads?${qs}`);
  const threads = initial?.threads ?? [];
  const nextCursor = initial?.nextCursor ?? null;

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Support</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">
            Live chat between bettors and the ops team. Replies fan out
            instantly to the bettor&apos;s open browser tab via the shared
            WebSocket. Closed threads stay around for audit; opening a new
            message restarts the conversation.
          </p>
        </div>
      </div>

      <SupportInboxClient
        initialThreads={threads}
        initialCursor={nextCursor}
        initialFilter={filter}
        initialQuery={q}
      />
    </div>
  );
}
