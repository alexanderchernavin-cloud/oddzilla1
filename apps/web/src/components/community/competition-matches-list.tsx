"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type {
  CompetitionMatchRow,
  CompetitionType,
  CreatePredictionResponse,
  ViewerPrediction,
} from "@oddzilla/types";

export function CompetitionMatchesList({
  competitionId,
  competitionType,
  matches,
  isAuthed,
  viewerJoined,
}: {
  competitionId: string;
  competitionType: CompetitionType;
  matches: CompetitionMatchRow[];
  isAuthed: boolean;
  viewerJoined: boolean;
}) {
  if (matches.length === 0) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">
        No matches added to this competition yet.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {matches.map((m) => (
        <MatchRow
          key={m.id}
          competitionId={competitionId}
          competitionType={competitionType}
          match={m}
          isAuthed={isAuthed}
          viewerJoined={viewerJoined}
        />
      ))}
    </ul>
  );
}

function MatchRow({
  competitionId,
  competitionType,
  match: m,
  isAuthed,
  viewerJoined,
}: {
  competitionId: string;
  competitionType: CompetitionType;
  match: CompetitionMatchRow;
  isAuthed: boolean;
  viewerJoined: boolean;
}) {
  const locked = isPredictionLocked(m);
  const canPredict = isAuthed && viewerJoined && !locked && !m.cancelled;
  return (
    <li className="rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            {m.league || "—"} · {new Date(m.kickoffAt).toLocaleString()}
          </div>
          <div className="mt-1 text-sm font-medium text-[var(--color-fg)]">
            {m.teamA} <span className="text-[var(--color-fg-subtle)]">vs</span>{" "}
            {m.teamB}
          </div>
        </div>
        <MatchStatusPill match={m} />
      </div>
      {canPredict ? (
        <PredictionForm
          competitionId={competitionId}
          competitionType={competitionType}
          match={m}
        />
      ) : m.viewerPrediction ? (
        <ViewerPredictionRow prediction={m.viewerPrediction} />
      ) : !isAuthed ? (
        <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
          Sign in to make predictions.
        </p>
      ) : !viewerJoined ? (
        <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
          Join the competition to predict this match.
        </p>
      ) : null}
    </li>
  );
}

function MatchStatusPill({ match }: { match: CompetitionMatchRow }) {
  if (match.cancelled) {
    return <Pill tone="muted">Cancelled</Pill>;
  }
  if (match.suspended) {
    return <Pill tone="muted">Suspended</Pill>;
  }
  if (match.status === "live") {
    return <Pill tone="accent">Live</Pill>;
  }
  if (match.status === "done") {
    return (
      <Pill tone="muted">
        Final {match.scoreA ?? "-"}–{match.scoreB ?? "-"}
      </Pill>
    );
  }
  return <Pill tone="default">Upcoming</Pill>;
}

function Pill({
  tone,
  children,
}: {
  tone: "default" | "accent" | "muted";
  children: React.ReactNode;
}) {
  const cls =
    "shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] " +
    (tone === "accent"
      ? "border-[var(--color-accent)] text-[var(--color-accent)]"
      : tone === "muted"
        ? "border-[var(--color-border-strong)] text-[var(--color-fg-subtle)]"
        : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)]");
  return <span className={cls}>{children}</span>;
}

