import { serverApi } from "@/lib/server-fetch";
import {
  AdminDeposits,
  type AdminDepositEntry,
} from "./admin-deposits";

interface ListResponse {
  deposits: AdminDepositEntry[];
}

export default async function DepositsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const allowed = ["pending", "confirming", "credited", "rejected"];
  const status = allowed.includes(params.status ?? "") ? params.status : undefined;

  const qs = new URLSearchParams({ limit: "100" });
  if (status) qs.set("status", status);

  const data = await serverApi<ListResponse>(`/admin/deposits?${qs.toString()}`);
  const deposits = data?.deposits ?? [];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Deposits</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Users submit a tx hash after sending USDC to the shared receive
        address. wallet-watcher resolves the receipt and credits after
        confirmations. Use this view to manually credit or reject when
        the watcher can&apos;t auto-resolve a claim.
      </p>

      <section className="mt-6 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Filter
        </span>
        <a
          href="/admin/deposits"
          className={
            "rounded-[8px] border px-3 py-1 " +
            (status === undefined
              ? "border-[var(--color-accent)] text-[var(--color-accent)]"
              : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
          }
        >
          all
        </a>
        {allowed.map((s) => (
          <a
            key={s}
            href={`/admin/deposits?status=${s}`}
            className={
              "rounded-[8px] border px-3 py-1 " +
              (status === s
                ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
            }
          >
            {s}
          </a>
        ))}
      </section>

      <section className="mt-6">
        {deposits.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-muted)]">
            No deposits in this view.
          </p>
        ) : (
          <AdminDeposits entries={deposits} />
        )}
      </section>
    </div>
  );
}
