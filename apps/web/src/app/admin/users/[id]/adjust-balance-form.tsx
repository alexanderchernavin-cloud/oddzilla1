"use client";

// Admin "Adjust balance" form.
//
// Fires POST /admin/users/:id/adjust-balance with a signed delta in
// micro units. The endpoint is gated server-side to the balance-edit
// operator allowlist (see services/api/src/lib/balance-edit-gate.ts),
// so non-allowlisted admins see a 403 on submit.

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { fromMicro, toMicro } from "@oddzilla/types/money";
import { SUPPORTED_CURRENCIES, type Currency } from "@oddzilla/types/currencies";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export function AdjustBalanceForm({
  userId,
  email,
}: {
  userId: string;
  email: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [currency, setCurrency] = useState<Currency>("USDC");
  // Signed decimal — operators type "5" or "-5.50". Converted to a
  // signed micro string at submit. Empty string lets us validate on
  // submit rather than on every keystroke.
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null);

    const trimmed = amount.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      setMsg({ kind: "err", text: "Amount must be a signed decimal (e.g. 5 or -5.50)." });
      return;
    }
    let deltaMicro: string;
    try {
      const m = toMicro(trimmed);
      if (m === 0n) {
        setMsg({ kind: "err", text: "Amount must be non-zero." });
        return;
      }
      deltaMicro = m.toString();
    } catch {
      setMsg({ kind: "err", text: "Invalid amount." });
      return;
    }

    if (reason.trim().length < 3) {
      setMsg({ kind: "err", text: "Reason must be at least 3 characters." });
      return;
    }

    startTransition(async () => {
      try {
        await clientApi(`/admin/users/${userId}/adjust-balance`, {
          method: "POST",
          body: JSON.stringify({
            currency,
            deltaMicro,
            reason: reason.trim(),
          }),
        });
        const direction = deltaMicro.startsWith("-") ? "Debited" : "Credited";
        const display = fromMicro(BigInt(deltaMicro.replace("-", "")));
        setMsg({
          kind: "ok",
          text: `${direction} ${display} ${currency} on ${email}.`,
        });
        setAmount("");
        setReason("");
        router.refresh();
      } catch (err) {
        setMsg({ kind: "err", text: mapAdjustError(err) });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Currency
          </span>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as Currency)}
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-2 font-mono"
          >
            {SUPPORTED_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Signed amount (positive credits, negative debits)
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 5 or -5.50"
            spellCheck={false}
            autoComplete="off"
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-2 font-mono"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Reason (audit log)
        </span>
        <input
          type="text"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. promo credit, support refund, correction"
          className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-2"
        />
      </label>

      {msg ? (
        <p
          role={msg.kind === "err" ? "alert" : "status"}
          className={
            "text-sm " +
            (msg.kind === "ok"
              ? "text-[var(--color-positive)]"
              : "text-[var(--color-negative)]")
          }
        >
          {msg.text}
        </p>
      ) : null}

      <p className="text-xs text-[var(--color-fg-muted)]">
        Refuses to push balance below 0 or below the user&apos;s locked
        amount. Restricted to the balance-edit operator allowlist;
        every adjustment writes a <span className="font-mono">wallet_ledger</span>{" "}
        row + tamper-evident <span className="font-mono">admin_audit_log</span>{" "}
        entry.
      </p>

      <button
        type="submit"
        disabled={pending}
        className="rounded-[8px] border border-[var(--color-border-strong)] px-4 py-2 text-xs uppercase tracking-[0.15em] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
      >
        {pending ? "Applying…" : "Apply adjustment"}
      </button>
    </form>
  );
}

function mapAdjustError(err: unknown): string {
  if (err instanceof ApiFetchError) {
    switch (err.body.error) {
      case "balance_edit_not_authorized":
        return "Your admin account isn't on the balance-edit allowlist.";
      case "would_go_negative":
        return "Refused: that delta would push balance below zero.";
      case "would_violate_locked":
        return "Refused: that delta would push balance below the user's locked amount.";
      case "delta_zero":
        return "Amount must be non-zero.";
      case "wallet_not_found":
        return "User has no wallet for that currency.";
      case "user_not_found":
        return "User not found.";
      default:
        return err.body.message;
    }
  }
  return "Adjustment failed.";
}
