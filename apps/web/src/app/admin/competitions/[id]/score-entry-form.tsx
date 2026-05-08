"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Inline score-entry form per match on the admin detail page.
// Triggers POST /admin/competitions/:id/matches/:matchId/score, which
// flips the match to status=done and runs scoreMatchPredictions.

export function ScoreEntryForm({
  competitionId,
  matchId,
  teamA,
  teamB,
  initialScoreA,
  initialScoreB,
  alreadyScored,
}: {
  competitionId: string;
  matchId: string;
  teamA: string;
  teamB: string;
  initialScoreA: number | null;
  initialScoreB: number | null;
  alreadyScored: boolean;
}) {
  const router = useRouter();
  const [scoreA, setScoreA] = useState<string>(
    initialScoreA !== null ? String(initialScoreA) : "",
  );
  const [scoreB, setScoreB] = useState<string>(
    initialScoreB !== null ? String(initialScoreB) : "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    scoredPredictions: number;
    affectedParticipants: number;
  } | null>(null);

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        setResult(null);
        try {
          const a = parseInt(scoreA, 10);
          const b = parseInt(scoreB, 10);
          if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) {
            setError("Scores must be 0 or higher");
            return;
          }
          const res = await fetch(
            `/api/admin/competitions/${competitionId}/matches/${matchId}/score`,
            {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ scoreA: a, scoreB: b }),
            },
          );
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              error?: string;
              message?: string;
            };
            setError(body.error ?? body.message ?? "Couldn't score match");
            return;
          }
          const data = (await res.json()) as {
            scoredPredictions: number;
            affectedParticipants: number;
          };
          setResult(data);
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      <ScoreInput
        id={`score-a-${matchId}`}
        label={teamA}
        value={scoreA}
        onChange={setScoreA}
      />
      <span className="pb-2 text-sm text-[var(--color-fg-subtle)]">–</span>
      <ScoreInput
        id={`score-b-${matchId}`}
        label={teamB}
        value={scoreB}
        onChange={setScoreB}
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-[8px] bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-60"
      >
        {pending ? "Scoring…" : alreadyScored ? "Re-score" : "Settle"}
      </button>
      {result ? (
        <span className="text-[11px] text-[var(--color-accent)]">
          Scored {result.scoredPredictions} prediction
          {result.scoredPredictions === 1 ? "" : "s"} · {result.affectedParticipants}{" "}
          participant{result.affectedParticipants === 1 ? "" : "s"} updated
        </span>
      ) : null}
      {error ? (
        <span className="text-[11px] text-[var(--color-danger)]">{error}</span>
      ) : null}
    </form>
  );
}

function ScoreInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex flex-col text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]"
    >
      <span className="max-w-[140px] truncate">{label}</span>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={999}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`${label} score`}
        className="mt-1 h-9 w-16 rounded-[6px] border border-[var(--color-border-strong)] bg-[var(--color-bg-base)] px-2 text-center text-sm text-[var(--color-fg)]"
      />
    </label>
  );
}
