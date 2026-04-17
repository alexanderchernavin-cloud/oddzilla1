import { serverApi } from "@/lib/server-fetch";
import { MappingReview, type MappingEntry } from "./mapping-review";

interface ListResponse {
  entries: MappingEntry[];
}

interface SummaryResponse {
  pending: number;
  approved: number;
  rejected: number;
}

export default async function MappingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string }>;
}) {
  const params = await searchParams;
  const status =
    params.status === "approved" || params.status === "rejected"
      ? params.status
      : "pending";
  const entityType =
    params.type && ["sport", "category", "tournament", "match", "market_type"].includes(params.type)
      ? params.type
      : undefined;

  const qs = new URLSearchParams({ status, limit: "100" });
  if (entityType) qs.set("entityType", entityType);

  const [summary, list] = await Promise.all([
    serverApi<SummaryResponse>("/admin/mapping/summary"),
    serverApi<ListResponse>(`/admin/mapping?${qs.toString()}`),
  ]);

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mapping review</h1>
          <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
            Entities auto-created by the feed ingester. Approve to confirm the mapping,
            reject to flag for manual correction.
          </p>
        </div>
      </div>

      <section className="mt-6 grid gap-4 sm:grid-cols-3">
        {(["pending", "approved", "rejected"] as const).map((s) => (
          <div key={s} className="card p-6">
            <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
              {s}
            </p>
            <p
              className={
                "mt-3 font-mono text-3xl " +
                (s === status ? "text-[var(--color-accent)]" : "text-[var(--color-fg)]")
              }
            >
              {summary ? summary[s] : "—"}
            </p>
          </div>
        ))}
      </section>

      <section className="mt-8 flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
        <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Filter
        </span>
        {(["pending", "approved", "rejected"] as const).map((s) => (
          <a
            key={s}
            href={`/admin/mapping?status=${s}${entityType ? `&type=${entityType}` : ""}`}
            className={
              "rounded-[8px] border px-3 py-1 " +
              (s === status
                ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                : "border-[var(--color-border-strong)] hover:text-[var(--color-fg)]")
            }
          >
            {s}
          </a>
        ))}
      </section>

      <section className="mt-8">
        {!list ? (
          <p className="text-sm text-[var(--color-negative)]">
            Failed to load entries. Check the API service.
          </p>
        ) : list.entries.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-muted)]">No entries in this view.</p>
        ) : (
          <MappingReview entries={list.entries} canAct={status === "pending"} />
        )}
      </section>
    </div>
  );
}
