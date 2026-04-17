import Link from "next/link";
import { fromMicro } from "@oddzilla/types/money";
import { serverApi } from "@/lib/server-fetch";

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
}
interface ListResponse {
  users: AdminUserRow[];
  limit: number;
  offset: number;
}

const ALLOWED_STATUS = ["active", "blocked", "pending_kyc"] as const;
const ALLOWED_ROLES = ["user", "admin", "support"] as const;

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; role?: string; offset?: string }>;
}) {
  const params = await searchParams;
  const q = params.q?.trim();
  const status = ALLOWED_STATUS.includes(params.status as (typeof ALLOWED_STATUS)[number])
    ? params.status
    : undefined;
  const role = ALLOWED_ROLES.includes(params.role as (typeof ALLOWED_ROLES)[number])
    ? params.role
    : undefined;
  const offset = Number(params.offset ?? 0) || 0;

  const qs = new URLSearchParams({ limit: "50", offset: String(offset) });
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  if (role) qs.set("role", role);

  const data = await serverApi<ListResponse>(`/admin/users?${qs.toString()}`);
  const users = data?.users ?? [];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
        Block, adjust limits, or toggle bet-delay. Every write is audited.
      </p>

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
            Role
          </span>
          <select
            name="role"
            defaultValue={role ?? ""}
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-1.5"
          >
            <option value="">any</option>
            {ALLOWED_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
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
      </form>

      {users.length === 0 ? (
        <p className="mt-8 text-sm text-[var(--color-fg-muted)]">No users match.</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                <th className="px-4 py-3 text-left font-normal">Email</th>
                <th className="px-4 py-3 text-left font-normal">Role</th>
                <th className="px-4 py-3 text-left font-normal">Status</th>
                <th className="px-4 py-3 text-left font-normal">KYC</th>
                <th className="px-4 py-3 text-right font-normal">Balance</th>
                <th className="px-4 py-3 text-right font-normal">Limit</th>
                <th className="px-4 py-3 text-right font-normal">Delay</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-[var(--color-border)] last:border-b-0">
                  <td className="px-4 py-3">
                    <p className="truncate">{u.email}</p>
                    {u.displayName ? (
                      <p className="text-xs text-[var(--color-fg-subtle)]">{u.displayName}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)]">
                    {u.role}
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
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
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
              href={buildHref({ q, status, role, offset: Math.max(0, offset - 50) })}
              className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              Previous
            </Link>
          ) : null}
          {users.length >= 50 ? (
            <Link
              href={buildHref({ q, status, role, offset: offset + 50 })}
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
  role?: string;
  offset: number;
}): string {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.status) qs.set("status", params.status);
  if (params.role) qs.set("role", params.role);
  qs.set("offset", String(params.offset));
  return `/admin/users?${qs.toString()}`;
}
