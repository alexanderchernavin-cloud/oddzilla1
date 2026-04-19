import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";

interface TournamentRow {
  id: number;
  slug: string;
  name: string;
  matchCount: number;
}
interface Response {
  sport: { id: number; slug: string; name: string };
  tournaments: TournamentRow[];
}

export default async function LogsSportPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await serverApi<Response>(`/admin/logs/sports/${slug}/tournaments`);
  if (!data) notFound();

  return (
    <div>
      <nav className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        <Link href="/admin/logs" className="hover:text-[var(--color-fg)]">
          Feed logs
        </Link>
        <span> / </span>
        <span>{data.sport.name}</span>
      </nav>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        {data.sport.name}
      </h1>
      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
        Tournaments with matches currently in the 24h retention window.
      </p>

      {data.tournaments.length === 0 ? (
        <p className="mt-8 text-sm text-[var(--color-fg-muted)]">
          No tournaments with in-window matches.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          {data.tournaments.map((t) => (
            <li key={t.id}>
              <Link
                href={`/admin/logs/tournaments/${t.id}`}
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-[var(--color-bg)]"
              >
                <div>
                  <p className="text-sm font-medium">{t.name}</p>
                  <p className="text-xs text-[var(--color-fg-subtle)]">
                    {t.slug}
                  </p>
                </div>
                <span className="rounded-[8px] border border-[var(--color-border-strong)] px-2 py-0.5 font-mono text-xs text-[var(--color-fg-muted)]">
                  {t.matchCount} match{t.matchCount === 1 ? "" : "es"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
