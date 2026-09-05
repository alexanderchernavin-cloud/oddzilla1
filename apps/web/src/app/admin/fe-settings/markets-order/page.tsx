import { serverApi } from "@/lib/server-fetch";
import { SportRow, type SportSummary } from "./sport-row";

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
        Override the default order of market types per sport. Each sport lists
        the tabs its own offer produces on the match-detail page —{" "}
        <strong>Match</strong> (the base event), one list per{" "}
        <strong>Map N</strong> tab for the esports that play maps, and one per
        sub-event the feed carries (<strong>1st half</strong>,{" "}
        <strong>Corners</strong>, <strong>Yellow cards</strong>,{" "}
        <strong>Players</strong> …) — each independently configurable. Plus{" "}
        <strong>Top</strong> (a curated highlights tab; empty by default and
        only shows ids you add) and any number of <strong>custom groups</strong>{" "}
        (curated tabs you create and name yourself — see the Groups chip per
        sport, which also lets you reorder the tabs). The storefront{" "}
        <strong>All</strong> tab is not configurable — it just aggregates every
        market in its native order.
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
                <SportRow key={s.id} sport={s} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
