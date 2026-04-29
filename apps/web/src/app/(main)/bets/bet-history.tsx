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
    const won =
      ticket.actualPayoutMicro != null && BigInt(ticket.actualPayoutMicro) > 0n;
    return won
      ? { label: "Won", color: "text-[var(--color-positive)]" }
      : { label: "Lost", color: "text-[var(--color-negative)]" };
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
  const selection = ticket.selections[0];
  const stake = fromMicro(BigInt(ticket.stakeMicro));
  const potential = fromMicro(BigInt(ticket.potentialPayoutMicro));
  const actual = ticket.actualPayoutMicro
    ? fromMicro(BigInt(ticket.actualPayoutMicro))
    : null;

  return (
    <li className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            <span>{ticket.betType}</span>
            <span>·</span>
            <time dateTime={ticket.placedAt}>
              {new Date(ticket.placedAt).toLocaleString()}
            </time>
            <span>·</span>
            <span className="font-mono">{ticket.id.slice(0, 8)}</span>
          </div>

          {selection?.market ? (
            <p className="mt-2 text-sm">
              {selection.market.homeTeam}{" "}
              <span className="text-[var(--color-fg-subtle)]">vs</span>{" "}
              {selection.market.awayTeam}
            </p>
          ) : (
            <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
              Selection metadata unavailable
            </p>
          )}

          {selection ? (
            <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
              Market {selection.market?.providerMarketId ?? "?"} · outcome{" "}
              {selection.outcomeId} @ {selection.oddsAtPlacement}
            </p>
          ) : null}

          {ticket.rejectReason ? (
            <p className="mt-2 text-xs text-[var(--color-negative)]">
              Reason: {ticket.rejectReason}
            </p>
          ) : null}

          {selection?.market ? (
            <Link
              href={`/match/${selection.market.matchId}`}
              className="mt-2 inline-block text-xs text-[var(--color-fg-muted)] underline decoration-[var(--color-border-strong)] hover:decoration-[var(--color-accent)]"
            >
              View match →
            </Link>
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
