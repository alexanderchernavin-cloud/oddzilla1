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
import { useTranslations } from "@/lib/i18n";
import { CashoutPanel } from "./cashout-panel";

const STATUS_COLOR: Record<TicketStatus, string> = {
  pending_delay: "text-[var(--color-warning)]",
  accepted: "text-[var(--color-accent)]",
  rejected: "text-[var(--color-negative)]",
  settled: "text-[var(--color-positive)]",
  voided: "text-[var(--color-fg-muted)]",
  cashed_out: "text-[var(--color-fg-muted)]",
};

// Locale-aware status badge resolver. The "settled" branch decides
// between Won / Voided / Lost from the payout-vs-stake comparison so a
// fully refunded ticket reads as Voided, not Won. Other statuses come
// straight from the dictionary.
function resolveStatusBadge(
  ticket: TicketSummary,
  tBets: (key: string, vals?: Record<string, string | number>) => string,
  tTicket: (key: string, vals?: Record<string, string | number>) => string,
): { label: string; color: string } {
  if (ticket.status === "settled") {
    const payout = ticket.actualPayoutMicro
      ? BigInt(ticket.actualPayoutMicro)
      : 0n;
    const stake = BigInt(ticket.stakeMicro);
    if (payout > stake) {
      return { label: tTicket("won"), color: "text-[var(--color-positive)]" };
    }
    if (payout === stake) {
      return { label: tBets("voided"), color: "text-[var(--color-fg-muted)]" };
    }
    return { label: tTicket("lost"), color: "text-[var(--color-negative)]" };
  }
  const STATUS_KEY: Record<TicketStatus, string> = {
    pending_delay: "pending",
    accepted: "accepted",
    rejected: "rejected",
    settled: "settled",
    voided: "voided",
    cashed_out: "cashedOut",
  };
  // Map pending_delay → ticket.pending; the rest live under bets so
  // we don't bloat the ticket namespace with statuses that aren't
  // result labels (cashed_out is a status, not a per-leg result).
  const key = STATUS_KEY[ticket.status];
  const label =
    ticket.status === "pending_delay"
      ? tTicket("pending")
      : ticket.status === "cashed_out"
        ? tTicket("cashedOut")
        : tBets(key);
  return {
    label,
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
  const t = useTranslations("bets");

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
        {t("empty")}
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
  const tBets = useTranslations("bets");
  const tTicket = useTranslations("ticket");
  const tSlip = useTranslations("betSlip");
  const tMatch = useTranslations("match");
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

  const badge = resolveStatusBadge(ticket, tBets, tTicket);

  // The API returns the bet type as the enum string ("single"/"combo"/…);
  // we render it as an UPPERCASE pill (CSS text-transform). Look up the
  // localized noun first, fall back to the raw enum on unknown shapes.
  const betTypeKeyMap: Record<string, string> = {
    single: "single",
    combo: "combo",
    betbuilder: "betbuilder",
    tippot: "tippot",
    tiple: "tiple",
  };
  const betTypeLabel =
    betTypeKeyMap[ticket.betType]
      ? tSlip(betTypeKeyMap[ticket.betType] as string)
      : ticket.betType;
  const legsLabel = tSlip("legs", { count: legCount });

  return (
    <li className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            <span>{betTypeLabel}</span>
            {legCount > 1 ? (
              <>
                <span>·</span>
                <span>{legsLabel}</span>
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
                  ? `${m.homeTeam} ${tMatch("vs")} ${m.awayTeam}`
                  : tBets("matchUnavailable");
                const outcomeLabel =
                  m?.outcomeName?.trim() ||
                  tBets("outcomeFallback", { id: s.outcomeId });
                // Resolved market name from market_descriptions (server
                // substitutes specifiers). Empty when the description row
                // isn't in the table yet — fall back to the provider id
                // so the user still sees *something* identifying the
                // market type rather than just the outcome.
                const marketLabel =
                  m?.marketName?.trim() ||
                  (m ? `Market #${m.providerMarketId}` : null);
                const tagLabel = isWon
                  ? tTicket("won")
                  : isLost
                    ? tTicket("lost")
                    : isVoid
                      ? tTicket("void")
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
                      </span>
                      {tagLabel ? (
                        <span
                          className={
                            "font-mono text-[10px] tracking-[0.06em] font-semibold uppercase " +
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
                    {/* Market + selection sub-line. Together they
                        answer "what did I actually bet on?" — the
                        match teams alone don't. Market name falls
                        back to "Market #N" when the description row
                        is missing; outcome name falls back to the raw
                        outcome id via tBets("outcomeFallback"). */}
                    <div className="truncate text-xs text-[var(--color-fg-muted)]">
                      {marketLabel ? (
                        <>
                          {marketLabel}
                          <span className="text-[var(--color-fg-subtle)]">
                            {" · "}
                          </span>
                        </>
                      ) : null}
                      <span className="text-[var(--color-fg)]">
                        {outcomeLabel}
                      </span>
                    </div>
                    {showLegCurrent ? (
                      <div className="flex items-center justify-end gap-2 text-[11px]">
                        <span className="text-[var(--color-fg-subtle)]">
                          {tBets("currentLabel")}
                        </span>
                        <span className="font-mono text-[var(--color-fg-muted)]">
                          {currentOdds}
                        </span>
                        <span className={"font-mono " + driftClass}>
                          {driftArrow}{" "}
                          {driftPct !== null && driftDir !== "flat"
                            ? `${driftPct > 0 ? "+" : ""}${driftPct.toFixed(1)}%`
                            : "·"}
                        </span>
                      </div>
                    ) : showLegInactiveHint ? (
                      <div className="flex items-center justify-end gap-2 text-[11px] text-[var(--color-fg-subtle)]">
                        {tBets("outcomeSuspendedHint")}
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
              {tBets("selectionMetadataUnavailable")}
            </p>
          )}

          {ticket.rejectReason ? (
            <p className="mt-2 text-xs text-[var(--color-negative)]">
              {tBets("reasonPrefix", { reason: ticket.rejectReason })}
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
            {tBets("stake")}
          </div>
          <div className="font-mono text-lg">
            {stake} {ticket.currency}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            {actual !== null ? tBets("payout") : tBets("potentialWin")}
          </div>
          <div className="font-mono text-lg">
            {actual ?? potential} {ticket.currency}
          </div>
          {actual === null && currentPotentialWin !== null ? (
            <div className="mt-0.5 font-mono text-[11px] text-[var(--color-fg-muted)]">
              {tBets("nowPrefix")} {currentPotentialWin} {ticket.currency}
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
