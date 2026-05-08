"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function PublishButton({ competitionId }: { competitionId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            const res = await fetch(
              `/api/admin/competitions/${competitionId}/publish`,
              { method: "POST", credentials: "include" },
            );
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as {
                error?: string;
                message?: string;
              };
              setError(body.error ?? body.message ?? "Couldn't publish");
              return;
            }
            router.refresh();
          } finally {
            setPending(false);
          }
        }}
        className="rounded-[8px] bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-60"
      >
        {pending ? "Publishing…" : "Publish"}
      </button>
      {error ? (
        <span className="text-[11px] text-[var(--color-danger)]">{error}</span>
      ) : null}
    </div>
  );
}
