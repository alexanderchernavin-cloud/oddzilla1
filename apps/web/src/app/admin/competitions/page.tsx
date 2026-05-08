import Link from "next/link";
import type { AdminCompetitionListResponse } from "@oddzilla/types";
import { serverApi } from "@/lib/server-fetch";

export const dynamic = "force-dynamic";

export default async function AdminCompetitionsPage() {
  const data = await serverApi<AdminCompetitionListResponse>("/admin/competitions");
  if (!data) {
    return (
      <div>
        <h1 className="text-xl font-semibold">Competitions</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
          Couldn't load competitions.
        </p>
      </div>
    );
  }

  return (
    <div>
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Competitions</h1>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            {data.counts.all} total · {data.counts.upcoming + data.counts.live} active ·{" "}
            {data.counts.draft} draft
          </p>
        </div>
        <Link
          href="/admin/competitions/new"
          className="rounded-[10px] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-on-accent)] hover:opacity-90"
        >
          + New competition
        </Link>
      </header>

      {data.competitions.length === 0 ? (
        <p className="mt-6 text-sm text-[var(--color-fg-muted)]">
          No competitions yet. Create one to get started.
        </p>
      ) : (
        <div className="mt-6 overflow-hidden rounded-[10px] border border-[var(--color-border-strong)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--color-bg-elevated)] text-left text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Joined</th>
                <th className="px-3 py-2 text-right">Matches</th>
                <th className="px-3 py-2">Match start</th>
              </tr>
            </thead>
            <tbody>
              {data.competitions.map((c) => (
                <tr
                  key={c.id}
                  className="border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-elevated)]"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/admin/competitions/${c.id}`}
                      className="font-medium text-[var(--color-fg)]"
                    >
                      {c.title}
                    </Link>
                    <div className="text-[11px] text-[var(--color-fg-subtle)]">
                      {[c.sportName, c.league].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)]">
                    {c.type}
                  </td>
                  <td className="px-3 py-2 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)]">
                    {c.status}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {c.participantCount.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {c.matchCount}
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--color-fg-muted)]">
                    {new Date(c.matchStartAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
