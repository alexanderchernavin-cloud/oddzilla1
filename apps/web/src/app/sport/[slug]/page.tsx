import { notFound } from "next/navigation";
import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";

interface SportResponse {
  sport: { id: number; slug: string; name: string };
  matches: Array<{
    id: string;
    homeTeam: string;
    awayTeam: string;
    scheduledAt: string | null;
    status: "not_started" | "live" | "closed" | "cancelled" | "suspended";
    bestOf: number | null;
    tournament: { id: number; name: string };
  }>;
}

// Public route — not behind auth — so people can browse before signing up.
export default async function SportPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await serverApi<SportResponse>(`/catalog/sports/${slug}?limit=100`);
  if (!data) notFound();

  const live = data.matches.filter((m) => m.status === "live");
  const upcoming = data.matches.filter((m) => m.status !== "live");

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex items-center justify-between border-b border-[var(--color-border)] pb-6">
        <div>
          <Link
            href="/"
            className="text-xs uppercase tracking-[0.18em] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
          >
            Oddzilla
          </Link>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{data.sport.name}</h1>
        </div>
        <div className="text-sm text-[var(--color-fg-muted)]">
          {live.length} live · {upcoming.length} upcoming
        </div>
      </header>

      {live.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
            Live now
          </h2>
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {live.map((m) => (
              <MatchCard key={m.id} match={m} />
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-10">
        <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
          Upcoming
        </h2>
        {upcoming.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
            No upcoming matches from the feed yet. Once Oddin's ingester runs with
            live credentials, fixtures will populate here.
          </p>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {upcoming.map((m) => (
              <MatchCard key={m.id} match={m} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function MatchCard({ match }: { match: SportResponse["matches"][number] }) {
  const scheduled = match.scheduledAt ? new Date(match.scheduledAt) : null;
  return (
    <li>
      <Link
        href={`/match/${match.id}`}
        className="card block p-5 transition-colors hover:border-[var(--color-border-strong)]"
      >
        <div className="flex items-center justify-between text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          <span>{match.tournament.name}</span>
          <span
            className={
              match.status === "live"
                ? "text-[var(--color-negative)]"
                : "text-[var(--color-fg-subtle)]"
            }
          >
            {match.status === "live" ? "live" : match.status}
          </span>
        </div>
        <p className="mt-3 text-base font-medium">
          {match.homeTeam} <span className="text-[var(--color-fg-subtle)]">vs</span> {match.awayTeam}
        </p>
        <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
          {scheduled ? scheduled.toLocaleString() : "Time TBD"}
          {match.bestOf ? ` · Best of ${match.bestOf}` : ""}
        </p>
      </Link>
    </li>
  );
}
