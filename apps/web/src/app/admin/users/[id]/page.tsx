import { notFound } from "next/navigation";
import Link from "next/link";
import { fromMicro } from "@oddzilla/types/money";
import { serverApi } from "@/lib/server-fetch";
import { UserEditForm } from "./user-edit-form";
import { DeleteUserButton } from "./delete-user-button";

interface DetailResponse {
  user: {
    id: string;
    email: string;
    status: "active" | "blocked" | "pending_kyc";
    role: "user" | "admin" | "support";
    kycStatus: "none" | "pending" | "approved" | "rejected";
    displayName: string | null;
    countryCode: string | null;
    globalLimitMicro: string;
    betDelaySeconds: number;
    createdAt: string;
    lastLoginAt: string | null;
    balanceMicro: string;
    lockedMicro: string;
  };
  stats: {
    totalTickets: number;
    openTickets: number;
    settledTickets: number;
    totalStakeMicro: string;
    totalPayoutMicro: string;
  };
  recentTickets: Array<{
    id: string;
    status: string;
    stakeMicro: string;
    potentialPayoutMicro: string;
    actualPayoutMicro: string | null;
    placedAt: string;
    settledAt: string | null;
  }>;
}

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await serverApi<DetailResponse>(`/admin/users/${id}`);
  if (!data) notFound();

  const { user, stats, recentTickets } = data;
  const netLifetime = BigInt(stats.totalStakeMicro) - BigInt(stats.totalPayoutMicro);

  return (
    <div>
      <nav className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        <Link href="/admin/users" className="hover:text-[var(--color-fg)]">
          Users
        </Link>{" "}
        /{" "}
        <span className="normal-case tracking-normal text-[var(--color-fg)]">
          {user.email}
        </span>
      </nav>

      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{user.email}</h1>
      <p className="mt-1 font-mono text-xs text-[var(--color-fg-subtle)]">{user.id}</p>

      <section className="mt-6 grid gap-4 md:grid-cols-3">
        <Stat label="Balance" value={`${fromMicro(BigInt(user.balanceMicro))} USDT`} />
        <Stat label="Locked" value={`${fromMicro(BigInt(user.lockedMicro))} USDT`} />
        <Stat
          label="Lifetime net (house)"
          value={`${netLifetime >= 0n ? "+" : ""}${fromMicro(netLifetime)} USDT`}
          tone={netLifetime >= 0n ? "positive" : "negative"}
        />
        <Stat label="Total tickets" value={String(stats.totalTickets)} />
        <Stat label="Open" value={String(stats.openTickets)} />
        <Stat label="Settled" value={String(stats.settledTickets)} />
      </section>

      <section className="mt-10">
        <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
          Admin controls
        </h2>
        <div className="mt-4 card p-6">
          <UserEditForm user={user} />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
          Danger zone
        </h2>
        <div className="mt-4 card p-6">
          <DeleteUserButton userId={user.id} email={user.email} />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
          Recent tickets
        </h2>
        {recentTickets.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-fg-muted)]">None yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
            {recentTickets.map((t) => {
              const payout =
                t.actualPayoutMicro !== null ? BigInt(t.actualPayoutMicro) : null;
              const stake = BigInt(t.stakeMicro);
              const net = payout !== null ? payout - stake : null;
              const netTone =
                net === null
                  ? ""
                  : net >= 0n
                    ? "text-[var(--color-positive)]"
                    : "text-[var(--color-negative)]";
              return (
                <li key={t.id} className="flex items-center justify-between p-4 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-[var(--color-fg-muted)]">
                      {t.id}
                    </p>
                    <p className="mt-1 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                      {t.status} · placed {new Date(t.placedAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono">
                      {fromMicro(stake)} →{" "}
                      {payout !== null ? fromMicro(payout) : "—"} USDT
                    </p>
                    {net !== null ? (
                      <p className={"font-mono text-xs " + netTone}>
                        {net >= 0n ? "+" : ""}
                        {fromMicro(net)}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
}) {
  const toneClass =
    tone === "positive"
      ? "text-[var(--color-positive)]"
      : tone === "negative"
        ? "text-[var(--color-negative)]"
        : "";
  return (
    <div className="card p-5">
      <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {label}
      </p>
      <p className={"mt-2 font-mono text-lg " + toneClass}>{value}</p>
    </div>
  );
}
