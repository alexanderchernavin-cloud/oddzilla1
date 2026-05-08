"use client";

// Apply Same Play modal.
//
// Driven by the deterministic scorer in lib/same-play-scorer.ts. The
// modal owns four user-controlled surfaces (PRD §"Apply Same Play —
// algorithm and surfaces"):
//   • Mode toggle (Literal · Analogical) — hard filter, not a weight.
//   • Stake-mode picker (Same · Target profit · Suggested) — re-runs
//     adaptStake on each candidate row.
//   • Min-odds floor — the row "Below floor" state references this.
//   • Per-row reason chips + score-breakdown popover.
//
// Banner priority on a row: Suspended > Below floor > Kickoff
// imminent (PRD §"Row states"). The visual signals (border, icon)
// still render even when the banner is suppressed.
//
// Network: lazy-loaded on open. We don't preload candidates with the
// big-wins feed because most cards never get the modal opened — keep
// the feed payload lean.

import { useEffect, useMemo, useState } from "react";
import type {
  ApplySamePlayResponse,
  SamePlayCandidate,
} from "@oddzilla/types";
import { fromMicro } from "@oddzilla/types/money";
import { useBetSlip } from "@/lib/bet-slip";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import {
  adaptStake,
  defaultMinOdds,
  rankCandidates,
  type ApplySamePlayMode,
  type ApplySamePlayStakeMode,
  type SamePlayReason,
  type SamePlayReasonKind,
  type SamePlayScoreResult,
} from "@/lib/same-play-scorer";

interface Props {
  ticketId: string;
  onClose: () => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: ApplySamePlayResponse }
  | { kind: "error"; message: string };

