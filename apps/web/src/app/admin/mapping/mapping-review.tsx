"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface MappingEntry {
  id: string;
  entityType: string;
  provider: string;
  providerUrn: string;
  createdEntityId: string | null;
  status: "pending" | "approved" | "rejected";
  rawPayload: unknown;
  createdAt: string;
  reviewedAt: string | null;
}

export function MappingReview({
  entries,
  canAct,
}: {
  entries: MappingEntry[];
  canAct: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  function decide(id: string, decision: "approve" | "reject") {
    setErrorById((m) => {
      const { [id]: _, ...rest } = m;
      return rest;
    });
    startTransition(async () => {
      try {
        await clientApi(`/admin/mapping/${id}/review`, {
          method: "POST",
          body: JSON.stringify({ decision }),
        });
        router.refresh();
      } catch (err) {
        setErrorById((m) => ({
          ...m,
          [id]: err instanceof ApiFetchError ? err.body.message : "Action failed.",
        }));
      }
    });
  }

  return (
    <ul className="divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
      {entries.map((e) => (
        <li key={e.id} className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                <span>{e.entityType}</span>
                <span>·</span>
                <span>{e.provider}</span>
                <span>·</span>
                <time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString()}</time>
              </div>
              <p className="mt-2 break-all font-mono text-sm">{e.providerUrn}</p>
              {e.createdEntityId ? (
                <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                  Created local id <span className="font-mono">{e.createdEntityId}</span>
                </p>
              ) : null}

              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
                  Raw payload
                </summary>
                <pre className="mt-2 overflow-x-auto rounded-[8px] bg-[var(--color-bg-elevated)] p-3 text-xs text-[var(--color-fg-muted)]">
                  {JSON.stringify(e.rawPayload, null, 2)}
                </pre>
              </details>
            </div>

            {canAct ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => decide(e.id, "approve")}
                  className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] hover:border-[var(--color-positive)] hover:text-[var(--color-positive)] disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => decide(e.id, "reject")}
                  className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] hover:border-[var(--color-negative)] hover:text-[var(--color-negative)] disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            ) : (
              <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                {e.status}
              </span>
            )}
          </div>

          {errorById[e.id] ? (
            <p role="alert" className="mt-3 text-sm text-[var(--color-negative)]">
              {errorById[e.id]}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
