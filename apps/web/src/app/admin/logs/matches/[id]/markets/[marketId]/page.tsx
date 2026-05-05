// Per-market full odds-history page. Pulls every odds_history row for the
// market over the 7-day retention window and renders them as a chronological
// table grouped by timestamp. Sister page to /admin/logs/matches/[id]; the
// match page links here via the per-market "Odds history" button.

import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";

interface Outcome {
  outcomeId: string;
  name: string;
  rawOdds: string | null;
  publishedOdds: string | null;
  result: string | null;
  voidFactor: string | null;
}

interface Market {
  id: string;
  matchId: string;
  providerMarketId: number;
  name: string;
  specifiers: Record<string, string>;
  status: number;
  outcomes: Outcome[];
}

interface Point {
  outcomeId: string;
  rawOdds: string | null;
  publishedOdds: string | null;
  probability: string | null;
  tsMs: number;
}

interface Response {
  market: Market;
  retentionDays: number;
  points: Point[];
}

interface MatchResponse {
  match: {
    id: string;
    homeTeam: string;
    awayTeam: string;
    sport: { slug: string; name: string };
    tournament: { id: number; name: string };
  };
}

function specifierSummary(specs: Record<string, string>): string {
  const entries = Object.entries(specs);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${v}`).join(" · ");
}

function marketStatusLabel(status: number): string {
  switch (status) {
    case 1:
      return "active";
    case 0:
      return "inactive";
    case -1:
      return "suspended";
    case -2:
      return "handover";
    case -3:
      return "settled";
    case -4:
      return "cancelled";
    default:
      return `status=${status}`;
  }
}

function resultBadge(result: string | null) {
  if (!result) return null;
  const tone =
    result === "won" || result === "half_won"
      ? "border-[var(--color-positive)] text-[var(--color-positive)]"
      : result === "lost" || result === "half_lost"
        ? "border-[var(--color-negative)] text-[var(--color-negative)]"
        : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)]";
  return (
    <span
      className={
        "rounded-[6px] border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] " +
        tone
      }
    >
      {result.replace("_", " ")}
    </span>
  );
}

export default async function MarketHistoryPage({
  params,
}: {
  params: Promise<{ id: string; marketId: string }>;
}) {
  const { id, marketId } = await params;
  const [data, matchData] = await Promise.all([
    serverApi<Response>(
      `/admin/logs/matches/${id}/markets/${marketId}/history`,
    ),
    serverApi<MatchResponse>(`/admin/logs/matches/${id}`),
  ]);
  if (!data || !matchData) notFound();

  // Group points by timestamp so each row is one snapshot of the market.
  const snapshots: Array<{ tsMs: number; byOutcome: Map<string, Point> }> = [];
  let current: { tsMs: number; byOutcome: Map<string, Point> } | null = null;
  for (const p of data.points) {
    if (!current || current.tsMs !== p.tsMs) {
      current = { tsMs: p.tsMs, byOutcome: new Map() };
      snapshots.push(current);
    }
    current.byOutcome.set(p.outcomeId, p);
  }
  // Most recent first for the table.
  snapshots.reverse();

  const orderedOutcomes = data.market.outcomes;

  return (
    <div>
      <nav className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        <Link href="/admin/logs" className="hover:text-[var(--color-fg)]">
          Feed logs
        </Link>
        <span> / </span>
        <Link
          href={`/admin/logs/sports/${matchData.match.sport.slug}`}
          className="hover:text-[var(--color-fg)]"
        >
          {matchData.match.sport.name}
        </Link>
        <span> / </span>
        <Link
          href={`/admin/logs/tournaments/${matchData.match.tournament.id}`}
          className="hover:text-[var(--color-fg)]"
        >
          {matchData.match.tournament.name}
        </Link>
        <span> / </span>
        <Link
          href={`/admin/logs/matches/${matchData.match.id}`}
          className="hover:text-[var(--color-fg)]"
        >
          {matchData.match.homeTeam} vs {matchData.match.awayTeam}
        </Link>
      </nav>

      <div className="mt-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {data.market.name}
          <span className="ml-2 font-mono text-base text-[var(--color-fg-subtle)]">
            #{data.market.providerMarketId}
          </span>
        </h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          {specifierSummary(data.market.specifiers) ? (
            <>
              <span className="font-mono text-[var(--color-fg-subtle)]">
                {specifierSummary(data.market.specifiers)}
              </span>
              <span className="mx-1.5">·</span>
            </>
          ) : null}
          <span className="uppercase">{marketStatusLabel(data.market.status)}</span>
          <span className="mx-1.5">·</span>
          {data.points.length} odds change{data.points.length === 1 ? "" : "s"}{" "}
          in the last {data.retentionDays} days
        </p>
      </div>

      <section className="mt-6">
        <h2 className="text-sm font-medium uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Outcomes
        </h2>
        <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {orderedOutcomes.map((o) => (
            <li
              key={o.outcomeId}
              className={
                "flex items-center justify-between gap-2 rounded-[8px] border px-2.5 py-1.5 text-xs " +
                (o.result === "won" || o.result === "half_won"
                  ? "border-[var(--color-positive)] bg-[color-mix(in_oklab,var(--color-positive)_8%,transparent)]"
                  : "border-[var(--color-border)]")
              }
            >
              <div className="min-w-0 flex-1 truncate">
                <span className="font-medium">{o.name}</span>
                <span className="ml-1.5 font-mono text-[10px] text-[var(--color-fg-subtle)]">
                  {o.outcomeId}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {o.publishedOdds ? (
                  <span className="font-mono text-[var(--color-fg-muted)]">
                    {Number(o.publishedOdds).toFixed(2)}
                  </span>
                ) : null}
                {resultBadge(o.result)}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          History · most recent first
        </h2>
        {snapshots.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-fg-muted)]">
            No odds changes recorded for this market in the retention window.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
            <table className="w-full border-collapse text-xs">
              <thead className="bg-[var(--color-bg)] text-left text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  {orderedOutcomes.map((o) => (
                    <th key={o.outcomeId} className="px-3 py-2 font-medium">
                      <div>{o.name}</div>
                      <div className="font-mono text-[9px] text-[var(--color-fg-subtle)]">
                        {o.outcomeId}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snap) => (
                  <tr
                    key={snap.tsMs}
                    className="border-t border-[var(--color-border)] hover:bg-[var(--color-bg)]"
                  >
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[var(--color-fg-muted)]">
                      {new Date(snap.tsMs).toLocaleString()}
                    </td>
                    {orderedOutcomes.map((o) => {
                      const p = snap.byOutcome.get(o.outcomeId);
                      if (!p) {
                        return (
                          <td
                            key={o.outcomeId}
                            className="px-3 py-1.5 font-mono text-[var(--color-fg-subtle)]"
                          >
                            —
                          </td>
                        );
                      }
                      const odds = p.publishedOdds ?? p.rawOdds;
                      return (
                        <td
                          key={o.outcomeId}
                          className="px-3 py-1.5 font-mono"
                        >
                          {odds ? (
                            <span className="text-[var(--color-fg)]">
                              {Number(odds).toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-[var(--color-fg-subtle)]">—</span>
                          )}
                          {p.publishedOdds && p.rawOdds &&
                          p.publishedOdds !== p.rawOdds ? (
                            <span className="ml-1 text-[10px] text-[var(--color-fg-subtle)]">
                              (raw {Number(p.rawOdds).toFixed(2)})
                            </span>
                          ) : null}
                          {p.probability ? (
                            <span className="ml-1 text-[10px] text-[var(--color-fg-subtle)]">
                              p={Number(p.probability).toFixed(3)}
                            </span>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
