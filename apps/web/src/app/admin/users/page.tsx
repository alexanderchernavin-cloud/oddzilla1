import Link from "next/link";
import { fromMicro } from "@oddzilla/types/money";
import {
  BETTOR_LABELS,
  riskFactorToPercent,
  type BettorLabel,
} from "@oddzilla/types/bettor-labels";
import { serverApi } from "@/lib/server-fetch";
import { CreateUserForm } from "./create-user-form";
import { BettorRow } from "./bettor-row";
import { LabelChip } from "./label-chip";

interface AdminUserRow {
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
  labels: string[];
  riskScore: string;
}
interface ListResponse {
  users: AdminUserRow[];
  limit: number;
  offset: number;
}

const ALLOWED_STATUS = ["active", "blocked", "pending_kyc"] as const;

function isLabel(v: string | undefined): v is BettorLabel {
  return v !== undefined && (BETTOR_LABELS as readonly string[]).includes(v);
}

export default async function AdminBettorsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; label?: string; offset?: string }>;
}) {
  const params = await searchParams;
  const q = params.q?.trim();
  const status = ALLOWED_STATUS.includes(params.status as (typeof ALLOWED_STATUS)[number])
    ? params.status
    : undefined;
  const label = isLabel(params.label) ? params.label : undefined;
  const offset = Number(params.offset ?? 0) || 0;

  // Pinned to bettor role. Admin/support accounts live under /admin/admins.
  const qs = new URLSearchParams({
    limit: "50",
    offset: String(offset),
    role: "user",
  });
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  if (label) qs.set("label", label);

  const data = await serverApi<ListResponse>(`/admin/users?${qs.toString()}`);
  const users = data?.users ?? [];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">
        Bettor user management
      </h1>
      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
        Player accounts. Click a row to open the bettor card: PnL, identity,
        labels, risk factor and limits. Every write is audited. Backoffice
        operators live under{" "}
        <Link
          href="/admin/admins"
          className="text-[var(--color-accent)] hover:underline"
        >
          Admins
        </Link>
        .
      </p>

      <div className="mt-6">
        <CreateUserForm mode="bettor" />
      </div>

      <form className="mt-6 flex flex-wrap items-end gap-3 text-sm" action="/admin/users">
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Search
          </span>
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="email or display name"
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-1.5"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Status
          </span>
          <select
            name="status"
            defaultValue={status ?? ""}
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-1.5"
          >
            <option value="">any</option>
            {ALLOWED_STATUS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Label
          </span>
          <select
            name="label"
            defaultValue={label ?? ""}
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-1.5"
          >
            <option value="">any</option>
            {BETTOR_LABELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-[8px] border border-[var(--color-accent)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:bg-[color-mix(in_oklab,var(--color-accent)_10%,transparent)]"
        >
          Apply
        </button>
        {q || status || label ? (
          <Link
            href="/admin/users"
            className="py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          >
            Reset
          </Link>
        ) : null}
      </form>

      {users.length === 0 ? (
        <p className="mt-8 text-sm text-[var(--color-fg-muted)]">No bettors match.</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                <th className="px-4 py-3 text-left font-normal">Bettor</th>
                <th className="px-4 py-3 text-left font-normal">Status</th>
                <th className="px-4 py-3 text-left font-normal">KYC</th>
                <th className="px-4 py-3 text-right font-normal">Risk factor</th>
                <th className="px-4 py-3 text-right font-normal">Balance</th>
                <th className="px-4 py-3 text-right font-normal">Limit</th>
                <th className="px-4 py-3 text-right font-normal">Delay</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const rf = Number(u.riskScore);
                const rfTone =
                  rf < 1
                    ? "text-[var(--color-negative)]"
                    : rf > 1
                      ? "text-[var(--color-positive)]"
                      : "text-[var(--color-fg-muted)]";
                return (
                  <BettorRow key={u.id} href={`/admin/users/${u.id}`}>
                    <td className="px-4 py-3">
                      <p className="truncate">{u.email}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {u.displayName ? (
                          <span className="text-xs text-[var(--color-fg-subtle)]">{u.displayName}</span>
                        ) : null}
                        {u.labels.filter(isLabel).map((l) => (
                          <LabelChip key={l} label={l} />
                        ))}
                      </div>
                    </td>
                    <td
                      className={
                        "px-4 py-3 text-xs uppercase tracking-[0.15em] " +
                        (u.status === "active"
                          ? "text-[var(--color-positive)]"
                          : u.status === "blocked"
                            ? "text-[var(--color-negative)]"
                            : "text-[var(--color-warning)]")
                      }
                    >
                      {u.status}
                    </td>
                    <td className="px-4 py-3 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)]">
                      {u.kycStatus}
                    </td>
                    <td className={"px-4 py-3 text-right font-mono " + rfTone}>
                      {rf.toFixed(1)}
                      <span className="ml-1 text-xs text-[var(--color-fg-subtle)]">
                        {riskFactorToPercent(rf)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {fromMicro(BigInt(u.balanceMicro))}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[var(--color-fg-muted)]">
                      {BigInt(u.globalLimitMicro) === 0n ? "—" : fromMicro(BigInt(u.globalLimitMicro))}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[var(--color-fg-muted)]">
                      {u.betDelaySeconds}s
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/users/${u.id}`}
                        className="text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:underline"
                      >
                        Open
                      </Link>
                    </td>
                  </BettorRow>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <nav className="mt-4 flex items-center justify-between text-sm">
        <span className="text-[var(--color-fg-subtle)]">
          offset {offset} · {users.length} shown
        </span>
        <div className="flex items-center gap-2">
          {offset > 0 ? (
            <Link
              href={buildHref({ q, status, label, offset: Math.max(0, offset - 50) })}
              className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              Previous
            </Link>
          ) : null}
          {users.length >= 50 ? (
            <Link
              href={buildHref({ q, status, label, offset: offset + 50 })}
              className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              Next
            </Link>
          ) : null}
        </div>
      </nav>
    </div>
  );
}

function buildHref(params: {
  q?: string;
  status?: string;
  label?: string;
  offset: number;
}): string {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.status) qs.set("status", params.status);
  if (params.label) qs.set("label", params.label);
  qs.set("offset", String(params.offset));
  return `/admin/users?${qs.toString()}`;
}
