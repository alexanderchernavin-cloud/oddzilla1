"use client";

// Operator labels on the bettor card. Every chip is a toggle; each
// toggle PATCHes the full label set (the API replaces, not appends) and
// is audit-logged as user.update with before/after labels. Optimistic:
// the chip flips immediately and rolls back on error.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BETTOR_LABELS, type BettorLabel } from "@oddzilla/types/bettor-labels";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { LabelChip } from "../label-chip";

export function LabelsEditor({
  userId,
  initial,
}: {
  userId: string;
  initial: string[];
}) {
  const router = useRouter();
  const [labels, setLabels] = useState<BettorLabel[]>(
    initial.filter((l): l is BettorLabel =>
      (BETTOR_LABELS as readonly string[]).includes(l),
    ),
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle(label: BettorLabel) {
    const prev = labels;
    const next = prev.includes(label)
      ? prev.filter((l) => l !== label)
      : BETTOR_LABELS.filter((l) => l === label || prev.includes(l));
    setLabels(next);
    setError(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/users/${userId}`, {
          method: "PATCH",
          body: JSON.stringify({ labels: next }),
        });
        router.refresh();
      } catch (err) {
        setLabels(prev);
        setError(err instanceof ApiFetchError ? err.body.message : "Save failed");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {BETTOR_LABELS.map((label) => {
          const active = labels.includes(label);
          return (
            <button
              key={label}
              type="button"
              onClick={() => toggle(label)}
              disabled={pending}
              aria-pressed={active}
              title={active ? `Remove ${label}` : `Add ${label}`}
              className="rounded-full disabled:opacity-60"
              style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
            >
              <LabelChip label={label} active={active} size="md" />
            </button>
          );
        })}
      </div>
      <p className="text-xs text-[var(--color-fg-subtle)]">
        Click to toggle. Saved immediately and audit-logged. Labels are
        descriptive — limits live in the constraints card.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-[var(--color-negative)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
