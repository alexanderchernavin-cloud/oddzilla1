"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toMicro } from "@oddzilla/types/money";
import type { SlipSelection } from "@oddzilla/types";
import { useBetSlip, type SlipMode } from "@/lib/bet-slip";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export function BetSlip() {
  const slip = useBetSlip();
  const hasSelections = slip.selections.length > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => slip.setOpen(!slip.open)}
        className={
          "fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full px-4 py-3 text-sm font-medium shadow-lg transition-colors " +
          (hasSelections
            ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
            : "border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)]")
        }
      >
        Bet slip
        {hasSelections ? (
          <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[var(--color-bg)] px-1.5 text-xs text-[var(--color-accent)]">
            {slip.selections.length}
          </span>
        ) : null}
      </button>

      {slip.open ? <SlipPanel /> : null}
    </>
  );
}

function SlipPanel() {
  const slip = useBetSlip();
  const router = useRouter();
  const [stakeInput, setStakeInput] = useState("10.00");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placedSummary, setPlacedSummary] = useState<{
    placed: number;
    failed: Array<{ selection: SlipSelection; message: string }>;
  } | null>(null);

  const selections = slip.selections;
  // Effective mode: a single selection is always placed as a single
  // bet even if the user last toggled "Combo". Lets the Combo toggle
  // persist across visits without trapping the UI in a blocked state
  // when there's only one selection left.
  const effectiveMode: SlipMode =
    slip.mode === "combo" && selections.length > 1 ? "combo" : "single";

  const productOdds = useMemo(() => {
    return selections.reduce((acc, s) => acc * Number(s.odds), 1);
  }, [selections]);
  const sumOdds = useMemo(() => {
    return selections.reduce((acc, s) => acc + Number(s.odds), 0);
  }, [selections]);

  const hasDuplicateMatches = useMemo(() => {
    const seen = new Set<string>();
    for (const s of selections) {
      if (seen.has(s.matchId)) return true;
      seen.add(s.matchId);
    }
    return false;
  }, [selections]);

  const stakeNumber = Number(stakeInput);
  const stakeValid = Number.isFinite(stakeNumber) && stakeNumber > 0;

  const totalStake = effectiveMode === "combo" ? stakeNumber : stakeNumber * selections.length;
  const potentialPayout =
    effectiveMode === "combo" ? stakeNumber * productOdds : stakeNumber * sumOdds;
  const comboBlocked = effectiveMode === "combo" && hasDuplicateMatches;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (selections.length === 0) return;
    setError(null);
    setPlacedSummary(null);

    let stakeMicro: bigint;
    try {
      stakeMicro = toMicro(stakeInput);
      if (stakeMicro <= 0n) {
        setError("Stake must be positive.");
        return;
      }
    } catch {
      setError("Invalid stake.");
      return;
    }

    setSubmitting(true);
    try {
      if (effectiveMode === "combo") {
        if (selections.length < 2) {
          setError("Combo needs at least two selections.");
          return;
        }
        if (hasDuplicateMatches) {
          setError("Combo can't include two selections from the same match.");
          return;
        }
        await clientApi<{ ticket: { id: string; status: string } }>("/bets", {
          method: "POST",
          body: JSON.stringify({
            stakeMicro: stakeMicro.toString(),
            idempotencyKey: crypto.randomUUID(),
            selections: selections.map((s) => ({
              marketId: s.marketId,
              outcomeId: s.outcomeId,
              odds: s.odds,
            })),
          }),
        });
        setPlacedSummary({ placed: 1, failed: [] });
        slip.clear();
        router.refresh();
      } else {
        // Singles mode: place N independent tickets in parallel. Keep
        // failures in the slip with their per-bet error message so the
        // user can retry. Successful selections get removed.
        const results = await Promise.all(
          selections.map(async (s) => {
            try {
              await clientApi<{ ticket: { id: string; status: string } }>(
                "/bets",
                {
                  method: "POST",
                  body: JSON.stringify({
                    stakeMicro: stakeMicro.toString(),
                    idempotencyKey: crypto.randomUUID(),
                    selections: [
                      {
                        marketId: s.marketId,
                        outcomeId: s.outcomeId,
                        odds: s.odds,
                      },
                    ],
                  }),
                },
              );
              return { selection: s, ok: true as const };
            } catch (err) {
              return {
                selection: s,
                ok: false as const,
                message:
                  err instanceof ApiFetchError ? mapError(err) : "Placement failed.",
              };
            }
          }),
        );

        const failed = results
          .filter((r): r is { selection: SlipSelection; ok: false; message: string } => !r.ok)
          .map((r) => ({ selection: r.selection, message: r.message }));
        const placed = results.length - failed.length;

        setPlacedSummary({ placed, failed });
        // Remove succeeded selections; keep failed ones in the slip so
        // the user can edit the stake or wait for odds to settle and retry.
        for (const r of results) {
          if (r.ok) slip.remove(r.selection.marketId, r.selection.outcomeId);
        }
        if (failed.length === 0) {
          router.refresh();
        } else if (placed === 0) {
          setError(failed[0]!.message);
        }
      }
    } catch (err) {
      setError(err instanceof ApiFetchError ? mapError(err) : "Placement failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside className="fixed bottom-24 right-6 z-40 flex max-h-[80vh] w-[380px] max-w-[90vw] flex-col rounded-[14px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] shadow-2xl">
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <h3 className="text-sm font-medium">Bet slip</h3>
        <button
          type="button"
          onClick={() => slip.setOpen(false)}
          className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          Close
        </button>
      </header>

      <ModeToggle
        mode={slip.mode}
        selectionCount={selections.length}
        onChange={(next) => slip.setMode(next)}
      />

      {placedSummary ? (
        <PlacedSummaryView
          summary={placedSummary}
          mode={effectiveMode}
          onDismiss={() => setPlacedSummary(null)}
        />
      ) : selections.length === 0 ? (
        <p className="p-5 text-sm text-[var(--color-fg-muted)]">
          No selections. Click any outcome price to add it.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-2 overflow-y-auto px-4 pt-4">
            {selections.map((s) => (
              <SelectionRow
                key={`${s.marketId}:${s.outcomeId}`}
                selection={s}
                onRemove={() => slip.remove(s.marketId, s.outcomeId)}
              />
            ))}
            {effectiveMode === "combo" && hasDuplicateMatches ? (
              <p className="text-xs text-[var(--color-negative)]">
                Two selections from the same match can&apos;t be combined. Switch to
                Single bets or remove one.
              </p>
            ) : null}
          </div>

          <div className="space-y-3 border-t border-[var(--color-border)] px-4 py-4">
            <label className="block">
              <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                {effectiveMode === "combo" ? "Stake (USDT)" : "Stake per bet (USDT)"}
              </span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={stakeInput}
                onChange={(e) => setStakeInput(e.target.value)}
                className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono outline-none focus:border-[var(--color-accent)]"
              />
            </label>

            {effectiveMode === "single" && selections.length > 1 ? (
              <div className="flex items-baseline justify-between text-xs text-[var(--color-fg-muted)]">
                <span>
                  {selections.length} separate bets · total stake
                </span>
                <span className="font-mono">
                  {stakeValid ? totalStake.toFixed(2) : "0.00"} USDT
                </span>
              </div>
            ) : null}

            {effectiveMode === "combo" ? (
              <div className="flex items-baseline justify-between text-xs text-[var(--color-fg-muted)]">
                <span>Combined odds</span>
                <span className="font-mono">
                  {selections.length > 0 ? productOdds.toFixed(2) : "—"}
                </span>
              </div>
            ) : null}

            <div className="flex items-baseline justify-between text-sm">
              <span className="text-[var(--color-fg-muted)]">
                {effectiveMode === "combo" ? "To win" : "Max payout"}
              </span>
              <span className="font-mono text-[var(--color-accent)]">
                {stakeValid ? potentialPayout.toFixed(2) : "0.00"} USDT
              </span>
            </div>

            {error ? (
              <p role="alert" className="text-sm text-[var(--color-negative)]">
                {error}
              </p>
            ) : null}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={submitting || !stakeValid || comboBlocked}
                className="btn btn-primary flex-1"
              >
                {submitting
                  ? "Placing…"
                  : effectiveMode === "combo"
                  ? "Place combo bet"
                  : selections.length > 1
                  ? `Place ${selections.length} bets`
                  : "Place bet"}
              </button>
              <button
                type="button"
                onClick={slip.clear}
                disabled={submitting}
                className="btn btn-ghost"
              >
                Clear
              </button>
            </div>
          </div>
        </form>
      )}
    </aside>
  );
}

