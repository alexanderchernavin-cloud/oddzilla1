"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toMicro } from "@oddzilla/types/money";
import { clientApi, ApiFetchError } from "@/lib/api-client";

const STATUS_OPTIONS = ["active", "blocked", "pending_kyc"] as const;
const ROLE_OPTIONS = ["user", "admin", "support"] as const;

export function CreateUserForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [role, setRole] = useState<(typeof ROLE_OPTIONS)[number]>("user");
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>("active");
  const [limit, setLimit] = useState("");
  const [betDelay, setBetDelay] = useState("0");

  function reset() {
    setEmail("");
    setPassword("");
    setDisplayName("");
    setCountryCode("");
    setRole("user");
    setStatus("active");
    setLimit("");
    setBetDelay("0");
    setErr(null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    if (password.length < 8) {
      setErr("password must be at least 8 characters");
      return;
    }

    const delayNum = Number(betDelay);
    if (!Number.isInteger(delayNum) || delayNum < 0 || delayNum > 300) {
      setErr("bet delay must be 0-300 seconds");
      return;
    }

    const trimmedLimit = limit.trim();
    let limitMicro: bigint;
    try {
      limitMicro = trimmedLimit === "" ? 0n : (toMicro(trimmedLimit) as bigint);
    } catch {
      setErr("invalid stake limit");
      return;
    }

    const body: Record<string, unknown> = {
      email: email.trim(),
      password,
      role,
      status,
      betDelaySeconds: delayNum,
      globalLimitMicro: limitMicro.toString(),
    };
    const dn = displayName.trim();
    if (dn) body.displayName = dn;
    const cc = countryCode.trim();
    if (cc) body.countryCode = cc;

    startTransition(async () => {
      try {
        await clientApi(`/admin/users`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        reset();
        setOpen(false);
        router.refresh();
      } catch (e) {
        setErr(e instanceof ApiFetchError ? e.body.message : "Create failed");
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-[8px] border border-[var(--color-accent)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:bg-[color-mix(in_oklab,var(--color-accent)_10%,transparent)]"
      >
        New user
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="card space-y-5 p-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
          Create user
        </h2>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
        >
          Cancel
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Email
          </span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            required
            autoComplete="off"
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Password
          </span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="text"
            required
            autoComplete="off"
            minLength={8}
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-2 font-mono"
          />
          <span className="text-xs text-[var(--color-fg-subtle)]">
            At least 8 characters. Share it with the user over a secure channel.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Display name (optional)
          </span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={64}
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Country code (optional)
          </span>
          <input
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
            maxLength={2}
            placeholder="US"
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-2 font-mono uppercase"
          />
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
            Bet delay (sec)
          </span>
          <input
            value={betDelay}
            onChange={(e) => setBetDelay(e.target.value)}
            inputMode="numeric"
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-2 font-mono"
          />
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

      <button
        type="submit"
        disabled={pending}
        className="rounded-[8px] border border-[var(--color-accent)] px-4 py-2 text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] disabled:opacity-50 hover:bg-[color-mix(in_oklab,var(--color-accent)_10%,transparent)]"
      >
        {pending ? "Creating..." : "Create user"}
      </button>
    </form>
  );
}
