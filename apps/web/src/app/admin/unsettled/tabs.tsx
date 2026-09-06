"use client";

// Client half of /admin/unsettled: the two lists, plus the per-match
// drill-down into individual market rows.
//
// Markets are grouped by match because the population is tens of
// thousands of ladder-line market rows across a few hundred matches, and
// the match is the unit an operator reasons about. The market rows are
// fetched on expand so the page's first paint stays small.

import { useCallback, useEffect, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import type { UnsettledMatch, UnsettledTicket } from "./page";

interface MarketRow {
  marketId: string;
  providerMarketId: number;
  marketStatus: number;
  specifiers: string | null;
  marketName: string | null;
  outcomes: number;
  outcomesWithResult: number;
  openTickets: number;
}

// markets.status codes, per the feed contract. -3 settled / -4 cancelled
// are terminal and therefore never appear on this page.
const MARKET_STATUS: Record<number, string> = {
  1: "active",
  0: "inactive",
  [-1]: "suspended",
  [-2]: "handover",
};

function fmtMicro(micro: string): string {
  const neg = micro.startsWith("-");
  const digits = (neg ? micro.slice(1) : micro).padStart(7, "0");
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(-6).replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${body}` : body;
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(0, Math.round(ms / 60_000))}m ago`;
  if (h < 48) return `${h.toFixed(1)}h ago`;
  return `${(h / 24).toFixed(1)}d ago`;
}

export function UnsettledTabs({
  matches,
  tickets,
  bySport,
}: {
  matches: UnsettledMatch[];
  tickets: UnsettledTicket[];
  bySport: Array<{
    sportSlug: string;
    sportName: string;
    provider: string;
    matches: number;
    markets: number;
  }>;
}) {
  const [tab, setTab] = useState<"markets" | "tickets" | "sports" | "misses">("markets");

  return (
    <div className="mt-8">
      <div className="flex gap-1 border-b border-[var(--color-border)]">
        <TabButton active={tab === "markets"} onClick={() => setTab("markets")}>
          Markets by match ({matches.length})
        </TabButton>
        <TabButton active={tab === "tickets"} onClick={() => setTab("tickets")}>
          Stuck tickets ({tickets.length})
        </TabButton>
        <TabButton active={tab === "sports"} onClick={() => setTab("sports")}>
          By sport
        </TabButton>
        <TabButton active={tab === "misses"} onClick={() => setTab("misses")}>
          Unmatched results
        </TabButton>
      </div>

      {tab === "markets" ? <MarketsTab matches={matches} /> : null}
      {tab === "tickets" ? <TicketsTab tickets={tickets} /> : null}
      {tab === "sports" ? <SportsTab rows={bySport} /> : null}
      {tab === "misses" ? <MissesTab /> : null}
    </div>
  );
}

// ─── Unmatched results ─────────────────────────────────────────────────────
//
// Pending Fonbet fixtures the results grader could not find under the name
// we hold, with what the results document listed for the same competition.
// Written by fonbet-ingester every pass (fonbet_settlement_misses,
// migration 0111); a fixture disappears from here the pass it is found.

interface MissRow {
  matchId: string;
  providerUrn: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  segmentId: number;
  candidates: Array<{ name: string; startTime: number; score: string; status: number }>;
  openMarkets: number;
  firstSeenAt: string;
  lastSeenAt: string;
  attempts: number;
  matchStatus: string;
  sportSlug: string;
  tournamentName: string;
}

function MissesTab() {
  const [rows, setRows] = useState<MissRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    clientApi<{ misses: MissRow[] }>("/admin/unsettled/misses")
      .then((res) => {
        if (!cancelled) setRows(res.misses);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the unmatched fixtures.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="mt-8 text-sm text-[var(--color-danger,#b4443c)]">{error}</p>;
  }
  if (rows === null) {
    return <p className="mt-8 text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="mt-8 text-sm text-[var(--color-fg-muted)]">
        Every pending Fonbet fixture was found in the results feed on the last pass.
      </p>
    );
  }
  return (
    <div className="mt-6 overflow-x-auto rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
          <tr>
            <Th>Our fixture</Th>
            <Th>Sport · Tournament</Th>
            <Th>Start</Th>
            <Th className="text-right">Open markets</Th>
            <Th className="text-right">Passes</Th>
            <Th>What the results feed listed for this competition</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.map((r) => (
            <tr key={r.matchId} className="align-top">
              <Td>
                <div className="font-medium">
                  {r.homeTeam} <span className="text-[var(--color-fg-subtle)]">vs</span> {r.awayTeam}
                </div>
                <div className="mt-1 font-mono text-[11px] text-[var(--color-fg-subtle)]">
                  id {r.matchId} · {r.matchStatus} · segment {r.segmentId}
                </div>
              </Td>
              <Td>
                <div>{r.sportSlug}</div>
                <div className="text-[12px] text-[var(--color-fg-muted)]">{r.tournamentName}</div>
              </Td>
              <Td className="whitespace-nowrap">
                {r.scheduledAt ? new Date(r.scheduledAt).toLocaleString() : "—"}
              </Td>
              <Td className="text-right font-mono">{r.openMarkets}</Td>
              <Td className="text-right font-mono">
                {r.attempts}
                <div className="text-[10px] text-[var(--color-fg-subtle)]">since {ago(r.firstSeenAt)}</div>
              </Td>
              <Td>
                {r.candidates.length === 0 ? (
                  <span className="text-xs text-[var(--color-fg-muted)]">
                    nothing for this competition on those line days
                  </span>
                ) : (
                  <ul className="space-y-0.5 text-xs">
                    {r.candidates.map((c, i) => (
                      <li key={i} className="font-mono">
                        {c.name}{" "}
                        <span className="text-[var(--color-fg-subtle)]">
                          {new Date(c.startTime * 1000).toLocaleString()} · {c.score || "—"} ·{" "}
                          {c.status === 3 ? "finished" : c.status === 4 ? "cancelled" : `status ${c.status}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors ${
        active
          ? "border-[var(--color-accent,#0d5c63)] font-medium text-[var(--color-fg)]"
          : "border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
      }`}
    >
      {children}
    </button>
  );
}

function MarketsTab({ matches }: { matches: UnsettledMatch[] }) {
  if (matches.length === 0) {
    return (
      <p className="mt-8 text-sm text-[var(--color-fg-muted)]">
        Nothing unsettled. Every finished match has a terminal book.
      </p>
    );
  }
  return (
    <div className="mt-6 overflow-x-auto rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
          <tr>
            <Th>Match</Th>
            <Th>Sport · Tournament</Th>
            <Th>Finished</Th>
            <Th className="text-right">Unsettled</Th>
            <Th className="text-right">Open tickets</Th>
            <Th className="text-right">Stake held</Th>
            <Th />
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {matches.map((m) => (
            <MatchRow key={m.matchId} match={m} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatchRow({ match }: { match: UnsettledMatch }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<MarketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await clientApi<{ markets: MarketRow[] }>(
        `/admin/unsettled/matches/${match.matchId}/markets`,
      );
      setRows(res.markets);
    } catch {
      setError("Could not load market rows.");
    }
  }, [match.matchId]);

  useEffect(() => {
    if (open && rows === null && error === null) void load();
  }, [open, rows, error, load]);

  const hasMoney = match.openTickets > 0;

  // Operator void. Publishes a cancel onto settlement.external for one
  // market, or for every open market of the match; services/settlement
  // applies it (market -4, selections void, tickets refunded) within a
  // second or two, so the rows are re-fetched after a short pause.
  const [voiding, setVoiding] = useState<string | null>(null);
  const [voidError, setVoidError] = useState<string | null>(null);
  const voidMarket = useCallback(
    async (marketId: string, label: string) => {
      if (
        !window.confirm(
          `Void ${label}?\n\nEvery selection on it is refunded and any paid ticket is reversed. This is an operator decision recorded in the audit log.`,
        )
      )
        return;
      setVoidError(null);
      setVoiding(marketId);
      try {
        await clientApi(`/admin/unsettled/markets/${marketId}/void`, {
          method: "POST",
          body: JSON.stringify({ reason: "operator void from /admin/unsettled" }),
        });
        await new Promise((r) => setTimeout(r, 1500));
        await load();
      } catch (e) {
        setVoidError(e instanceof ApiFetchError ? e.body.message : "Void failed.");
      } finally {
        setVoiding(null);
      }
    },
    [load],
  );
  const voidAll = useCallback(async () => {
    if (
      !window.confirm(
        `Void ALL ${match.unsettledMarkets} open markets on ${match.homeTeam} vs ${match.awayTeam}?\n\nEvery selection is refunded and any paid ticket is reversed. Recorded in the audit log.`,
      )
    )
      return;
    setVoidError(null);
    setVoiding("all");
    try {
      await clientApi(`/admin/unsettled/matches/${match.matchId}/void-open`, {
        method: "POST",
        body: JSON.stringify({ reason: "operator void-all from /admin/unsettled" }),
      });
      await new Promise((r) => setTimeout(r, 2000));
      await load();
    } catch (e) {
      setVoidError(e instanceof ApiFetchError ? e.body.message : "Void failed.");
    } finally {
      setVoiding(null);
    }
  }, [load, match]);

  return (
    <>
      <tr className="align-top">
        <Td>
          <div className="font-medium">
            {match.homeTeam}{" "}
            <span className="text-[var(--color-fg-subtle)]">vs</span>{" "}
            {match.awayTeam}
          </div>
          <div className="mt-1 font-mono text-[11px] text-[var(--color-fg-subtle)]">
            id {match.matchId} · {match.provider} · {match.matchStatus}
          </div>
        </Td>
        <Td>
          <div>{match.sportName}</div>
          <div className="text-[12px] text-[var(--color-fg-muted)]">
            {match.categoryName ? `${match.categoryName} · ` : ""}
            {match.tournamentName}
          </div>
        </Td>
        <Td>
          <time dateTime={match.scheduledAt} className="whitespace-nowrap">
            {new Date(match.scheduledAt).toLocaleString()}
          </time>
          <div className="text-[12px] text-[var(--color-fg-subtle)]">
            {ago(match.scheduledAt)}
          </div>
        </Td>
        <Td className="text-right font-mono">
          {match.unsettledMarkets}
          {match.activeMarkets > 0 ? (
            <div className="text-[11px] text-[var(--color-fg-subtle)]">
              {match.activeMarkets} still active
            </div>
          ) : null}
        </Td>
        <Td
          className={`text-right font-mono ${
            hasMoney ? "text-[var(--color-danger,#b4443c)]" : ""
          }`}
        >
          {match.openTickets}
        </Td>
        <Td className="text-right font-mono">
          {match.openStakeMicro === "0" ? "—" : fmtMicro(match.openStakeMicro)}
        </Td>
        <Td className="text-right">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            aria-expanded={open}
          >
            {open ? "Hide" : "Markets"}
          </button>
        </Td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={7} className="bg-[var(--color-bg)] px-4 py-3">
            {error ? (
              <p className="text-xs text-[var(--color-danger,#b4443c)]">{error}</p>
            ) : rows === null ? (
              <p className="text-xs text-[var(--color-fg-muted)]">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="text-xs text-[var(--color-fg-muted)]">
                No open markets left on this match.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-[11px] text-[var(--color-fg-subtle)]">
                    {rows.length} open market{rows.length === 1 ? "" : "s"} on a finished match.
                    Voiding refunds every selection; only for a market nothing can grade.
                  </span>
                  <button
                    type="button"
                    onClick={() => void voidAll()}
                    disabled={voiding !== null}
                    className="rounded-full border border-[var(--color-danger,#b4443c)] px-3 py-1 text-[11px] text-[var(--color-danger,#b4443c)] disabled:opacity-50"
                  >
                    {voiding === "all" ? "Voiding…" : "Void all open"}
                  </button>
                </div>
                {voidError ? (
                  <p className="mb-2 text-xs text-[var(--color-danger,#b4443c)]">{voidError}</p>
                ) : null}
                <table className="w-full text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-fg-subtle)]">
                    <tr>
                      <th className="py-1 pr-4 font-medium">Market</th>
                      <th className="py-1 pr-4 font-medium">Specifiers</th>
                      <th className="py-1 pr-4 font-medium">Status</th>
                      <th className="py-1 pr-4 text-right font-medium">Outcomes</th>
                      <th className="py-1 pr-4 text-right font-medium">Graded</th>
                      <th className="py-1 pr-4 text-right font-medium">Tickets</th>
                      <th className="py-1 text-right font-medium" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {rows.map((r) => (
                      <tr key={r.marketId}>
                        <td className="py-1.5 pr-4">
                          {r.marketName?.trim() ? r.marketName : `Market #${r.providerMarketId}`}
                          <span className="ml-2 font-mono text-[10px] text-[var(--color-fg-subtle)]">
                            pmid {r.providerMarketId} · id {r.marketId}
                          </span>
                        </td>
                        <td className="py-1.5 pr-4 font-mono text-[10px] text-[var(--color-fg-muted)]">
                          {r.specifiers && r.specifiers !== "{}"
                            ? r.specifiers
                            : "—"}
                        </td>
                        <td className="py-1.5 pr-4">
                          {MARKET_STATUS[r.marketStatus] ?? r.marketStatus}
                        </td>
                        <td className="py-1.5 pr-4 text-right font-mono">
                          {r.outcomes}
                        </td>
                        <td className="py-1.5 pr-4 text-right font-mono">
                          {r.outcomesWithResult}
                        </td>
                        <td
                          className={`py-1.5 pr-4 text-right font-mono ${
                            r.openTickets > 0
                              ? "text-[var(--color-danger,#b4443c)]"
                              : ""
                          }`}
                        >
                          {r.openTickets}
                        </td>
                        <td className="py-1.5 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              void voidMarket(
                                r.marketId,
                                `${r.marketName?.trim() ? r.marketName : `market #${r.providerMarketId}`}${
                                  r.specifiers && r.specifiers !== "{}" ? ` ${r.specifiers}` : ""
                                }`,
                              )
                            }
                            disabled={voiding !== null}
                            className="rounded-full border border-[var(--color-border)] px-2.5 py-0.5 text-[11px] text-[var(--color-danger,#b4443c)] disabled:opacity-50"
                          >
                            {voiding === r.marketId ? "Voiding…" : "Void"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function TicketsTab({ tickets }: { tickets: UnsettledTicket[] }) {
  if (tickets.length === 0) {
    return (
      <p className="mt-8 text-sm text-[var(--color-fg-muted)]">
        No stuck tickets. Every open ticket is still waiting on a match that
        has not finished yet.
      </p>
    );
  }
  return (
    <>
      <p className="mt-4 max-w-3xl text-xs text-[var(--color-fg-muted)]">
        Tickets whose stake is already debited and which cannot resolve, because
        at least one leg sits on a finished match with a non-terminal market.
        <strong> All legs graded</strong> marks the different case where every
        leg already has a result but the ticket was never paid — that one is a
        bug on our side and settlement&apos;s own reconcile sweep should clear it.
      </p>
      <div className="mt-4 overflow-x-auto rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
            <tr>
              <Th>Ticket</Th>
              <Th>Bettor</Th>
              <Th>Placed</Th>
              <Th className="text-right">Stake</Th>
              <Th className="text-right">Potential payout</Th>
              <Th className="text-right">Legs</Th>
              <Th>Blocked by</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {tickets.map((t) => (
              <tr key={t.ticketId} className="align-top">
                <Td>
                  <div className="font-mono text-[11px]">{t.ticketId}</div>
                  <div className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
                    {t.betType} · {t.ticketStatus}
                  </div>
                </Td>
                <Td>
                  <a
                    href={`/admin/users/${t.userId}`}
                    className="underline decoration-dotted underline-offset-2"
                  >
                    {t.userNickname ?? t.userEmail}
                  </a>
                  {t.userNickname ? (
                    <div className="text-[12px] text-[var(--color-fg-subtle)]">
                      {t.userEmail}
                    </div>
                  ) : null}
                </Td>
                <Td>
                  <time dateTime={t.placedAt} className="whitespace-nowrap">
                    {new Date(t.placedAt).toLocaleString()}
                  </time>
                  <div className="text-[12px] text-[var(--color-fg-subtle)]">
                    {ago(t.placedAt)}
                  </div>
                </Td>
                <Td className="text-right font-mono whitespace-nowrap">
                  {fmtMicro(t.stakeMicro)} {t.currency}
                </Td>
                <Td className="text-right font-mono whitespace-nowrap">
                  {fmtMicro(t.potentialPayoutMicro)} {t.currency}
                </Td>
                <Td className="text-right font-mono">
                  {t.legsStuck}/{t.legs}
                </Td>
                <Td>
                  {t.allLegsResolved ? (
                    <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px]">
                      All legs graded — payout missed
                    </span>
                  ) : (
                    <span className="text-[12px] text-[var(--color-fg-muted)]">
                      {t.legsUnresolved} leg
                      {t.legsUnresolved === 1 ? "" : "s"} awaiting a settlement
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SportsTab({
  rows,
}: {
  rows: Array<{
    sportSlug: string;
    sportName: string;
    provider: string;
    matches: number;
    markets: number;
  }>;
}) {
  if (rows.length === 0) {
    return (
      <p className="mt-8 text-sm text-[var(--color-fg-muted)]">
        Nothing unsettled.
      </p>
    );
  }
  const max = Math.max(...rows.map((r) => r.markets), 1);
  return (
    <div className="mt-6 overflow-x-auto rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
          <tr>
            <Th>Sport</Th>
            <Th>Provider</Th>
            <Th className="text-right">Matches</Th>
            <Th className="text-right">Markets</Th>
            <Th>Share</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.map((r) => (
            <tr key={`${r.sportSlug}-${r.provider}`}>
              <Td>{r.sportName}</Td>
              <Td className="text-[12px] text-[var(--color-fg-muted)]">
                {r.provider}
              </Td>
              <Td className="text-right font-mono">
                {r.matches.toLocaleString()}
              </Td>
              <Td className="text-right font-mono">
                {r.markets.toLocaleString()}
              </Td>
              <Td>
                <div className="h-1.5 w-40 overflow-hidden rounded-full bg-[var(--color-border)]">
                  <div
                    className="h-full rounded-full bg-[var(--color-accent,#0d5c63)]"
                    style={{ width: `${(r.markets / max) * 100}%` }}
                  />
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <th className={`px-4 py-2 font-medium ${className ?? ""}`}>{children}</th>;
}

function Td({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 ${className ?? ""}`}>{children}</td>;
}
