"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fromMicro, multiplyMicroByOdds } from "@oddzilla/types/money";
import type {
  TicketStatus,
  TicketSummary,
  WsTicketFrame,
} from "@oddzilla/types";
import { useTicketStream } from "@/lib/use-ticket-stream";
import { CashoutPanel } from "./cashout-panel";

const STATUS_LABEL: Record<TicketStatus, string> = {
  pending_delay: "Pending",
  accepted: "Accepted",
  rejected: "Rejected",
  settled: "Settled",
  voided: "Voided",
  cashed_out: "Cashed out",
};

const STATUS_COLOR: Record<TicketStatus, string> = {
  pending_delay: "text-[var(--color-warning)]",
  accepted: "text-[var(--color-accent)]",
  rejected: "text-[var(--color-negative)]",
  settled: "text-[var(--color-positive)]",
  voided: "text-[var(--color-fg-muted)]",
  cashed_out: "text-[var(--color-fg-muted)]",
};

function resolveStatusBadge(ticket: TicketSummary): {
  label: string;
  color: string;
} {
  if (ticket.status === "settled") {
    // Compare against stake, not 0. A fully voided ticket has
    // actual_payout == stake (refund), not 0 — labeling it "Won"
    // would mis-frame a refund as a winning ticket. A half-lost or
    // partially-voided ticket has 0 < payout < stake and is correctly
    // a Lost (the bettor still came out behind).
    const payout = ticket.actualPayoutMicro
      ? BigInt(ticket.actualPayoutMicro)
      : 0n;
    const stake = BigInt(ticket.stakeMicro);
    if (payout > stake) {
      return { label: "Won", color: "text-[var(--color-positive)]" };
    }
    if (payout === stake) {
      return { label: "Voided", color: "text-[var(--color-fg-muted)]" };
    }
    return { label: "Lost", color: "text-[var(--color-negative)]" };
  }
  return {
    label: STATUS_LABEL[ticket.status],
    color: STATUS_COLOR[ticket.status],
  };
}