function ModeToggle({
  mode,
  selectionCount,
  onChange,
}: {
  mode: SlipMode;
  selectionCount: number;
  onChange: (mode: SlipMode) => void;
}) {
  const disabled = selectionCount < 2;
  return (
    <div className="flex items-center gap-1 border-b border-[var(--color-border)] p-3">
      <div
        role="tablist"
        aria-label="Bet mode"
        className="flex w-full overflow-hidden rounded-[10px] border border-[var(--color-border)]"
      >
        <ModeTab
          active={mode === "combo"}
          disabled={disabled}
          label="Combo"
          onClick={() => onChange("combo")}
        />
        <ModeTab
          active={mode === "single"}
          label={selectionCount > 1 ? `Singles (${selectionCount})` : "Single"}
          onClick={() => onChange("single")}
        />
      </div>
    </div>
  );
}

function ModeTab({
  active,
  disabled,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={
        "flex-1 px-3 py-1.5 text-xs uppercase tracking-[0.15em] transition-colors " +
        (active
          ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
          : disabled
          ? "cursor-not-allowed text-[var(--color-fg-subtle)]"
          : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
      }
    >
      {label}
    </button>
  );
}

function SelectionRow({
  selection,
  onRemove,
}: {
  selection: SlipSelection;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3">
      <div className="flex items-center justify-between text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        <span>{selection.sportSlug}</span>
        <button
          type="button"
          onClick={onRemove}
          className="text-[var(--color-fg-muted)] hover:text-[var(--color-negative)]"
        >
          Remove
        </button>
      </div>
      <p className="mt-2 text-sm">
        {selection.homeTeam} <span className="text-[var(--color-fg-subtle)]">vs</span>{" "}
        {selection.awayTeam}
      </p>
      <div className="mt-2 flex items-center justify-between">
        <div>
          <p className="text-xs text-[var(--color-fg-subtle)]">
            {selection.marketLabel}
          </p>
          <p className="text-sm">{selection.outcomeLabel}</p>
        </div>
        <span className="font-mono text-lg text-[var(--color-accent)]">
          {selection.odds}
        </span>
      </div>
    </div>
  );
}

function PlacedSummaryView({
  summary,
  mode,
  onDismiss,
}: {
  summary: { placed: number; failed: Array<{ selection: SlipSelection; message: string }> };
  mode: SlipMode;
  onDismiss: () => void;
}) {
  const anyPlaced = summary.placed > 0;
  return (
    <div className="space-y-3 p-5">
      {anyPlaced ? (
        <p className="text-sm text-[var(--color-positive)]">
          {mode === "combo"
            ? "Combo bet placed."
            : summary.placed === 1
            ? "1 bet placed."
            : `${summary.placed} bets placed.`}
        </p>
      ) : (
        <p className="text-sm text-[var(--color-negative)]">
          Nothing placed.
        </p>
      )}

      {summary.failed.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Failed ({summary.failed.length})
          </p>
          <ul className="space-y-1 text-xs text-[var(--color-fg-muted)]">
            {summary.failed.map((f) => (
              <li key={`${f.selection.marketId}:${f.selection.outcomeId}`}>
                <span className="text-[var(--color-fg)]">
                  {f.selection.outcomeLabel}
                </span>{" "}
                — {f.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex gap-2">
        <Link
          href="/bets"
          className="btn btn-ghost flex-1 text-center"
        >
          View bets
        </Link>
        <button type="button" className="btn btn-ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function mapError(err: ApiFetchError): string {
  switch (err.body.error) {
    case "insufficient_balance":
      return "Not enough balance for this stake.";
    case "exceeds_global_limit":
      return "Stake exceeds your global limit.";
    case "odds_drift_exceeded":
      return "The odds moved since you clicked. Try again.";
    case "market_not_active":
    case "outcome_not_active":
    case "outcome_no_price":
      return "This market is suspended. Try again in a moment.";
    case "match_not_open":
      return "This match is no longer open for betting.";
    case "account_not_active":
      return "Your account can't place bets right now.";
    case "idempotency_key_collision":
      return "Please retry — collision on submission id.";
    case "combo_same_match":
      return "Combo can't include two selections from the same match.";
    case "combo_needs_min_two":
      return "Combo needs at least two selections.";
    default:
      return err.body.message || "Placement failed.";
  }
}
