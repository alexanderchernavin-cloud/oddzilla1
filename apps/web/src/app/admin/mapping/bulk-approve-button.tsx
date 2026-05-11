"use client";

// Approve-all button for the mapping review queue. Lives next to the
// summary KPIs because the count is the headline information: clicking
// the button approves exactly that count of rows in a single
// transaction on the server (one UPDATE + one audit_log row).
//
// Only rendered when the user is viewing the pending tab AND there's
// at least one pending entry. The scope respects the active type
// filter, so "Approve all 412 pending matches" does what it says.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

interface Props {
  pendingCount: number;
  entityType?: string;
}

export function BulkApproveButton({ pendingCount, entityType }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (pendingCount === 0) return null;

  const label = entityType
    ? `Approve all ${pendingCount.toLocaleString()} pending ${entityType}${pendingCount === 1 ? "" : "s"}`
    : `Approve all ${pendingCount.toLocaleString()} pending`;

  const confirmText = entityType
    ? `Approve every pending ${entityType} mapping (${pendingCount.toLocaleString()} rows)? This cannot be undone via the queue — you'd have to mark individual rows back to rejected.`
    : `Approve every pending mapping across all entity types (${pendingCount.toLocaleString()} rows)? This cannot be undone via the queue — you'd have to mark individual rows back to rejected.`;

  const onClick = () => {
    if (typeof window !== "undefined" && !window.confirm(confirmText)) return;
    setError(null);
    startTransition(async () => {
      try {
        await clientApi<{ decision: string; count: number }>(
          "/admin/mapping/bulk-review",
          {
            method: "POST",
            body: JSON.stringify({
              decision: "approve",
              ...(entityType ? { entityType } : {}),
            }),
          },
        );
        router.refresh();
      } catch (err) {
        setError(
          err instanceof ApiFetchError ? err.body.message : "Bulk approve failed.",
        );
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-[8px] border border-[var(--color-positive)] bg-[var(--color-positive)] px-4 py-2 text-xs uppercase tracking-[0.15em] text-[var(--color-bg)] hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Approving…" : label}
      </button>
      {error ? (
        <p role="alert" className="text-xs text-[var(--color-negative)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
