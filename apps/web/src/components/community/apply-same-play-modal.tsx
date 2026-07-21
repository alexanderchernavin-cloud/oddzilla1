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
import { useTranslations } from "@/lib/i18n";
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

type Translator = ReturnType<typeof useTranslations>;

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
  const t = useTranslations("analyses");
  const tCommon = useTranslations("common");
  const tNotifications = useTranslations("notifications");

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
          message: errorCopy(code, t),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId, t]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={tNotifications("applySamePlay")}
      onClick={onClose}
    >
      <div
        className="card max-h-[90vh] w-full max-w-2xl overflow-y-auto p-5 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">
              {tNotifications("applySamePlay")}
            </h2>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
              {t("samePlay.subtitle")}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost text-xs"
            onClick={onClose}
            aria-label={tCommon("close")}
          >
            {tCommon("close")}
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
  const t = useTranslations("analyses");
  return (
    <p className="py-12 text-center text-sm text-[var(--color-fg-muted)]">
      {t("samePlay.loading")}
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
            />
          ))}
        </ul>
      )}
    </>
  );
}

function OriginatorRecap({ data }: { data: ApplySamePlayResponse }) {
  const t = useTranslations("analyses");
  const { originator } = data;
  const stake = fromMicro(BigInt(originator.stakeMicro));
  return (
    <section className="card mb-4 border-[var(--color-accent)]/40 p-3 text-xs">
      <p className="text-[var(--color-fg-subtle)]">{t("samePlay.originalBet")}</p>
      <p className="mt-1 font-medium text-[var(--color-fg)]">
        {originator.teams.home} vs {originator.teams.away}
        <span className="text-[var(--color-fg-muted)]"> · </span>
        {originator.play.outcomeLabel}
      </p>
      <p className="mt-1 text-[var(--color-fg-muted)]">
        {t("samePlay.oddsStakeLine", {
          odds: originator.originalOdds,
          stake,
          currency: originator.currency,
        })}
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
  const t = useTranslations("analyses");
  return (
    <div className="flex flex-wrap gap-4 border-y border-[var(--color-border-strong)] py-3 text-xs">
      <ControlGroup label={t("samePlay.mode")}>
        <SegmentedControl<ApplySamePlayMode>
          value={mode}
          onChange={setMode}
          options={[
            { value: "literal", label: t("samePlay.literal") },
            { value: "analogical", label: t("samePlay.analogical") },
          ]}
        />
      </ControlGroup>
      <ControlGroup label={t("samePlay.stake")}>
        <SegmentedControl<ApplySamePlayStakeMode>
          value={stakeMode}
          onChange={setStakeMode}
          options={[
            { value: "same", label: t("samePlay.stakeSame") },
            { value: "target", label: t("samePlay.stakeTarget") },
            { value: "suggest", label: t("samePlay.stakeSuggested") },
          ]}
        />
      </ControlGroup>
      <ControlGroup label={t("samePlay.minOdds")}>
        <input
          type="text"
          inputMode="decimal"
          className="w-20 rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs"
          value={minOdds}
          onChange={(e) => setMinOdds(e.target.value)}
          aria-label={t("samePlay.minOddsAria")}
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
  const t = useTranslations("analyses");
  if (mode === "literal") {
    return (
      <div className="card mt-5 p-6 text-center text-sm text-[var(--color-fg-muted)]">
        <p>{t("samePlay.emptyLiteral")}</p>
        <p className="mt-1">
          <button
            type="button"
            className="btn btn-ghost text-xs"
            onClick={() => setMode("analogical")}
          >
            {t("samePlay.switchToAnalogical")}
          </button>
        </p>
      </div>
    );
  }
  return (
    <p className="card mt-5 p-6 text-center text-sm text-[var(--color-fg-muted)]">
      {t("samePlay.emptyAnalogical")}
    </p>
  );
}

interface RowProps {
  originator: ApplySamePlayResponse["originator"];
  candidate: SamePlayCandidate;
  result: SamePlayScoreResult;
  stakeMode: ApplySamePlayStakeMode;
  minOddsNum: number;
}

function CandidateRow({
  originator,
  candidate,
  result,
  stakeMode,
  minOddsNum,
}: RowProps) {
  const slip = useBetSlip();
  const t = useTranslations("analyses");
  const [showBreakdown, setShowBreakdown] = useState(false);
  // Track whether this row was added by the user in *this* modal session.
  // Distinguishes "Added ✓" (just-clicked confirmation) from the
  // "Already in slip" pre-existing state. If the user clears the slip
  // externally, the inSlip derivation below flips back to false and the
  // CTA reverts to "Apply" per PRD §"Added confirmation state".
  const [justAdded, setJustAdded] = useState(false);

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

  // Per PRD §"Edge cases": disable when this exact (market, outcome)
  // is already in the slip — regardless of whether it landed there via
  // this row, a prior row in this session, or before the modal opened.
  // `slip.has` is reactive (BetSlipProvider re-renders consumers on
  // change), so clearing the slip flips this back to false and the
  // button reverts.
  const inSlip = slip.has(candidate.marketId, originator.play.outcomeId);
  const blockedByRow = candidate.suspended || belowFloor;
  const disabled = blockedByRow || inSlip;

  // Reset the just-added confirmation if the slip is cleared externally,
  // so the next click renders "Apply" not "Added ✓".
  useEffect(() => {
    if (!inSlip && justAdded) setJustAdded(false);
  }, [inSlip, justAdded]);

  const adaptedStake = adaptStake(
    originator.stakeMicro,
    originator.originalOdds,
    candidate.currentOdds,
    stakeMode,
  );

  function onApply() {
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
    setJustAdded(true);
    // Don't auto-close the modal — per PRD the user can keep adding
    // candidates, and the row's "Added ✓" state is the confirmation.
    // Modal closes via Esc / Close button / click outside.
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
            aria-label={t("samePlay.scoreBreakdownAria")}
          >
            {t("samePlay.score", { score: result.score })}
          </button>
          <p className="mt-2 font-mono text-xs text-[var(--color-fg-muted)]">
            {t("samePlay.rowStake", {
              stake: fromMicro(BigInt(adaptedStake)),
              currency: originator.currency,
            })}
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={onApply}
            className={
              "mt-2 rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.15em] transition " +
              (inSlip
                ? "cursor-not-allowed border-[var(--color-positive)] text-[var(--color-positive)]"
                : blockedByRow
                  ? "cursor-not-allowed border-[var(--color-border-strong)] text-[var(--color-fg-subtle)]"
                  : "border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10")
            }
          >
            {inSlip
              ? justAdded
                ? t("samePlay.added")
                : t("samePlay.alreadyInSlip")
              : t("samePlay.apply")}
          </button>
        </div>
      </div>

      {showBreakdown ? <ScoreBreakdown reasons={result.reasons} /> : null}

      {candidate.suspended ? (
        <Banner tone="negative">{t("samePlay.bannerSuspended")}</Banner>
      ) : belowFloor ? (
        <Banner tone="muted">
          {t("samePlay.bannerBelowFloor", { min: minOddsNum.toFixed(2) })}
        </Banner>
      ) : kickoffImminent ? (
        <Banner tone="accent">
          {t("samePlay.bannerKickoff", {
            hours: Math.max(1, Math.ceil(candidate.hoursToKickoff)),
          })}
        </Banner>
      ) : null}
    </li>
  );
}

function KickoffLine({ hours, imminent }: { hours: number; imminent: boolean }) {
  const t = useTranslations("analyses");
  if (hours < 0) return <>{t("samePlay.kickoffStarted")}</>;
  if (hours < 1) return <>{t("samePlay.kickoffUnderHour")}</>;
  if (hours < 24) {
    return (
      <span className={imminent ? "text-[var(--color-accent)]" : undefined}>
        {t("samePlay.kickoffHours", { hours: Math.round(hours) })}
      </span>
    );
  }
  return <>{t("samePlay.kickoffDays", { days: Math.round(hours / 24) })}</>;
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
  const t = useTranslations("analyses");
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
      {chipLabel(reason, t)}
    </span>
  );
}

function ScoreBreakdown({ reasons }: { reasons: SamePlayReason[] }) {
  const t = useTranslations("analyses");
  return (
    <ul className="mt-3 space-y-1.5 border-t border-[var(--color-border-strong)] pt-3 text-xs text-[var(--color-fg-muted)]">
      {reasons.map((r, i) => (
        <li key={`${r.kind}-${i}`} className="flex items-start gap-2">
          <span className="font-medium text-[var(--color-fg)]">
            {chipLabel(r, t)}
          </span>
          <span>— {chipExplanation(r, t)}</span>
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
// Labels per kind, resolved through the `analyses.samePlay` i18n
// namespace. The translator is passed in from the calling component
// (these are plain functions, not hooks).

function chipLabel(r: SamePlayReason, t: Translator): string {
  const labels: Record<SamePlayReasonKind, string> = {
    same_market: t("samePlay.reasons.sameMarket"),
    different_market: t("samePlay.reasons.differentMarket"),
    same_team: t("samePlay.reasons.sameTeam"),
    same_tier: r.payload?.tier
      ? t("samePlay.reasons.sameTierWith", { tier: r.payload.tier })
      : t("samePlay.reasons.sameTier"),
    tier_gap: t("samePlay.reasons.tierGap"),
    role_match: roleMatchLabel(r, t),
    role_mismatch: t("samePlay.reasons.roleMismatch"),
    odds_close: r.payload?.percent
      ? t("samePlay.reasons.oddsWithin", { percent: r.payload.percent })
      : t("samePlay.reasons.oddsClose"),
    odds_drift: r.payload
      ? t(
          r.payload.direction === "up"
            ? "samePlay.reasons.oddsUp"
            : "samePlay.reasons.oddsDown",
          { percent: r.payload.percent ?? "" },
        )
      : t("samePlay.reasons.oddsDrift"),
    kickoff_soon: t("samePlay.reasons.kickoffSoon"),
    suspended: t("samePlay.reasons.suspended"),
  };
  return labels[r.kind];
}

function chipExplanation(r: SamePlayReason, t: Translator): string {
  switch (r.kind) {
    case "same_market":
      return t("samePlay.explanations.sameMarket");
    case "different_market":
      return t("samePlay.explanations.differentMarket");
    case "same_team":
      return t("samePlay.explanations.sameTeam");
    case "same_tier":
      return t("samePlay.explanations.sameTier");
    case "tier_gap":
      return t("samePlay.explanations.tierGap");
    case "role_match":
      return t("samePlay.explanations.roleMatch");
    case "role_mismatch":
      return t("samePlay.explanations.roleMismatch");
    case "odds_close":
      return t("samePlay.explanations.oddsClose");
    case "odds_drift":
      return t("samePlay.explanations.oddsDrift");
    case "kickoff_soon":
      return t("samePlay.explanations.kickoffSoon");
    case "suspended":
      return t("samePlay.explanations.suspended");
  }
}

function roleMatchLabel(r: SamePlayReason, t: Translator): string {
  const role = r.payload?.role;
  if (role === "favorite") return t("samePlay.reasons.roleFavorites");
  if (role === "underdog") return t("samePlay.reasons.roleUnderdogs");
  if (role === "even") return t("samePlay.reasons.roleEven");
  return t("samePlay.reasons.roleSame");
}

function errorCopy(code: string, t: Translator): string {
  if (code === "combo_unsupported") {
    return t("samePlay.errors.comboUnsupported");
  }
  if (code === "not_a_win") {
    return t("samePlay.errors.notAWin");
  }
  if (code === "Not Found") return t("samePlay.errors.notFound");
  return t("samePlay.errors.loadFailed");
}
