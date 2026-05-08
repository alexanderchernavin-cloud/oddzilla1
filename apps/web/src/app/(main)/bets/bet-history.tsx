"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fromMicro } from "@oddzilla/types/money";
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
  const stake = fromMicro(BigInt(ticket.stakeMicro));
  const potential = fromMicro(BigInt(ticket.potentialPayoutMicro));
  const actual = ticket.actualPayoutMicro
    ? fromMicro(BigInt(ticket.actualPayoutMicro))
    : null;
  const legCount = ticket.selections.length;

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
                const legOdds = Number(s.oddsAtPlacement);
                const oddsLabel = Number.isFinite(legOdds)
                  ? legOdds.toFixed(2)
                  : s.oddsAtPlacement;
                const matchLabel = m
                  ? `${m.homeTeam} vs ${m.awayTeam}`
                  : "Match unavailable";
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
                const inner = (
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span
                      className={
                        "min-w-0 flex-1 truncate " + legResultClass
                      }
                    >
                      {matchLabel}
                      <span className="ml-2 text-xs text-[var(--color-fg-subtle)]">
                        outcome {s.outcomeId}
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
                      {oddsLabel}
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

        <div className="text-right">
          {(() => {
            const badge = resolveStatusBadge(ticket);
            return (
              <span
                className={
                  "text-xs uppercase tracking-[0.15em] " + badge.color
                }
              >
                {badge.label}
              </span>
            );
          })()}
          <p className="mt-2 font-mono text-sm">
            {stake} {ticket.currency}
          </p>
          <p className="font-mono text-xs text-[var(--color-fg-muted)]">
            → {actual ?? potential} {ticket.currency}
          </p>
        </div>
      </div>
      <CashoutPanel ticket={ticket} onCashedOut={onCashedOut} />
    </li>
  );
}
