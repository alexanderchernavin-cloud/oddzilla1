// "Unsettled" admin page. Everything whose match is over but whose book
// never went terminal, plus the tickets stuck behind it.
//
// Only two things ever write a terminal market status: Oddin's
// `bet_settlement` (services/settlement) and Fonbet's results grader
// (fonbet-ingester `internal/settle`, gated by FONBET_SETTLE_ENABLED).
// A market neither of them covered stays open forever, and a ticket on
// it stays `accepted` with the stake already debited. The operator
// requirement is no manual settlement, so this page is the standing
// answer to "what would currently need one".
//
// Read-only on purpose. Settling, voiding or cancelling by hand are
// money-moving decisions that live behind their own audited endpoints
// (/admin/tickets, /admin/feed), not behind a monitoring list.

import { serverApi } from "@/lib/server-fetch";
import { UnsettledTabs } from "./tabs";

export const metadata = {
  title: "Unsettled — Oddzilla Admin",
};

// Operators come here to check current state; caching would defeat it.
export const dynamic = "force-dynamic";

export interface UnsettledMatch {
  matchId: string;
  providerUrn: string | null;
  provider: string;
  homeTeam: string;
  awayTeam: string;
  matchStatus: string;
  scheduledAt: string;
  sportSlug: string;
  sportName: string;
  tournamentName: string;
  categoryName: string;
  unsettledMarkets: number;
  activeMarkets: number;
  openTickets: number;
  openStakeMicro: string;
}

export interface UnsettledTicket {
  ticketId: string;
  ticketStatus: string;
  betType: string;
  currency: string;
  stakeMicro: string;
  potentialPayoutMicro: string;
  placedAt: string;
  userId: string;
  userEmail: string;
  userNickname: string | null;
  legs: number;
  legsUnresolved: number;
  legsStuck: number;
  allLegsResolved: boolean;
  lastFinishedAt: string | null;
}

interface Summary {
  windowDays: number;
  byProvider: Array<{ provider: string; matches: number; markets: number }>;
  bySport: Array<{
    sportSlug: string;
    sportName: string;
    provider: string;
    matches: number;
    markets: number;
  }>;
  ticketExposure: Array<{
    currency: string;
    tickets: number;
    stakeMicro: string;
    potentialPayoutMicro: string;
  }>;
}

function fmtMicro(micro: string): string {
  // Money is BIGINT micro (6 dp) and arrives as a decimal string; never
  // parse it with Number for arithmetic. Display-only formatting here.
  const neg = micro.startsWith("-");
  const digits = (neg ? micro.slice(1) : micro).padStart(7, "0");
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(-6).replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${body}` : body;
}

const WINDOWS = [7, 30, 90, 365] as const;

export default async function UnsettledPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const sp = await searchParams;
  // The scan cost scales with the window (measured on production: ~2.5 s
  // at 7 days, ~6 s at 30), so the window is a control rather than a
  // constant. All three fetches share it so the KPIs and the lists below
  // can never describe different populations.
  const parsed = Number(sp?.days);
  const days = WINDOWS.includes(parsed as (typeof WINDOWS)[number]) ? parsed : 30;

  const [summary, matchesRes, ticketsRes] = await Promise.all([
    serverApi<Summary>(`/admin/unsettled/summary?days=${days}`),
    serverApi<{ matches: UnsettledMatch[] }>(
      `/admin/unsettled/matches?days=${days}&limit=100`,
    ),
    serverApi<{ tickets: UnsettledTicket[] }>(
      `/admin/unsettled/tickets?days=${days}&limit=100`,
    ),
  ]);

  const matches = matchesRes?.matches ?? [];
  const tickets = ticketsRes?.tickets ?? [];
  const totalMarkets =
    summary?.byProvider.reduce((n, p) => n + p.markets, 0) ?? 0;
  const totalMatches =
    summary?.byProvider.reduce((n, p) => n + p.matches, 0) ?? 0;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Unsettled</h1>
      <p className="mt-1 max-w-3xl text-sm text-[var(--color-fg-muted)]">
        Matches that have finished while their markets never went terminal, and
        the tickets stuck behind them. A market only settles when Oddin sends a{" "}
        <code className="font-mono">bet_settlement</code> or the Fonbet results
        grader covers it — anything neither reached stays here until a grader
        learns the shape or an operator voids it. The <strong>Void</strong>{" "}
        buttons in the market drill-down are the only thing on this page that
        moves money, and each one is audit-logged.
      </p>
      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
        <a href="/admin/unsettled/denylist" className="underline">
          Market denylist
        </a>{" "}
        — the Fonbet shapes that are no longer offered because nothing can
        settle them, with the open markets still under each rule.
      </p>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Unsettled markets" value={totalMarkets.toLocaleString()} />
        <Kpi label="Finished matches" value={totalMatches.toLocaleString()} />
        <Kpi
          label="Tickets stuck"
          value={(summary?.ticketExposure.reduce((n, t) => n + t.tickets, 0) ?? 0).toLocaleString()}
          tone={
            (summary?.ticketExposure.reduce((n, t) => n + t.tickets, 0) ?? 0) > 0
              ? "warn"
              : "ok"
          }
        />
        <Kpi
          label="Stake held"
          value={
            summary && summary.ticketExposure.length > 0
              ? summary.ticketExposure
                  .map((t) => `${fmtMicro(t.stakeMicro)} ${t.currency}`)
                  .join(" · ")
              : "none"
          }
          tone={
            summary && summary.ticketExposure.length > 0 ? "warn" : "ok"
          }
        />
      </div>

      {summary && summary.byProvider.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--color-fg-muted)]">
          {summary.byProvider.map((p) => (
            <span
              key={p.provider}
              className="rounded-full border border-[var(--color-border)] px-3 py-1"
            >
              {p.provider}: {p.markets.toLocaleString()} markets across{" "}
              {p.matches.toLocaleString()} matches
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--color-fg-subtle)]">Window</span>
        {WINDOWS.map((w) => (
          <a
            key={w}
            href={`/admin/unsettled?days=${w}`}
            className={`rounded-full border px-3 py-1 ${
              w === days
                ? "border-[var(--color-fg)] font-medium text-[var(--color-fg)]"
                : "border-[var(--color-border)] text-[var(--color-fg-muted)]"
            }`}
          >
            {w === 365 ? "1 y" : `${w} d`}
          </a>
        ))}
        <span className="text-[var(--color-fg-subtle)]">
          by scheduled start — a wider window scans more markets and loads slower
        </span>
      </div>

      <UnsettledTabs
        matches={matches}
        tickets={tickets}
        bySport={summary?.bySport ?? []}
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "ok" | "warn";
}) {
  const valueTone =
    tone === "warn"
      ? "text-[var(--color-danger,#b4443c)]"
      : tone === "ok"
        ? "text-[var(--color-fg)]"
        : "text-[var(--color-fg)]";
  return (
    <div className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
        {label}
      </div>
      <div className={`mt-1 font-mono text-lg ${valueTone}`}>{value}</div>
    </div>
  );
}