function fmtOdds(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

export function BetHistory({
  initialTickets,
}: {
  initialTickets: TicketSummary[];
}) {
  const [tickets, setTickets] = useState<TicketSummary[]>(initialTickets);

  // Re-sync when the server delivers fresher data on route refresh.
  useEffect(() => {
    setTickets(initialTickets);
  }, [initialTickets]);

  // Live WS frames push status changes without polling.
  useTicketStream((frame: WsTicketFrame) => {
    setTickets((prev) =>
      prev.map((t) =>
        t.id === frame.ticketId
          ? {
              ...t,
              status: frame.status,
              rejectReason: frame.rejectReason ?? t.rejectReason,
              actualPayoutMicro:
                frame.actualPayoutMicro ?? t.actualPayoutMicro,
            }
          : t,
      ),
    );
  });

  const onCashedOut = useCallback(
    (ticketId: string, payoutMicro: string, cashedOutAt: string) => {
      setTickets((prev) =>
        prev.map((t) =>
          t.id === ticketId
            ? {
                ...t,
                status: "cashed_out" as TicketStatus,
                actualPayoutMicro: payoutMicro,
                settledAt: cashedOutAt,
              }
            : t,
        ),
      );
    },
    [],
  );

  if (tickets.length === 0) {
    return (
      <p className="mt-8 text-sm text-[var(--color-fg-muted)]">
        No bets yet. Head to a match page and add a selection to the slip.
      </p>
    );
  }

  return (
    <ul className="mt-8 space-y-3">
      {tickets.map((t) => (
        <TicketRow key={t.id} ticket={t} onCashedOut={onCashedOut} />
      ))}
    </ul>
  );
}

function TicketRow({
  ticket,
  onCashedOut,
}: {
  ticket: TicketSummary;
  onCashedOut: (
    ticketId: string,
    payoutMicro: string,
    cashedOutAt: string,
  ) => void;
}) {
  const stakeMicro = BigInt(ticket.stakeMicro);
  const stake = fromMicro(stakeMicro);
  const potential = fromMicro(BigInt(ticket.potentialPayoutMicro));
  const actual = ticket.actualPayoutMicro
    ? fromMicro(BigInt(ticket.actualPayoutMicro))
    : null;
  const legCount = ticket.selections.length;

  // Current-odds comparison only makes sense while the ticket is open
  // (pending_delay / accepted) — once it's settled / cashed out / voided
  // the placement price is the only thing that mattered.
  const isOpen =
    ticket.status === "pending_delay" || ticket.status === "accepted";

  // Per-leg drift indicator is gated to legs whose match hasn't started
  // yet — live legs rely on the cashout panel for the moving picture, and
  // showing a raw current-odds delta there would be misleading because
  // the price keeps moving with every game tick.
  const showLegDrift = isOpen;

  // Combined "current total odds" only when every leg is prematch + still
  // bettable + has a current price. Tippot / tiple / betbuilder use a
  // non-multiplicative pricing model (tier table / Oddin OBB session), so
  // a stake × Π(currentOdds) recompute would be wrong for those — gate to
  // single + combo only.
  const canRecomputeTotal =
    isOpen && (ticket.betType === "single" || ticket.betType === "combo");

  let currentTotalOdds: number | null = null;
  let currentPotentialWin: string | null = null;
  if (canRecomputeTotal) {
    let product = 1;
    let allPrematchAndAvailable = true;
    for (const s of ticket.selections) {
      const m = s.market;
      const price = fmtOdds(m?.currentOdds ?? null);
      if (
        !m ||
        m.matchStatus !== "not_started" ||
        !m.currentlyActive ||
        !price
      ) {
        allPrematchAndAvailable = false;
        break;
      }
      product *= Number(price);
    }
    if (allPrematchAndAvailable && Number.isFinite(product) && product > 0) {
      currentTotalOdds = product;
      // Reuse the same floor-rounding helper settlement uses so the
      // displayed "now X" lines up with what the user would actually
      // get if they re-placed the slip right now.
      const winMicro = multiplyMicroByOdds(stakeMicro, product);
      currentPotentialWin = fromMicro(winMicro);
      // Sanity: if recomputed equals placement-frozen potential, drop
      // the duplicate so the footer doesn't show two identical numbers.
      if (winMicro === BigInt(ticket.potentialPayoutMicro)) {
        currentPotentialWin = null;
      }
    }
  }

  const badge = resolveStatusBadge(ticket);

  return (
    <li className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            <span>{ticket.betType}</span>
            {legCount > 1 ? (
              <>
                <span>·</span>
                <span>{legCount} legs</span>
              </>
            ) : null}
            <span>·</span>
            <time dateTime={ticket.placedAt}>
              {new Date(ticket.placedAt).toLocaleString()}
            </time>
            <span>·</span>
            <span className="font-mono">{ticket.id.slice(0, 8)}</span>
          </div>

          {/* Per-leg list. Singles render as one row; combos / tiples /
              tippots / betbuilder render every leg with its odds, per-
              leg result colour, a result tag (WON / LOST / VOID), and
              the effective factor for void legs (×1.00). Strikethrough
              the placement odds when they didn't carry through to the
              payout (lost = ×0; void = ×1) so the combo math reads
              correctly. */}
          {ticket.selections.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1.5">
              {ticket.selections.map((s, i) => {
                const m = s.market;
                const isWon = s.result === "won" || s.result === "half_won";
                const isLost =
                  s.result === "lost" || s.result === "half_lost";
                const isVoid = s.result === "void";
                const legResultClass = isWon
                  ? "text-[var(--color-positive)]"
                  : isLost
                    ? "text-[var(--color-negative)]"
                    : isVoid
                      ? "text-[var(--color-fg-muted)]"
                      : "text-[var(--color-fg)]";
                const placementOdds = fmtOdds(s.oddsAtPlacement) ??
                  s.oddsAtPlacement;
                const currentOdds = m ? fmtOdds(m.currentOdds) : null;
                const matchLabel = m
                  ? `${m.homeTeam} vs ${m.awayTeam}`
                  : "Match unavailable";
                const outcomeLabel =
                  m?.outcomeName?.trim() || `outcome ${s.outcomeId}`;
                const tagLabel = isWon
                  ? "WON"
                  : isLost
                    ? "LOST"
                    : isVoid
                      ? "VOID"
                      : null;
                const effectiveFactor = isVoid
                  ? "×1.00"
                  : isLost
                    ? "×0.00"
                    : null;
                const strikeOdds = isVoid || isLost;

                // Drift line: only for prematch legs of an open ticket
                // whose outcome is still currently quotable. Live legs
                // and finalised legs intentionally don't render this.
                const showLegCurrent =
                  showLegDrift &&
                  m &&
                  m.matchStatus === "not_started" &&
                  m.currentlyActive &&
                  currentOdds !== null;
                const placementNum = Number(s.oddsAtPlacement);
                const driftPct = showLegCurrent &&
                  Number.isFinite(placementNum) &&
                  placementNum > 0
                  ? ((Number(currentOdds) - placementNum) / placementNum) * 100
                  : null;
                const driftDir = driftPct === null
                  ? null
                  : driftPct > 0.5
                    ? "up"
                    : driftPct < -0.5
                      ? "down"
                      : "flat";
                const driftClass = driftDir === "up"
                  ? "text-[var(--color-positive)]"
                  : driftDir === "down"
                    ? "text-[var(--color-negative)]"
                    : "text-[var(--color-fg-muted)]";
                const driftArrow = driftDir === "up"
                  ? "▲"
                  : driftDir === "down"
                    ? "▼"
                    : "·";

                // Suspended / closed underlying — show a subtle hint so
                // the user understands why no current price is rendered.
                const showLegInactiveHint =
                  showLegDrift &&
                  m &&
                  m.matchStatus === "not_started" &&
                  !m.currentlyActive;

                const inner = (
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span
                        className={
                          "min-w-0 flex-1 truncate " + legResultClass
                        }
                      >
                        {matchLabel}
                        <span className="ml-2 text-xs text-[var(--color-fg-subtle)]">
                          {outcomeLabel}
                        </span>
                      </span>
                      {tagLabel ? (
                        <span
                          className={
                            "font-mono text-[10px] tracking-[0.06em] font-semibold " +
                            legResultClass
                          }
                        >
                          {tagLabel}
                        </span>
                      ) : null}
                      <span
                        className={
                          "font-mono text-xs text-[var(--color-fg-muted)] " +
                          (strikeOdds ? "line-through" : "")
                        }
                      >
                        {placementOdds}
                      </span>
                      {effectiveFactor ? (
                        <span
                          className={
                            "font-mono text-xs " + legResultClass
                          }
                        >
                          {effectiveFactor}
                        </span>
                      ) : null}
                    </div>
                    {showLegCurrent ? (
                      <div className="flex items-center justify-end gap-2 text-[11px]">
                        <span className="text-[var(--color-fg-subtle)]">
                          current
                        </span>
                        <span className="font-mono text-[var(--color-fg-muted)]">
                          {currentOdds}
                        </span>
                        <span className={"font-mono " + driftClass}>
                          {driftArrow}{" "}
                          {driftPct !== null && driftDir !== "flat"
                            ? `${driftPct > 0 ? "+" : ""}${driftPct.toFixed(1)}%`
                            : "flat"}
                        </span>
                      </div>
                    ) : showLegInactiveHint ? (
                      <div className="flex items-center justify-end gap-2 text-[11px] text-[var(--color-fg-subtle)]">
                        outcome currently suspended
                      </div>
                    ) : null}
                  </div>
                );
                return (
                  <li
                    key={`${s.marketId}:${s.outcomeId}:${i}`}
                    className="block"
                  >
                    {m ? (
                      <Link
                        href={`/match/${m.matchId}`}
                        className="block hover:underline decoration-[var(--color-border-strong)] hover:decoration-[var(--color-accent)]"
                      >
                        {inner}
                      </Link>
                    ) : (
                      inner
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
              Selection metadata unavailable
            </p>
          )}

          {ticket.rejectReason ? (
            <p className="mt-2 text-xs text-[var(--color-negative)]">
              Reason: {ticket.rejectReason}
            </p>
          ) : null}
        </div>

        <span
          className={
            "shrink-0 text-xs uppercase tracking-[0.15em] " + badge.color
          }
        >
          {badge.label}
        </span>
      </div>

      {/* Money footer: stake on the left, settled / potential payout on
          the right. Made deliberately prominent (larger numerals, a
          divider above) because "how much did I bet" / "how much can I
          win" are the two questions every bettor wants the answer to in
          one glance. */}
      <div className="mt-4 flex items-end justify-between gap-4 border-t border-[var(--color-border)] pt-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Stake
          </div>
          <div className="font-mono text-lg">
            {stake} {ticket.currency}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            {actual !== null ? "Payout" : "Potential win"}
          </div>
          <div className="font-mono text-lg">
            {actual ?? potential} {ticket.currency}
          </div>
          {actual === null && currentPotentialWin !== null ? (
            <div className="mt-0.5 font-mono text-[11px] text-[var(--color-fg-muted)]">
              now {currentPotentialWin} {ticket.currency}
              {currentTotalOdds !== null ? (
                <span className="ml-1 text-[var(--color-fg-subtle)]">
                  @ {currentTotalOdds.toFixed(2)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <CashoutPanel ticket={ticket} onCashedOut={onCashedOut} />
    </li>
  );
}
