import { serverApi } from "@/lib/server-fetch";
import { MappingReview, type MappingEntry } from "./mapping-review";
import { BulkApproveButton } from "./bulk-approve-button";

interface ListResponse {
  entries: MappingEntry[];
}

interface SummaryResponse {
  pending: number;
  approved: number;
  rejected: number;
}

const ENTITY_TYPES = [
  "sport",
  "category",
  "tournament",
  "match",
  "competitor",
  "market_type",
] as const;

type EntityType = (typeof ENTITY_TYPES)[number];

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
  const entityType: EntityType | undefined =
    params.type && (ENTITY_TYPES as readonly string[]).includes(params.type)
      ? (params.type as EntityType)
      : undefined;

  const qs = new URLSearchParams({ status, limit: "100" });
  if (entityType) qs.set("entityType", entityType);

  // Summary KPI cards always show the total counts; a second
  // type-scoped summary feeds the bulk-approve button so its label
  // reflects exactly what would be approved under the current filter.
  const filteredSummaryQs = entityType
    ? `?entityType=${entityType}`
    : "";

  const [summary, filteredSummary, list] = await Promise.all([
    serverApi<SummaryResponse>("/admin/mapping/summary"),
    entityType
      ? serverApi<SummaryResponse>(`/admin/mapping/summary${filteredSummaryQs}`)
      : Promise.resolve(null),
    serverApi<ListResponse>(`/admin/mapping?${qs.toString()}`),
  ]);

  const pendingInScope = entityType
    ? (filteredSummary?.pending ?? 0)
    : (summary?.pending ?? 0);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mapping review</h1>
          <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
            Entities auto-created by the feed ingester. Approve to confirm the mapping,
            reject to flag for manual correction.
          </p>
        </div>
        {status === "pending" && (
          <BulkApproveButton
            pendingCount={pendingInScope}
            entityType={entityType}
          />
        )}
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

      <section className="mt-8 flex flex-wrap items-center gap-2 text-sm text-[var(--color-fg-muted)]">
        <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Status
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

      <section className="mt-4 flex flex-wrap items-center gap-2 text-sm text-[var(--color-fg-muted)]">
        <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Type
        </span>
        <a
          href={`/admin/mapping?status=${status}`}
          className={
            "rounded-[8px] border px-3 py-1 " +
            (!entityType
              ? "border-[var(--color-accent)] text-[var(--color-accent)]"
              : "border-[var(--color-border-strong)] hover:text-[var(--color-fg)]")
          }
        >
          all
        </a>
        {ENTITY_TYPES.map((t) => (
          <a
            key={t}
            href={`/admin/mapping?status=${status}&type=${t}`}
            className={
              "rounded-[8px] border px-3 py-1 " +
              (t === entityType
                ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                : "border-[var(--color-border-strong)] hover:text-[var(--color-fg)]")
            }
          >
            {t}
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
