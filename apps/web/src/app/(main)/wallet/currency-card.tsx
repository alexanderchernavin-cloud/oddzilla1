"use client";

// Wallet page currency card. Click → makes that currency the active
// one for the bet slip + top-bar pill (single source of truth in
// useBetSlip's context).

import { fromMicro } from "@oddzilla/types/money";
import type { Currency, WalletSnapshot } from "@oddzilla/types";
import { useBetSlip } from "@/lib/bet-slip";

export function CurrencyCard({
  wallet,
  currency,
  tag,
}: {
  wallet: WalletSnapshot | undefined;
  currency: Currency;
  tag: string | null;
}) {
  const slip = useBetSlip();
  const active = slip.currency === currency;

  const balance = wallet ? fromMicro(BigInt(wallet.balanceMicro)) : "—";
  const locked = wallet ? fromMicro(BigInt(wallet.lockedMicro)) : "—";
  const available = wallet ? fromMicro(BigInt(wallet.availableMicro)) : "—";

  return (
    <button
      type="button"
      onClick={() => slip.setCurrency(currency)}
      aria-pressed={active}
      className="card p-6 text-left transition-colors"
      style={{
        borderColor: active
          ? "var(--color-accent, var(--accent))"
          : undefined,
        boxShadow: active
          ? "0 0 0 1px var(--color-accent, var(--accent))"
          : undefined,
        cursor: "pointer",
        font: "inherit",
        width: "100%",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            {currency}
          </p>
          {tag ? (
            <span className="rounded-full border border-[var(--color-border-strong)] px-2 py-[1px] text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
              {tag}
            </span>
          ) : null}
        </div>
        <span
          className="text-[10px] uppercase tracking-[0.15em]"
          style={{
            color: active
              ? "var(--color-accent, var(--accent))"
              : "var(--color-fg-subtle, var(--fg-dim))",
          }}
        >
          {active ? "Active" : "Switch"}
        </span>
      </div>
      <p className="mt-3 font-mono text-3xl text-[var(--color-accent)]">
        {available}
        <span className="ml-2 text-sm text-[var(--color-fg-muted)]">
          {currency}
        </span>
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-y-1 text-xs text-[var(--color-fg-muted)]">
        <dt>Balance</dt>
        <dd className="text-right font-mono text-[var(--color-fg)]">{balance}</dd>
        <dt>Locked</dt>
        <dd className="text-right font-mono text-[var(--color-fg)]">{locked}</dd>
      </dl>
    </button>
  );
}