export function ApplySamePlayModal({ ticketId, onClose }: Props) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [mode, setMode] = useState<ApplySamePlayMode>("analogical");
  const [stakeMode, setStakeMode] = useState<ApplySamePlayStakeMode>("suggest");
  const [minOdds, setMinOdds] = useState<string>("1.10");

  // Lock background scroll while open, restore on unmount. Avoids the
  // standard "modal scrolls the page underneath" smell on long feeds.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Esc-to-close. Single keydown listener instead of focus-trap
  // gymnastics — the modal renders a small list and the close
  // button is one tab away.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    clientApi<ApplySamePlayResponse>(
      `/community/apply-same-play/${ticketId}/candidates`,
    )
      .then((data) => {
        if (cancelled) return;
        setState({ kind: "ready", data });
        setMinOdds(defaultMinOdds(data.originator.originalOdds));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const code =
          err instanceof ApiFetchError ? err.body.error : "unknown_error";
        setState({
          kind: "error",
          message: errorCopy(code),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Apply same play"
      onClick={onClose}
    >
      <div
        className="card max-h-[90vh] w-full max-w-2xl overflow-y-auto p-5 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">
              Apply same play
            </h2>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
              Find an upcoming match where the same play makes sense.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost text-xs"
            onClick={onClose}
            aria-label="Close"
          >
            Close
          </button>
        </header>

        {state.kind === "loading" ? (
          <Loading />
        ) : state.kind === "error" ? (
          <ErrorPanel message={state.message} />
        ) : (
          <Body
            data={state.data}
            mode={mode}
            setMode={setMode}
            stakeMode={stakeMode}
            setStakeMode={setStakeMode}
            minOdds={minOdds}
            setMinOdds={setMinOdds}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

function Loading() {
  return (
    <p className="py-12 text-center text-sm text-[var(--color-fg-muted)]">
      Looking for matches…
    </p>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <p className="py-12 text-center text-sm text-[var(--color-negative)]">
      {message}
    </p>
  );
}

interface BodyProps {
  data: ApplySamePlayResponse;
  mode: ApplySamePlayMode;
  setMode: (m: ApplySamePlayMode) => void;
  stakeMode: ApplySamePlayStakeMode;
  setStakeMode: (s: ApplySamePlayStakeMode) => void;
  minOdds: string;
  setMinOdds: (m: string) => void;
  onClose: () => void;
}

function Body({
  data,
  mode,
  setMode,
  stakeMode,
  setStakeMode,
  minOdds,
  setMinOdds,
  onClose,
}: BodyProps) {
  const { originator } = data;

  const ranked = useMemo(
    () => rankCandidates(originator, data.candidates, mode),
    [originator, data.candidates, mode],
  );

  const minOddsNum = parseFloat(minOdds);

  return (
    <>
      <OriginatorRecap data={data} />

      <Controls
        mode={mode}
        setMode={setMode}
        stakeMode={stakeMode}
        setStakeMode={setStakeMode}
        minOdds={minOdds}
        setMinOdds={setMinOdds}
      />

      {ranked.length === 0 ? (
        <EmptyCandidates mode={mode} setMode={setMode} />
      ) : (
        <ul className="mt-5 space-y-3">
          {ranked.slice(0, 10).map(({ candidate, result }) => (
            <CandidateRow
              key={`${candidate.matchId}:${candidate.marketId}`}
              originator={originator}
              candidate={candidate}
              result={result}
              stakeMode={stakeMode}
              minOddsNum={Number.isFinite(minOddsNum) ? minOddsNum : 0}
              onAdded={onClose}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function OriginatorRecap({ data }: { data: ApplySamePlayResponse }) {
  const { originator } = data;
  const stake = fromMicro(BigInt(originator.stakeMicro));
  return (
    <section className="card mb-4 border-[var(--color-accent)]/40 p-3 text-xs">
      <p className="text-[var(--color-fg-subtle)]">Original bet</p>
      <p className="mt-1 font-medium text-[var(--color-fg)]">
        {originator.teams.home} vs {originator.teams.away}
        <span className="text-[var(--color-fg-muted)]"> · </span>
        {originator.play.outcomeLabel}
      </p>
      <p className="mt-1 text-[var(--color-fg-muted)]">
        @{originator.originalOdds} · stake {stake} {originator.currency}
      </p>
    </section>
  );
}

interface ControlProps {
  mode: ApplySamePlayMode;
  setMode: (m: ApplySamePlayMode) => void;
  stakeMode: ApplySamePlayStakeMode;
  setStakeMode: (s: ApplySamePlayStakeMode) => void;
  minOdds: string;
  setMinOdds: (m: string) => void;
}

function Controls({
  mode,
  setMode,
  stakeMode,
  setStakeMode,
  minOdds,
  setMinOdds,
}: ControlProps) {
  return (
    <div className="flex flex-wrap gap-4 border-y border-[var(--color-border-strong)] py-3 text-xs">
      <ControlGroup label="Mode">
        <SegmentedControl<ApplySamePlayMode>
          value={mode}
          onChange={setMode}
          options={[
            { value: "literal", label: "Literal" },
            { value: "analogical", label: "Analogical" },
          ]}
        />
      </ControlGroup>
      <ControlGroup label="Stake">
        <SegmentedControl<ApplySamePlayStakeMode>
          value={stakeMode}
          onChange={setStakeMode}
          options={[
            { value: "same", label: "Same" },
            { value: "target", label: "Target profit" },
            { value: "suggest", label: "Suggested" },
          ]}
        />
      </ControlGroup>
      <ControlGroup label="Min odds">
        <input
          type="text"
          inputMode="decimal"
          className="w-20 rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs"
          value={minOdds}
          onChange={(e) => setMinOdds(e.target.value)}
          aria-label="Minimum odds"
        />
      </ControlGroup>
    </div>
  );
}

function ControlGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {label}
      </span>
      {children}
    </div>
  );
}

interface SegmentedOption<T> {
  value: T;
  label: string;
}

function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
}) {
  return (
    <div
      role="radiogroup"
      className="inline-flex rounded-[8px] border border-[var(--color-border-strong)] p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={
            "rounded-[6px] px-2 py-1 text-[11px] uppercase tracking-[0.12em] transition " +
            (value === o.value
              ? "bg-[var(--color-bg-elevated)] text-[var(--color-fg)]"
              : "text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EmptyCandidates({
  mode,
  setMode,
}: {
  mode: ApplySamePlayMode;
  setMode: (m: ApplySamePlayMode) => void;
}) {
  if (mode === "literal") {
    return (
      <div className="card mt-5 p-6 text-center text-sm text-[var(--color-fg-muted)]">
        <p>No upcoming fixtures share these teams yet.</p>
        <p className="mt-1">
          <button
            type="button"
            className="btn btn-ghost text-xs"
            onClick={() => setMode("analogical")}
          >
            Switch to Analogical →
          </button>
        </p>
      </div>
    );
  }
  return (
    <p className="card mt-5 p-6 text-center text-sm text-[var(--color-fg-muted)]">
      No comparable plays in the next few days. Check back closer to kickoff.
    </p>
  );
}

interface RowProps {
  originator: ApplySamePlayResponse["originator"];
  candidate: SamePlayCandidate;
  result: SamePlayScoreResult;
  stakeMode: ApplySamePlayStakeMode;
  minOddsNum: number;
  onAdded: () => void;
}

function CandidateRow({
  originator,
  candidate,
  result,
  stakeMode,
  minOddsNum,
  onAdded,
}: RowProps) {
  const slip = useBetSlip();
  const [showBreakdown, setShowBreakdown] = useState(false);

  const candOdds = parseFloat(candidate.currentOdds);
  // Banner priority: Suspended > Below floor > Kickoff imminent
  // (PRD §"Row states"). Visual signals — border colour, icon —
  // still render under the suppressed banners.
  const belowFloor = !candidate.suspended && candOdds < minOddsNum;
  const kickoffImminent =
    !candidate.suspended &&
    !belowFloor &&
    candidate.hoursToKickoff <= 2 &&
    candidate.hoursToKickoff > 0;

  const disabled = candidate.suspended || belowFloor;

  const adaptedStake = adaptStake(
    originator.stakeMicro,
    originator.originalOdds,
    candidate.currentOdds,
    stakeMode,
  );

  function onCopy() {
    if (disabled) return;
    slip.add({
      matchId: candidate.matchId,
      marketId: candidate.marketId,
      outcomeId: originator.play.outcomeId,
      odds: candidate.currentOdds,
      homeTeam: candidate.homeTeam,
      awayTeam: candidate.awayTeam,
      marketLabel: originator.play.marketLabel,
      outcomeLabel: originator.play.outcomeLabel,
      sportSlug: candidate.sportSlug,
    });
    slip.setMode("single");
    slip.setOpen(true);
    onAdded();
  }

  const borderClass = candidate.suspended
    ? "border-[var(--color-negative)]"
    : kickoffImminent
      ? "border-[var(--color-accent)]"
      : "border-[var(--color-border-strong)]";

  return (
    <li className={`card border ${borderClass} p-3 text-sm`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {candidate.homeTeam} vs {candidate.awayTeam}
          </p>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            {candidate.tournamentName} ·{" "}
            <KickoffLine
              hours={candidate.hoursToKickoff}
              imminent={kickoffImminent}
            />{" "}
            · @{candidate.currentOdds}
          </p>
          <ReasonChips reasons={result.reasons} />
        </div>
        <div className="text-right">
          <button
            type="button"
            className="rounded-full border border-[var(--color-border-strong)] px-2 py-0.5 text-[11px] uppercase tracking-[0.15em] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            onClick={() => setShowBreakdown((b) => !b)}
            aria-expanded={showBreakdown}
            aria-label="Score breakdown"
          >
            Score {result.score}
          </button>
          <p className="mt-2 font-mono text-xs text-[var(--color-fg-muted)]">
            stake {fromMicro(BigInt(adaptedStake))} {originator.currency}
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={onCopy}
            className={
              "mt-2 rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.15em] transition " +
              (disabled
                ? "cursor-not-allowed border-[var(--color-border-strong)] text-[var(--color-fg-subtle)]"
                : "border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10")
            }
          >
            Apply
          </button>
        </div>
      </div>

      {showBreakdown ? <ScoreBreakdown reasons={result.reasons} /> : null}

      {candidate.suspended ? (
        <Banner tone="negative">
          Market suspended. Re-quote when it reopens.
        </Banner>
      ) : belowFloor ? (
        <Banner tone="muted">
          Below your minimum odds ({minOddsNum.toFixed(2)}).
        </Banner>
      ) : kickoffImminent ? (
        <Banner tone="accent">
          Starts in {Math.max(1, Math.ceil(candidate.hoursToKickoff))} h. Odds may move
          before Apply lands.
        </Banner>
      ) : null}
    </li>
  );
}

function KickoffLine({ hours, imminent }: { hours: number; imminent: boolean }) {
  if (hours < 0) return <>started</>;
  if (hours < 1) return <>{`<1 h to kickoff`}</>;
  if (hours < 24) {
    return (
      <span className={imminent ? "text-[var(--color-accent)]" : undefined}>
        {Math.round(hours)} h to kickoff
      </span>
    );
  }
  return <>{Math.round(hours / 24)} d to kickoff</>;
}

function ReasonChips({ reasons }: { reasons: SamePlayReason[] }) {
  if (reasons.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {reasons.map((r, i) => (
        <Chip key={`${r.kind}-${i}`} reason={r} />
      ))}
    </div>
  );
}

function Chip({ reason }: { reason: SamePlayReason }) {
  const tone =
    reason.sentiment === "positive"
      ? "border-[var(--color-positive)]/40 text-[var(--color-positive)]"
      : reason.sentiment === "negative"
        ? "border-[var(--color-negative)]/40 text-[var(--color-negative)]"
        : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)]";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] ${tone}`}
    >
      {chipLabel(reason)}
    </span>
  );
}

function ScoreBreakdown({ reasons }: { reasons: SamePlayReason[] }) {
  return (
    <ul className="mt-3 space-y-1.5 border-t border-[var(--color-border-strong)] pt-3 text-xs text-[var(--color-fg-muted)]">
      {reasons.map((r, i) => (
        <li key={`${r.kind}-${i}`} className="flex items-start gap-2">
          <span className="font-medium text-[var(--color-fg)]">
            {chipLabel(r)}
          </span>
          <span>— {chipExplanation(r)}</span>
        </li>
      ))}
    </ul>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "negative" | "muted" | "accent";
  children: React.ReactNode;
}) {
  const cls =
    tone === "negative"
      ? "text-[var(--color-negative)]"
      : tone === "accent"
        ? "text-[var(--color-accent)]"
        : "text-[var(--color-fg-muted)]";
  return <p className={`mt-2 text-[11px] ${cls}`}>{children}</p>;
}

// ─── Reason copy ───────────────────────────────────────────────────────────
//
// Static labels per kind. Kept in this file (not i18n keys) for V1
// — the PRD calls out localisation as a follow-up that will move
// these into community.bigWins.applySamePlay.reasons.* when the
// next-i18next setup lands.

function chipLabel(r: SamePlayReason): string {
  const labels: Record<SamePlayReasonKind, string> = {
    same_market: "Same market",
    different_market: "Different market",
    same_team: "Same team",
    same_tier: r.payload?.tier ? `Same tier (${r.payload.tier})` : "Same tier",
    tier_gap: "Lower tier league",
    role_match: roleMatchLabel(r),
    role_mismatch: "Different role",
    odds_close: r.payload?.percent
      ? `Odds within ${r.payload.percent}%`
      : "Odds close",
    odds_drift: r.payload
      ? `Odds ${r.payload.direction === "up" ? "up" : "down"} ${r.payload.percent}%`
      : "Odds drift",
    kickoff_soon: "Starts soon",
    suspended: "Market suspended",
  };
  return labels[r.kind];
}

function chipExplanation(r: SamePlayReason): string {
  switch (r.kind) {
    case "same_market":
      return "The market and selection line up exactly with the original bet.";
    case "different_market":
      return "Different market or selection — the play maps loosely.";
    case "same_team":
      return "One of the original teams is on the field.";
    case "same_tier":
      return "Tournament risk tier matches the original.";
    case "tier_gap":
      return "Tournament risk tier is at least two steps from the original.";
    case "role_match":
      return "Both selections sit on the same side of the price (favorites, underdogs, or evens).";
    case "role_mismatch":
      return "The picked side flips role — favorite became underdog, or vice versa.";
    case "odds_close":
      return "Live price is within touching distance of the original.";
    case "odds_drift":
      return "Live price has moved significantly since the original bet.";
    case "kickoff_soon":
      return "Kickoff is within the next two hours; odds can move before the bet lands.";
    case "suspended":
      return "The market isn't taking action right now.";
  }
}

function roleMatchLabel(r: SamePlayReason): string {
  const role = r.payload?.role;
  if (role === "favorite") return "Both favorites";
  if (role === "underdog") return "Both underdogs";
  if (role === "even") return "Both even";
  return "Same role";
}

function errorCopy(code: string): string {
  if (code === "combo_unsupported") {
    return "Apply Same Play isn't available for combo bets yet.";
  }
  if (code === "not_a_win") {
    return "This bet didn't win, so there's no play to apply.";
  }
  if (code === "Not Found") return "We couldn't find that bet.";
  return "Couldn't load matches. Try again in a moment.";
}
