import Link from "next/link";
import type { CommunityTicketSummary } from "@oddzilla/types";
import { fromMicro } from "@oddzilla/types/money";
import { CopyButton } from "./copy-button";
import { ApplySamePlayButton } from "./apply-same-play-button";
import { Avatar } from "./avatar";

// One card on the community feed and the per-user tickets list.
//
// The card has three escalating presentations:
//   • Recent (status='accepted')           — Live pill, "to win" payout label.
//   • Settled / cashed_out / voided        — Won / Lost / Cashed out / Void pill.
//   • isBigWin && tab='bigWins' && idx=0   — hero card variant.
//                                            Larger profit number, gold
//                                            accent border on the
//                                            stat block. Restraint is
//                                            the rule per PRD: one
//                                            differentiator, not three.
//
// Money is rendered via fromMicro so we never lose precision converting
// to Number — a winning combo can clear several thousand units in
// micros, comfortably above MAX_SAFE_INTEGER on multi-leg.

interface SportEntry {
  id: number;
  name: string;
}

export function CommunityTicketCard({
  ticket,
  sportsById,
  isHero = false,
}: {
  ticket: CommunityTicketSummary;
  sportsById: Map<number, SportEntry>;
  isHero?: boolean;
}) {
  const sport = ticket.sportIds
    .map((id) => sportsById.get(id))
    .filter((s): s is SportEntry => Boolean(s))[0];

  const stake = fromMicro(BigInt(ticket.stakeMicro));
  const payout = fromMicro(BigInt(ticket.payoutMicro));
  const profit = fromMicro(BigInt(ticket.profitMicro));
  const isWin =
    (ticket.status === "settled" || ticket.status === "cashed_out") &&
    BigInt(ticket.payoutMicro) > BigInt(ticket.stakeMicro);
  const isLive = ticket.status === "accepted";

  const at = new Date(ticket.at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  // Accepted tickets show the *potential* payout, settled show actual.
  const payoutLabel = isLive ? "to win" : "payout";

  // Gold border on the entire card when a Big Win renders. Sibling
  // Big-Win cards (non-hero) keep the standard slate border and only
  // wear the badge — restraint per the PRD design notes.
  const cardCls = isHero
    ? "card p-5 border-[var(--color-accent)]"
    : "card p-5";
  // Hero uses text-h3-equivalent (PRD: "text-h3 profit on hero, text-h4
  // elsewhere"). Tailwind doesn't ship those tokens here, so we
  // approximate the intent: hero gets text-2xl tabular-nums, sibling
  // gets text-base. Matches the existing typography ramp in
  // apps/web/src/app/globals.css.
  const profitTextCls = isHero
    ? "font-mono text-2xl text-[var(--color-positive)]"
    : "font-mono text-sm text-[var(--color-positive)]";

  return (
    <li className={cardCls}>
      <div className="flex items-start justify-between gap-4">
        <Link
          href={`/u/${encodeURIComponent(ticket.nickname)}`}
          className="shrink-0 hover:opacity-80"
          aria-label={`${ticket.nickname}'s profile`}
        >
          <Avatar
            imageUrl={ticket.avatarUrl}
            name={ticket.nickname}
            size={isHero ? 56 : 40}
          />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {ticket.isBigWin ? <BigWinBadge /> : null}
            <Link
              href={`/u/${encodeURIComponent(ticket.nickname)}`}
              className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg)] hover:text-[var(--color-accent)]"
            >
              {ticket.nickname}
            </Link>
            <DotMeta>{at}</DotMeta>
            <DotMeta>{ticket.currency}</DotMeta>
            {sport ? <DotMeta>{sport.name}</DotMeta> : null}
            {ticket.inspirationCount > 0 ? (
              <span
                className="ml-auto inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]"
                title="Times this bet has been copied"
              >
                <span aria-hidden>🔥</span>
                {ticket.inspirationCount}
              </span>
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
          {/* Settled wins lead with profit (the focal value); accepted
              tickets lead with potential payout since profit there is
              speculative. Hero variant just enlarges the profit; the
              data is the same. */}
          {isWin ? (
            <p className={`mt-2 ${profitTextCls}`}>
              +{profit} {ticket.currency}
            </p>
          ) : (
            <p className="mt-2 font-mono text-sm">
              {payout} {ticket.currency}
            </p>
          )}
          <p className="font-mono text-xs text-[var(--color-fg-muted)]">
            {isWin ? `payout ${payout} · stake ${stake}` : `${payoutLabel} · stake ${stake} ${ticket.currency}`}
          </p>
        </div>
      </div>

      <div className="mt-3 flex justify-end border-t border-[var(--color-border-strong)] pt-3">
        {/* Big-Win settled cards use Apply Same Play — the
            originating match is over, so the user needs the
            modal's "find me an upcoming analog" flow instead of
            the literal copy. Every other card (Recent in-flight,
            non-Big-Win settled) keeps the direct Copy CTA where
            "place the same legs" is still a meaningful action. */}
        {ticket.isBigWin && !isLive ? (
          <ApplySamePlayButton ticketId={ticket.ticketId} />
        ) : (
          <CopyButton ticketId={ticket.ticketId} />
        )}
      </div>
    </li>
  );
}

// Gold-bordered Big Win pill with a trophy. PRD calls for `--chart-3`
// text and a `--background` fill; the existing token names in
// globals.css are different so we lean on the accent token (gold)
// which carries the same Big Win identity.
function BigWinBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-accent)] bg-[var(--color-bg)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-accent)]">
      <span aria-hidden>🏆</span>
      Big win
    </span>
  );
}

function DotMeta({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span aria-hidden className="text-xs text-[var(--color-fg-subtle)]">
        ·
      </span>
      <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {children}
      </span>
    </>
  );
}

function StatusPill({
  status,
  isWin,
}: {
  status: CommunityTicketSummary["status"];
  isWin: boolean;
}) {
  if (status === "accepted") {
    return (
      <span className="inline-block rounded-full bg-[var(--color-accent)]/15 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-accent)]">
        Live
      </span>
    );
  }
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