function PredictionForm({
  competitionId,
  competitionType,
  match,
}: {
  competitionId: string;
  competitionType: CompetitionType;
  match: CompetitionMatchRow;
}) {
  const router = useRouter();
  const initial = match.viewerPrediction;
  const [scoreA, setScoreA] = useState<string>(
    initial ? String(initial.predictedScoreA) : "",
  );
  const [scoreB, setScoreB] = useState<string>(
    initial ? String(initial.predictedScoreB) : "",
  );
  const [tip, setTip] = useState<"1" | "X" | "2" | "">(
    (initial?.tip ?? "") as "1" | "X" | "2" | "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(
    initial ? new Date(initial.placedAt).toLocaleTimeString() : null,
  );

  const showTip = competitionType !== "prediction";

  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        try {
          const a = parseInt(scoreA, 10);
          const b = parseInt(scoreB, 10);
          if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) {
            setError("Scores must be 0 or higher");
            return;
          }
          if (competitionType === "tipping" && !tip) {
            setError("Pick 1, X, or 2");
            return;
          }
          const res = await fetch(
            `/api/community/competitions/${competitionId}/predictions`,
            {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                competitionMatchId: match.id,
                predictedScoreA: a,
                predictedScoreB: b,
                ...(showTip && tip ? { tip } : {}),
              }),
            },
          );
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              error?: string;
            };
            setError(body.error ?? "Couldn't save prediction");
            return;
          }
          const data = (await res.json()) as CreatePredictionResponse;
          setSavedAt(new Date(data.prediction.placedAt).toLocaleTimeString());
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      <ScoreInput label={match.teamA} value={scoreA} onChange={setScoreA} />
      <span className="pb-2 text-sm text-[var(--color-fg-subtle)]">–</span>
      <ScoreInput label={match.teamB} value={scoreB} onChange={setScoreB} />
      {showTip ? (
        <fieldset className="flex items-end gap-1">
          {(["1", "X", "2"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setTip(opt)}
              className={
                "h-8 w-8 rounded-[6px] border text-xs font-semibold " +
                (tip === opt
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-on-accent)]"
                  : "border-[var(--color-border-strong)] text-[var(--color-fg)]")
              }
            >
              {opt}
            </button>
          ))}
        </fieldset>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-[8px] bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-60"
      >
        {pending ? "Saving…" : initial ? "Update" : "Predict"}
      </button>
      {savedAt && !error ? (
        <span className="text-[11px] text-[var(--color-fg-subtle)]">
          Saved {savedAt}
        </span>
      ) : null}
      {error ? (
        <span className="text-[11px] text-[var(--color-danger)]">{error}</span>
      ) : null}
    </form>
  );
}

function ScoreInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
      <span className="max-w-[120px] truncate">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={99}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-9 w-14 rounded-[6px] border border-[var(--color-border-strong)] bg-[var(--color-bg-base)] px-2 text-center text-sm text-[var(--color-fg)]"
      />
    </label>
  );
}

function ViewerPredictionRow({ prediction: p }: { prediction: ViewerPrediction }) {
  const settled = p.settledAt !== null;
  const outcomeLabel =
    p.outcome === "correct"
      ? `+${p.pointsAwarded ?? 0} pts`
      : p.outcome === "partial"
        ? `+${p.pointsAwarded ?? 0} pts`
        : p.outcome === "wrong"
          ? "0 pts"
          : p.outcome === "void"
            ? "Void"
            : "Pending";
  return (
    <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
      Your pick: <strong>{p.predictedScoreA}</strong>–
      <strong>{p.predictedScoreB}</strong>
      {p.tip ? <> · Tip <strong>{p.tip}</strong></> : null}
      <span className="ml-2 text-[var(--color-fg-subtle)]">·</span>
      <span
        className={
          "ml-2 " +
          (settled && p.outcome === "correct"
            ? "text-[var(--color-accent)]"
            : settled && p.outcome === "wrong"
              ? "text-[var(--color-danger)]"
              : "text-[var(--color-fg-subtle)]")
        }
      >
        {outcomeLabel}
      </span>
    </p>
  );
}

function isPredictionLocked(match: CompetitionMatchRow): boolean {
  // Defensive client check; the API enforces the same rule and is the
  // source of truth. We add a 30s buffer to avoid clock-skew jitters
  // on the lock boundary.
  const lockMs = new Date(match.kickoffAt).getTime() - 30_000;
  if (Date.now() >= lockMs) return true;
  if (match.status === "live" || match.status === "done") return true;
  return false;
}
