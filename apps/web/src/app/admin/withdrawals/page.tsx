import { serverApi } from "@/lib/server-fetch";
import {
  AdminWithdrawals,
  type AdminWithdrawalEntry,
} from "./admin-withdrawals";

interface ListResponse {
  withdrawals: AdminWithdrawalEntry[];
}

export default async function WithdrawalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const allowed = ["requested", "approved", "submitted", "confirmed", "failed", "cancelled"];
  const status = allowed.includes(params.status ?? "") ? params.status : undefined;

  const qs = new URLSearchParams({ limit: "100" });
  if (status) qs.set("status", status);

  const data = await serverApi<ListResponse>(`/admin/withdrawals?${qs.toString()}`);
  const withdrawals = data?.withdrawals ?? [];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Withdrawals</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Approve manually after KYC. Once approved, the signer broadcasts and reports
        the tx hash via <span className="font-mono">/admin/withdrawals/:id/mark-submitted</span>.
        wallet-watcher confirms on chain.
      </p>

      <section className="mt-6 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Filter
        </span>
        <a
          href="/admin/withdrawals"
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
            href={`/admin/withdrawals?status=${s}`}
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
        {withdrawals.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-muted)]">
            No withdrawals in this view.
          </p>
        ) : (
          <AdminWithdrawals entries={withdrawals} />
        )}
      </section>
    </div>
  );
}
