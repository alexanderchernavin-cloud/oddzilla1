import Link from "next/link";
import { fromMicro } from "@oddzilla/types/money";
import { serverApi } from "@/lib/server-fetch";

interface KpiResponse {
  stakeMicro: string;
  payoutMicro: string;
  refundMicro: string;
  openTickets: number;
  activeUsers: number;
}

interface PnlRow {
  day: string;
  sportSlug: string;
  sportName: string;
  stakeMicro: string;
  payoutMicro: string;
  refundMicro: string;
  pnlMicro: string;
  ticketCount: number;
}
interface PnlResponse {
  rows: PnlRow[];
}

interface BigWin {
  ticketId: string;
  userId: string;
  userEmail: string;
  stakeMicro: string;
  payoutMicro: string;
  settledAt: string;
  sportSlug: string | null;
  match: string | null;
}
interface BigWinsResponse {
  rows: BigWin[];
}

function formatUsdt(micro: string) {
  return `${fromMicro(BigInt(micro))} USDT`;
}

function signedMicro(micro: string) {
  const n = BigInt(micro);
  const prefix = n >= 0n ? "+" : "";
  return `${prefix}${fromMicro(n)}`;
}

export default async function AdminDashboard() {
  const [kpis, pnl, bigWins] = await Promise.all([
    serverApi<KpiResponse>("/admin/stats/kpis"),
    serverApi<PnlResponse>("/admin/stats/pnl-by-day?days=14"),
    serverApi<BigWinsResponse>("/admin/stats/big-wins?limit=10&days=30"),
  ]);

  const stakeMicro = BigInt(kpis?.stakeMicro ?? "0");
  const payoutMicro = BigInt(kpis?.payoutMicro ?? "0");
  const refundMicro = BigInt(kpis?.refundMicro ?? "0");
  const todayPnlMicro = stakeMicro - payoutMicro - refundMicro;

  const pnlRows = pnl?.rows ?? [];
  const byDay = groupBy(pnlRows, (r) => r.day);
  const days = Array.from(byDay.keys()).sort().reverse();
  const sportSlugs = Array.from(new Set(pnlRows.map((r) => r.sportSlug))).sort();

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Operator PnL today and 14-day sport breakdown. Signs are operator-positive:
            stakes in minus payouts and refunds out.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Link
            href="/admin/users"
            className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          >
            Users
          </Link>
          <Link
            href="/admin/audit"
            className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          >
            Audit
          </Link>
        </div>
      </div>

      <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="PnL today (UTC)"
          value={signedMicro(todayPnlMicro.toString())}
          tone={todayPnlMicro >= 0n ? "positive" : "negative"}
          subtitle="stake − payout − refund"
        />
        <Kpi
          label="Stakes today"
          value={formatUsdt(kpis?.stakeMicro ?? "0")}
          subtitle={`${pnl?.rows.reduce((n, r) => n + (r.day === days[0] ? r.ticketCount : 0), 0) ?? 0} tickets`}
        />
        <Kpi
          label="Active users"
          value={String(kpis?.activeUsers ?? 0)}
          subtitle="last 7 days"
        />
        <Kpi
          label="Open tickets"
          value={String(kpis?.openTickets ?? 0)}
          subtitle="accepted + pending_delay"
        />
      </section>

      <section className="mt-10">
        <header className="flex items-baseline justify-between">
          <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
            PnL by day x sport (last 14 days)
          </h2>
          <span className="text-xs text-[var(--color-fg-subtle)]">
            {pnlRows.length} rows
          </span>
        </header>
        {pnlRows.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
            No settled or staked activity in the window.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                  <th className="px-4 py-3 text-left font-normal">Day</th>
                  {sportSlugs.map((s) => (
                    <th key={s} className="px-4 py-3 text-right font-normal">
                      {s}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-right font-normal">Total</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => {
                  const bySport = new Map<string, PnlRow>(
                    (byDay.get(d) ?? []).map((r) => [r.sportSlug, r] as const),
                  );
                  let total = 0n;
                  return (
                    <tr key={d} className="border-b border-[var(--color-border)] last:border-b-0">
                      <td className="px-4 py-3 font-mono text-[var(--color-fg-muted)]">{d}</td>
                      {sportSlugs.map((s) => {
                        const r = bySport.get(s);
                        if (!r) {
                          return (
                            <td
                              key={s}
                              className="px-4 py-3 text-right font-mono text-[var(--color-fg-subtle)]"
                            >
                              —
                            </td>
                          );
                        }
                        const pnl = BigInt(r.pnlMicro);
                        total += pnl;
                        return (
                          <td
                            key={s}
                            className={
                              "px-4 py-3 text-right font-mono " +
                              (pnl >= 0n
                                ? "text-[var(--color-positive)]"
                                : "text-[var(--color-negative)]")
                            }
                          >
                            {signedMicro(r.pnlMicro)}
                          </td>
                        );
                      })}
                      <td
                        className={
                          "px-4 py-3 text-right font-mono " +
                          (total >= 0n
                            ? "text-[var(--color-positive)]"
                            : "text-[var(--color-negative)]")
                        }
                      >
                        {signedMicro(total.toString())}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
          Recent big wins (30 days)
        </h2>
        {(bigWins?.rows ?? []).length === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-fg-muted)]">No settled wins yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
            {(bigWins?.rows ?? []).map((b) => (
              <li key={b.ticketId} className="p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      <span className="font-mono text-[var(--color-fg-muted)]">
                        {b.userEmail}
                      </span>{" "}
                      on {b.match ?? "—"}{" "}
                      {b.sportSlug ? (
                        <span className="text-[var(--color-fg-subtle)]">({b.sportSlug})</span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
                      settled {new Date(b.settledAt).toLocaleString()} · stake{" "}
                      {formatUsdt(b.stakeMicro)}
                    </p>
                  </div>
                  <p className="whitespace-nowrap font-mono text-[var(--color-positive)]">
                    +{formatUsdt(b.payoutMicro)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Kpi({
  label,
  value,
  subtitle,
  tone,
}: {
  label: string;
  value: string;
  subtitle?: string;
  tone?: "positive" | "negative";
}) {
  const valueClass =
    tone === "positive"
      ? "text-[var(--color-positive)]"
      : tone === "negative"
        ? "text-[var(--color-negative)]"
        : "";
  return (
    <div className="card p-6">
      <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {label}
      </p>
      <p className={"mt-3 font-mono text-2xl font-semibold " + valueClass}>{value}</p>
      {subtitle ? (
        <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">{subtitle}</p>
      ) : null}
    </div>
  );
}

function groupBy<T, K>(arr: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}
