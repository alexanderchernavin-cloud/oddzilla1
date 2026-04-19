import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { OddsChart } from "./odds-chart";

interface Point {
  tsMs: number;
  raw: string | null;
  published: string | null;
}
interface Series {
  outcomeId: string;
  name: string;
  points: Point[];
}
interface MarketBlock {
  id: string;
  providerMarketId: number;
  specifiers: Record<string, string>;
  status: number;
  outcomes: Array<{ outcomeId: string; name: string }>;
  series: Series[];
}
interface Response {
  match: {
    id: string;
    providerUrn: string;
    homeTeam: string;
    awayTeam: string;
    scheduledAt: string | null;
    status: string;
    bestOf: number | null;
    tournament: { id: number; name: string };
    sport: { slug: string; name: string };
  };
  markets: MarketBlock[];
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

function specifierSummary(specs: Record<string, string>): string {
  const entries = Object.entries(specs);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${v}`).join(" · ");
}

export default async function LogsMatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await serverApi<Response>(`/admin/logs/matches/${id}`);
  if (!data) notFound();

  return (
    <div>
      <nav className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        <Link href="/admin/logs" className="hover:text-[var(--color-fg)]">
          Feed logs
        </Link>
        <span> / </span>
        <Link
          href={`/admin/logs/sports/${data.match.sport.slug}`}
          className="hover:text-[var(--color-fg)]"
        >
          {data.match.sport.name}
        </Link>
        <span> / </span>
        <Link
          href={`/admin/logs/tournaments/${data.match.tournament.id}`}
          className="hover:text-[var(--color-fg)]"
        >
          {data.match.tournament.name}
        </Link>
      </nav>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {data.match.homeTeam}
            <span className="mx-3 text-[var(--color-fg-subtle)]">vs</span>
            {data.match.awayTeam}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            <span className="font-mono text-[var(--color-fg-subtle)]">
              {data.match.providerUrn}
            </span>
            <span className="mx-1.5">·</span>
            <span className="uppercase">{data.match.status}</span>
            {data.match.bestOf ? (
              <>
                <span className="mx-1.5">·</span>
                <span>BO{data.match.bestOf}</span>
              </>
            ) : null}
            {data.match.scheduledAt ? (
              <>
                <span className="mx-1.5">·</span>
                <time dateTime={data.match.scheduledAt}>
                  {new Date(data.match.scheduledAt).toLocaleString()}
                </time>
              </>
            ) : null}
          </p>
        </div>
        <Link
          href={`/admin/logs/matches/${data.match.id}/feed`}
          className="rounded-[8px] border border-[var(--color-accent)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:bg-[color-mix(in_oklab,var(--color-accent)_10%,transparent)]"
        >
          Feed log
        </Link>
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-medium uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Odds history · last 24h
        </h2>
        {data.markets.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-fg-muted)]">
            No markets on this match.
          </p>
        ) : (
          <ul className="mt-4 space-y-4">
            {data.markets.map((m) => (
              <li
                key={m.id}
                className="rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div>
                    <p className="text-sm font-medium">
                      Market #{m.providerMarketId}
                    </p>
                    {specifierSummary(m.specifiers) ? (
                      <p className="mt-0.5 font-mono text-[var(--color-fg-subtle)]">
                        {specifierSummary(m.specifiers)}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={
                      "rounded-[8px] border px-2 py-0.5 font-mono uppercase tracking-[0.12em] " +
                      (m.status === 1
                        ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                        : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)]")
                    }
                  >
                    {marketStatusLabel(m.status)}
                  </span>
                </div>
                <OddsChart series={m.series} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
