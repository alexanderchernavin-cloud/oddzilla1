import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";

interface SportSummary {
  id: number;
  slug: string;
  name: string;
  maxMapNumber: number;
  // Keyed by scope value (match | top | map_<N>). Missing keys = 0.
  configured: Record<string, number>;
}

interface SportListResponse {
  sports: SportSummary[];
}

interface ScopeChip {
  scope: string;
  label: string;
}

function scopeChips(sport: SportSummary): ScopeChip[] {
  const chips: ScopeChip[] = [{ scope: "match", label: "Match" }];
  for (let n = 1; n <= sport.maxMapNumber; n++) {
    chips.push({ scope: `map_${n}`, label: `Map ${n}` });
  }
  chips.push({ scope: "top", label: "Top" });
  return chips;
}

export default async function MarketsOrderIndex() {
  const data = await serverApi<SportListResponse>("/admin/fe-settings/markets-order");
  const sports = data?.sports ?? [];

  return (
    <div>
      <h2 className="text-lg font-medium">Markets display order</h2>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Override the default order of market types per sport, with a separate
        list for each tab on the match-detail page: <strong>Match</strong>{" "}
        (markets without a map specifier), one list per <strong>Map N</strong>{" "}
        tab (independently configurable), and <strong>Top</strong> (a curated
        highlights tab; empty by default and only shows ids you add). The
        storefront <strong>All</strong> tab is not configurable — it just
        aggregates every market in its native order.
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
                <th className="px-5 py-3 text-left">Tabs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {sports.map((s) => (
                <tr key={s.id}>
                  <td className="px-5 py-3 align-top">{s.name}</td>
                  <td className="px-5 py-3 align-top font-mono text-[var(--color-fg-muted)]">
                    {s.slug}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {scopeChips(s).map((chip) => {
                        const count = s.configured[chip.scope] ?? 0;
                        return (
                          <Link
                            key={chip.scope}
                            href={`/admin/fe-settings/markets-order/${s.id}/${chip.scope}`}
                            className={
                              "inline-flex items-center gap-2 rounded border px-2 py-1 text-xs " +
                              (count > 0
                                ? "border-[var(--color-accent)] text-[var(--color-fg)] hover:bg-[var(--color-bg-elevated)]"
                                : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
                            }
                          >
                            <span className="uppercase tracking-[0.12em]">
                              {chip.label}
                            </span>
                            <span className="font-mono text-[var(--color-fg-subtle)]">
                              {count > 0 ? count : "—"}
                            </span>
                          </Link>
                        );
                      })}
                    </div>
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
