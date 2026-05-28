"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { clientApi } from "@/lib/api-client";
import type { AdminSupportThreadSummary } from "@oddzilla/types";

interface ListResponse {
  threads: AdminSupportThreadSummary[];
  nextCursor: string | null;
}

type Filter = "open" | "unread" | "closed" | "all";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "open", label: "Open" },
  { key: "unread", label: "Unread" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

export function SupportInboxClient({
  initialThreads,
  initialCursor,
  initialFilter,
  initialQuery,
}: {
  initialThreads: AdminSupportThreadSummary[];
  initialCursor: string | null;
  initialFilter: Filter;
  initialQuery: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [threads, setThreads] = useState(initialThreads);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState(initialQuery);

  useEffect(() => {
    setThreads(initialThreads);
    setCursor(initialCursor);
  }, [initialThreads, initialCursor]);

  const submitSearch = useCallback(
    (next: string) => {
      const sp = new URLSearchParams(params);
      sp.set("filter", initialFilter);
      if (next.trim()) sp.set("q", next.trim());
      else sp.delete("q");
      router.push(`/admin/support?${sp.toString()}`);
    },
    [router, params, initialFilter],
  );

  const setFilter = (next: Filter) => {
    const sp = new URLSearchParams();
    sp.set("filter", next);
    if (search.trim()) sp.set("q", search.trim());
    router.push(`/admin/support?${sp.toString()}`);
  };

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const qs = new URLSearchParams({ filter: initialFilter, cursor });
      if (initialQuery) qs.set("q", initialQuery);
      const data = await clientApi<ListResponse>(
        `/admin/support/threads?${qs}`,
      );
      setThreads((prev) => [...prev, ...data.threads]);
      setCursor(data.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, initialFilter, initialQuery]);

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-bg-card)] p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-[6px] px-3 py-1 text-sm ${
                f.key === initialFilter
                  ? "bg-[var(--color-fg)] text-[var(--color-bg)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <form
          className="ml-auto flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submitSearch(search);
          }}
        >
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subject, email or nickname"
            className="h-8 w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-card)] px-3 text-sm outline-none focus:border-[var(--color-fg)]"
          />
        </form>
      </div>

      {threads.length === 0 ? (
        <p className="mt-8 text-sm text-[var(--color-fg-muted)]">
          {initialFilter === "unread"
            ? "Inbox zero — no unread bettor messages."
            : initialFilter === "closed"
              ? "No closed conversations."
              : "Nothing here yet. New conversations appear when bettors send a message from the storefront widget."}
        </p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          <ul className="divide-y divide-[var(--color-border)]">
            {threads.map((t) => (
              <ThreadRow key={t.id} thread={t} />
            ))}
          </ul>
        </div>
      )}

      {cursor && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-card)] px-3 py-1.5 text-sm hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

function ThreadRow({ thread }: { thread: AdminSupportThreadSummary }) {
  const date = thread.lastMessageAt
    ? new Date(thread.lastMessageAt).toLocaleString()
    : "";
  const counterpart =
    thread.userNickname && thread.userNickname.length > 0
      ? `${thread.userNickname} · ${thread.userEmail}`
      : thread.userEmail;
  const unread = thread.unreadAdmin;

  return (
    <li>
      <Link
        href={`/admin/support/${thread.id}`}
        className="block px-4 py-3 hover:bg-[var(--color-bg-hover)]"
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span
                className={`truncate text-sm ${
                  unread > 0
                    ? "font-semibold text-[var(--color-fg)]"
                    : "text-[var(--color-fg)]"
                }`}
              >
                {counterpart}
              </span>
              {unread > 0 && (
                <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[var(--color-fg)] px-1 text-[10px] font-semibold text-[var(--color-bg)]">
                  {unread}
                </span>
              )}
              {thread.status === "closed" && (
                <span className="rounded-sm bg-[var(--color-bg-hover)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-fg-subtle)]">
                  Closed
                </span>
              )}
            </div>
            <div
              className={`mt-0.5 truncate text-sm ${
                unread > 0
                  ? "font-medium text-[var(--color-fg)]"
                  : "text-[var(--color-fg-muted)]"
              }`}
            >
              {thread.subject ?? "—"}
            </div>
            {thread.preview && (
              <div className="mt-0.5 truncate text-xs text-[var(--color-fg-subtle)]">
                {thread.preview}
              </div>
            )}
          </div>
          <div className="shrink-0 text-right">
            <div className="whitespace-nowrap text-xs text-[var(--color-fg-subtle)]">
              {date}
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}
