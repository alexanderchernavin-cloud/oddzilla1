import { notFound } from "next/navigation";
import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import { LiveMarkets, type MarketSnapshot } from "./live-markets";

interface MatchResponse {
  match: {
    id: string;
    homeTeam: string;
    awayTeam: string;
    scheduledAt: string | null;
    status: "not_started" | "live" | "closed" | "cancelled" | "suspended";
    bestOf: number | null;
    liveScore: unknown;
    tournament: { id: number; name: string };
    sport: { id: number; slug: string; name: string };
  };
  markets: MarketSnapshot[];
}

export default async function MatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await serverApi<MatchResponse>(`/catalog/matches/${id}`);
  if (!data) notFound();

  const { match, markets } = data;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <nav className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        <Link href="/" className="hover:text-[var(--color-fg)]">
          Oddzilla
        </Link>
        <span className="mx-2">·</span>
        <Link href={`/sport/${match.sport.slug}`} className="hover:text-[var(--color-fg)]">
          {match.sport.name}
        </Link>
        <span className="mx-2">·</span>
        <span>{match.tournament.name}</span>
      </nav>

      <header className="mt-4 flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          {match.homeTeam} <span className="text-[var(--color-fg-subtle)]">vs</span>{" "}
          {match.awayTeam}
        </h1>
        <span
          className={
            "rounded-[8px] border px-3 py-1 text-xs uppercase tracking-[0.15em] " +
            (match.status === "live"
              ? "border-[var(--color-negative)] text-[var(--color-negative)]"
              : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)]")
          }
        >
          {match.status === "live" ? "live" : match.status}
        </span>
      </header>

      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        {match.scheduledAt
          ? new Date(match.scheduledAt).toLocaleString()
          : "Time TBD"}
        {match.bestOf ? ` · Best of ${match.bestOf}` : ""}
      </p>

      <section className="mt-10">
        <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
          Markets
        </h2>
        {markets.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
            No markets from the feed yet. This page will live-update when
            odds start flowing.
          </p>
        ) : (
          <LiveMarkets
            matchId={match.id}
            match={{
              id: match.id,
              homeTeam: match.homeTeam,
              awayTeam: match.awayTeam,
              sportSlug: match.sport.slug,
            }}
            initialMarkets={markets}
          />
        )}
      </section>
    </main>
  );
}
