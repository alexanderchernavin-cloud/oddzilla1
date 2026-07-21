"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CompetitionStatus, JoinCompetitionResponse } from "@oddzilla/types";
import { useTranslations } from "@/lib/i18n";

export function CompetitionJoinButton({
  competitionId,
  isAuthed,
  viewerJoined,
  status,
}: {
  competitionId: string;
  isAuthed: boolean;
  viewerJoined: boolean | null;
  status: CompetitionStatus;
}) {
  const router = useRouter();
  const t = useTranslations("competitions");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(Boolean(viewerJoined));

  if (!isAuthed) {
    return (
      <a
        href="/login"
        className="inline-flex items-center rounded-[10px] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-fg)] hover:opacity-90"
      >
        {t("signInToJoin")}
      </a>
    );
  }

  if (status === "ended") {
    return (
      <span className="inline-flex items-center rounded-[10px] border border-[var(--color-border-strong)] px-4 py-2 text-sm text-[var(--color-fg-muted)]">
        {t("competitionEnded")}
      </span>
    );
  }

  if (status === "draft") {
    return null;
  }

  if (joined) {
    return (
      <span className="inline-flex items-center gap-2 rounded-[10px] border border-[var(--color-border-strong)] px-4 py-2 text-sm font-semibold text-[var(--color-accent)]">
        {t("joinedBadge")}
      </span>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            const res = await fetch(
              `/api/community/competitions/${competitionId}/join`,
              { method: "POST", credentials: "include" },
            );
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as {
                error?: string;
              };
              setError(body.error ?? t("joinFailed"));
              return;
            }
            const data = (await res.json()) as JoinCompetitionResponse;
            void data;
            setJoined(true);
            router.refresh();
          } finally {
            setPending(false);
          }
        }}
        className="inline-flex items-center rounded-[10px] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-60"
      >
        {pending ? t("joining") : t("join")}
      </button>
      {error ? (
        <p className="text-xs text-[var(--color-danger)]">{error}</p>
      ) : null}
    </div>
  );
}
