"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toMicro } from "@oddzilla/types/money";
import { useBetSlip } from "@/lib/bet-slip";
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
  const [placedTicketId, setPlacedTicketId] = useState<string | null>(null);

  const singleSelection = slip.selections[0] ?? null;
  const odds = singleSelection ? Number(singleSelection.odds) : 0;
  const potentialPayout = useMemo(() => {
    const stake = Number(stakeInput);
    if (!Number.isFinite(stake) || stake <= 0 || odds <= 0) return "0.00";
    return (stake * odds).toFixed(2);
  }, [stakeInput, odds]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!singleSelection) return;
    setError(null);
    setPlacedTicketId(null);

    let stakeMicro: string;
    try {
      const micro = toMicro(stakeInput);
      if (micro <= 0n) {
        setError("Stake must be positive.");
        return;
      }
      stakeMicro = micro.toString();
    } catch {
      setError("Invalid stake.");
      return;
    }

    setSubmitting(true);
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await clientApi<{ ticket: { id: string; status: string } }>(
        "/bets",
        {
          method: "POST",
          body: JSON.stringify({
            stakeMicro,
            idempotencyKey,
            selections: [
              {
                marketId: singleSelection.marketId,
                outcomeId: singleSelection.outcomeId,
                odds: singleSelection.odds,
              },
            ],
          }),
        },
      );
      setPlacedTicketId(res.ticket.id);
      slip.clear();
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiFetchError ? mapError(err) : "Placement failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside className="fixed bottom-24 right-6 z-40 w-[360px] max-w-[90vw] rounded-[14px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] shadow-2xl">
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

      {placedTicketId ? (
        <div className="p-5">
          <p className="text-sm text-[var(--color-positive)]">
            Bet placed.
          </p>
          <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
            Ticket id <span className="font-mono">{placedTicketId.slice(0, 8)}…</span>
          </p>
          <Link
            href="/bets"
            className="mt-4 inline-block text-sm underline decoration-[var(--color-accent)]"
          >
            View in bet history →
          </Link>
        </div>
      ) : !singleSelection ? (
        <p className="p-5 text-sm text-[var(--color-fg-muted)]">
          No selections. Click any outcome price to add it.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="p-4 space-y-4">
          <div className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3">
            <div className="flex items-center justify-between text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
              <span>{singleSelection.sportSlug}</span>
              <button
                type="button"
                onClick={() =>
                  slip.remove(singleSelection.marketId, singleSelection.outcomeId)
                }
                className="text-[var(--color-fg-muted)] hover:text-[var(--color-negative)]"
              >
                Remove
              </button>
            </div>
            <p className="mt-2 text-sm">
              {singleSelection.homeTeam} <span className="text-[var(--color-fg-subtle)]">vs</span>{" "}
              {singleSelection.awayTeam}
            </p>
            <div className="mt-2 flex items-center justify-between">
              <div>
                <p className="text-xs text-[var(--color-fg-subtle)]">
                  {singleSelection.marketLabel}
                </p>
                <p className="text-sm">{singleSelection.outcomeLabel}</p>
              </div>
              <span className="font-mono text-lg text-[var(--color-accent)]">
                {singleSelection.odds}
              </span>
            </div>
          </div>

          <label className="block">
            <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
              Stake (USDT)
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

          <div className="flex items-baseline justify-between text-sm">
            <span className="text-[var(--color-fg-muted)]">To win</span>
            <span className="font-mono text-[var(--color-accent)]">
              {potentialPayout} USDT
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
              disabled={submitting}
              className="btn btn-primary flex-1"
            >
              {submitting ? "Placing…" : "Place bet"}
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
        </form>
      )}
    </aside>
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
    case "combos_not_yet_supported":
      return "Combo bets aren't supported yet.";
    default:
      return err.body.message || "Placement failed.";
  }
}

