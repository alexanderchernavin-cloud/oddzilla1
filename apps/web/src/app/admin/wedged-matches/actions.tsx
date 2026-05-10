"use client";

// Client-side action buttons for the wedged-matches admin page. The
// page itself is server-rendered so the role guard runs before the
// fetch; these buttons just POST to the API and reload the route.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

interface ActionsProps {
  count: number;
}

// "Refresh all" pill in the page header. Disabled when the list is
// empty so a stray click can't burn Oddin REST quota for nothing.
export function WedgedMatchesActions({ count }: ActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<number | null>(null);

  function refreshAll() {
    setError(null);
    setQueued(null);
    startTransition(async () => {
      try {
        const res = await clientApi<{ ok: boolean; count: number }>(
          "/admin/wedged-matches/refresh-all",
          { method: "POST", body: JSON.stringify({}) },
        );
        setQueued(res.count);
        // Give the feed-ingester a couple seconds to apply the first
        // few REST refreshes before refetching — RefreshFromFixture is
        // synchronous in the LISTEN loop but rate-limited by Oddin so
        // big batches take a while. The page is still useful re-rendered
        // mid-burst (rows disappear as Oddin returns terminal status).
        setTimeout(() => router.refresh(), 2_500);
      } catch (e) {
        setError(
          e instanceof ApiFetchError ? e.body.message : "Refresh failed.",
        );
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={refreshAll}
        disabled={count === 0 || pending}
        className="rounded-[8px] border border-[var(--color-accent)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:bg-[color-mix(in_oklab,var(--color-accent)_10%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Queuing…" : `Refresh all (${count})`}
      </button>
      {queued != null ? (
        <span className="text-[11px] text-[var(--color-fg-muted)]">
          queued {queued} URN(s) for REST refresh
        </span>
      ) : null}
      {error ? (
        <span className="text-[11px] text-[var(--color-negative,#dc2626)]">
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface RefreshOneProps {
  matchId: string;
  disabled?: boolean;
}

// Per-row refresh button. Disabled when the match has no provider URN
// (auto-mapper fell back to a placeholder), which can't be refreshed.
export function RefreshOne({ matchId, disabled }: RefreshOneProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    setError(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/wedged-matches/${matchId}/refresh`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        // Same 2.5s settle as the bulk action — feed-ingester needs a
        // tick to call RefreshFromFixture and let UpsertMatch apply.
        setTimeout(() => router.refresh(), 2_500);
      } catch (e) {
        setError(
          e instanceof ApiFetchError ? e.body.message : "Refresh failed.",
        );
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={refresh}
        disabled={disabled || pending}
        className="rounded-[6px] border border-[var(--color-border)] px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] hover:bg-[var(--color-bg-subtle)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Refreshing…" : "Refresh from REST"}
      </button>
      {error ? (
        <span className="text-[11px] text-[var(--color-negative,#dc2626)]">
          {error}
        </span>
      ) : null}
    </div>
  );
}
