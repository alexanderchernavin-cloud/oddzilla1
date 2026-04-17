"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toMicro, fromMicro } from "@oddzilla/types/money";
import { clientApi, ApiFetchError } from "@/lib/api-client";

interface UserInput {
  id: string;
  status: "active" | "blocked" | "pending_kyc";
  role: "user" | "admin" | "support";
  globalLimitMicro: string;
  betDelaySeconds: number;
}

const STATUS_OPTIONS = ["active", "blocked", "pending_kyc"] as const;
const ROLE_OPTIONS = ["user", "admin", "support"] as const;

export function UserEditForm({ user }: { user: UserInput }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const [status, setStatus] = useState(user.status);
  const [role, setRole] = useState(user.role);
  const [betDelay, setBetDelay] = useState(String(user.betDelaySeconds));
  const [limit, setLimit] = useState(
    BigInt(user.globalLimitMicro) === 0n ? "" : fromMicro(BigInt(user.globalLimitMicro)),
  );

  function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setOk(null);

    const body: Record<string, unknown> = {};
    if (status !== user.status) body.status = status;
    if (role !== user.role) body.role = role;

    const delayNum = Number(betDelay);
    if (!Number.isInteger(delayNum) || delayNum < 0 || delayNum > 300) {
      setErr("bet delay must be 0-300 seconds");
      return;
    }
    if (delayNum !== user.betDelaySeconds) body.betDelaySeconds = delayNum;

    const trimmedLimit = limit.trim();
    let limitMicro: bigint;
    try {
      limitMicro = trimmedLimit === "" ? 0n : (toMicro(trimmedLimit) as bigint);
    } catch {
      setErr("invalid stake limit");
      return;
    }
    if (limitMicro !== BigInt(user.globalLimitMicro)) {
      body.globalLimitMicro = limitMicro.toString();
    }

    if (Object.keys(body).length === 0) {
      setErr("nothing changed");
      return;
    }

    startTransition(async () => {
      try {
        await clientApi(`/admin/users/${user.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        setOk("saved");
        router.refresh();
      } catch (e) {
        setErr(e instanceof ApiFetchError ? e.body.message : "Save failed");
      }
    });
  }

  return (
    <form onSubmit={save} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Status
          </span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-2"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Role
          </span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-2"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Bet delay (sec)
          </span>
          <input
            value={betDelay}
            onChange={(e) => setBetDelay(e.target.value)}
            inputMode="numeric"
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-2 font-mono"
          />
          <span className="text-xs text-[var(--color-fg-subtle)]">
            0 disables the delay; max 300.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Stake limit (USDT / ticket)
          </span>
          <input
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            inputMode="decimal"
            placeholder="blank = no limit"
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-2 font-mono"
          />
        </label>
      </div>

      {err ? (
        <p role="alert" className="text-sm text-[var(--color-negative)]">
          {err}
        </p>
      ) : null}
      {ok ? (
        <p className="text-sm text-[var(--color-positive)]">{ok}</p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-[8px] border border-[var(--color-accent)] px-4 py-2 text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] disabled:opacity-50 hover:bg-[color-mix(in_oklab,var(--color-accent)_10%,transparent)]"
      >
        {pending ? "Saving..." : "Save changes"}
      </button>
    </form>
  );
}
