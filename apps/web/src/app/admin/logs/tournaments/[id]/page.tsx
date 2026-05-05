import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";

interface MatchRow {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: string;
  bestOf: number | null;
  messageCount: number;
}
interface Response {
  tournament: {
    id: number;
    name: string;
    sportSlug: string;
    sportName: string;
  };
  matches: MatchRow[];
}

function statusTone(status: string): string {
  switch (status) {
    case "live":
      return "text-[var(--color-accent)]";
    case "cancelled":
      return "text-[var(--color-negative)]";
    case "closed":
      return "text-[var(--color-fg-subtle)]";
    default:
      return "text-[var(--color-fg-muted)]";
  }
}

export default async function LogsTournamentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await serverApi<Response>(`/admin/logs/tournaments/${id}/matches`);
  if (!data) notFound();

  return (
    <div>
      <nav className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        <Link href="/admin/logs" className="hover:text-[var(--color-fg)]">
          Feed logs
        </Link>
        <span> / </span>
        <Link
          href={`/admin/logs/sports/${data.tournament.sportSlug}`}
          className="hover:text-[var(--color-fg)]"
        >
          {data.tournament.sportName}
        </Link>
        <span> / </span>
        <span>{data.tournament.name}</span>
      </nav>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        {data.tournament.name}
      </h1>
      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
        Matches with at least one feed message in the 7-day retention
        window. Click any match to see its markets, odds history and raw
        feed log.
      </p>

      {data.matches.length === 0 ? (
        <p className="mt-8 text-sm text-[var(--color-fg-muted)]">
          No matches in window.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          {data.matches.map((m) => (
            <li key={m.id}>
              <Link
                href={`/admin/logs/matches/${m.id}`}
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-[var(--color-bg)]"
              >
                <div>
                  <p className="text-sm font-medium">
                    {m.homeTeam}
                    <span className="mx-2 text-[var(--color-fg-subtle)]">vs</span>
                    {m.awayTeam}
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
                    <span className={statusTone(m.status)}>
                      {m.status.toUpperCase()}
                    </span>
                    {m.bestOf ? (
                      <>
                        <span className="mx-1.5">·</span>
                        <span>BO{m.bestOf}</span>
                      </>
                    ) : null}
                    {m.scheduledAt ? (
                      <>
                        <span className="mx-1.5">·</span>
                        <time dateTime={m.scheduledAt}>
                          {new Date(m.scheduledAt).toLocaleString()}
                        </time>
                      </>
                    ) : null}
                  </p>
                </div>
                <span className="rounded-[8px] border border-[var(--color-border-strong)] px-2 py-0.5 font-mono text-xs text-[var(--color-fg-muted)]">
                  {m.messageCount} msg
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
