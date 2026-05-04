import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";

interface SportSummary {
  id: number;
  slug: string;
  name: string;
  configured: { match: number; map: number; top: number };
}

interface SportListResponse {
  sports: SportSummary[];
}

export default async function MarketsOrderIndex() {
  const data = await serverApi<SportListResponse>("/admin/fe-settings/markets-order");
  const sports = data?.sports ?? [];

  return (
    <div>
      <h2 className="text-lg font-medium">Markets display order</h2>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Override the default order of market types per sport, with a separate
        list for each scope: <strong>Match</strong> (markets without a map
        specifier), <strong>Map</strong> (markets with a map specifier — the
        same order applies to every Map N tab), and <strong>Top</strong> (a
        curated highlights tab; empty by default and only shows ids you add).
      </p>

      {sports.length === 0 ? (
        <p className="mt-6 text-sm text-[var(--color-fg-muted)]">No active sports.</p>
      ) : (
        <div className="card mt-6 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
              <tr>
                <th className="px-5 py-3 text-left">Sport</th>
                <th className="px-5 py-3 text-left">Slug</th>
                <th className="px-5 py-3 text-right">Match</th>
                <th className="px-5 py-3 text-right">Map</th>
                <th className="px-5 py-3 text-right">Top</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {sports.map((s) => (
                <tr key={s.id}>
                  <td className="px-5 py-3">{s.name}</td>
                  <td className="px-5 py-3 font-mono text-[var(--color-fg-muted)]">
                    {s.slug}
                  </td>
                  <td className="px-5 py-3 text-right font-mono">
                    {s.configured.match > 0 ? s.configured.match : "—"}
                  </td>
                  <td className="px-5 py-3 text-right font-mono">
                    {s.configured.map > 0 ? s.configured.map : "—"}
                  </td>
                  <td className="px-5 py-3 text-right font-mono">
                    {s.configured.top > 0 ? s.configured.top : "—"}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Link
                      href={`/admin/fe-settings/markets-order/${s.id}/match`}
                      className="text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:underline"
                    >
                      Edit
                    </Link>
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
