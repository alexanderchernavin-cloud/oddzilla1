import Link from "next/link";
import type { CommunityTicketSummary } from "@oddzilla/types";
import { fromMicro } from "@oddzilla/types/money";
import { CopyButton } from "./copy-button";

// One card on the community feed and the per-user tickets list. The
// shape is deliberately minimal for 10.2 — Phase 10.3 will add a
// "Copy this bet" CTA and individual leg breakdown. Money is rendered
// via fromMicro so we never lose precision converting to Number.

interface SportEntry {
  id: number;
  name: string;
}

export function CommunityTicketCard({
  ticket,
  sportsById,
}: {
  ticket: CommunityTicketSummary;
  sportsById: Map<number, SportEntry>;
}) {
  const sport = ticket.sportIds
    .map((id) => sportsById.get(id))
    .filter((s): s is SportEntry => Boolean(s))[0];

  const stake = fromMicro(BigInt(ticket.stakeMicro));
  const payout = fromMicro(BigInt(ticket.payoutMicro));
  const isWin =
    (ticket.status === "settled" || ticket.status === "cashed_out") &&
    BigInt(ticket.payoutMicro) > BigInt(ticket.stakeMicro);

  const settled = new Date(ticket.settledAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <li className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            <Link
              href={`/u/${encodeURIComponent(ticket.nickname)}`}
              className="text-[var(--color-fg)] hover:text-[var(--color-accent)]"
            >
              {ticket.nickname}
            </Link>
            <span aria-hidden>·</span>
            <span>{settled}</span>
            <span aria-hidden>·</span>
            <span>{ticket.currency}</span>
            {sport ? (
              <>
                <span aria-hidden>·</span>
                <span>{sport.name}</span>
              </>
            ) : null}
          </div>

          {ticket.bio ? (
            <p className="mt-2 max-w-prose text-sm text-[var(--color-fg-muted)]">
              {ticket.bio}
            </p>
          ) : null}

          <p className="mt-3 text-sm">
            <span className="text-[var(--color-fg-subtle)]">
              {labelForBetType(ticket.betType, ticket.numLegs)}
            </span>
            <span aria-hidden> · </span>
            <span className="font-mono">@{ticket.totalOdds}</span>
          </p>
        </div>

        <div className="text-right">
          <StatusPill status={ticket.status} isWin={isWin} />
          <p className="mt-2 font-mono text-sm">
            {payout} {ticket.currency}
          </p>
          <p className="font-mono text-xs text-[var(--color-fg-muted)]">
            stake {stake} {ticket.currency}
          </p>
        </div>
      </div>

      <div className="mt-3 flex justify-end border-t border-[var(--color-border-strong)] pt-3">
        <CopyButton ticketId={ticket.ticketId} />
      </div>
    </li>
  );
}

function StatusPill({
  status,
  isWin,
}: {
  status: CommunityTicketSummary["status"];
  isWin: boolean;
}) {
  if (status === "cashed_out") {
    return (
      <span className="inline-block rounded-full border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
        Cashed out
      </span>
    );
  }
  if (status === "voided") {
    return (
      <span className="inline-block rounded-full border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
        Void
      </span>
    );
  }
  // settled
  return (
    <span
      className={
        "inline-block rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] " +
        (isWin
          ? "bg-[var(--color-positive)]/15 text-[var(--color-positive)]"
          : "bg-[var(--color-negative)]/15 text-[var(--color-negative)]")
      }
    >
      {isWin ? "Won" : "Lost"}
    </span>
  );
}

function labelForBetType(
  betType: CommunityTicketSummary["betType"],
  numLegs: number,
): string {
  if (betType === "single") return "Single";
  if (betType === "combo") return `Combo · ${numLegs} legs`;
  if (betType === "tiple") return `Tiple · ${numLegs} legs`;
  if (betType === "tippot") return `Tippot · ${numLegs} legs`;
  return `System · ${numLegs} legs`;
}
