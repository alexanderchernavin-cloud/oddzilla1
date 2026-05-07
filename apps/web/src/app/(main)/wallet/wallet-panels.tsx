"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { fromMicro, toMicro } from "@oddzilla/types/money";
import type {
  DepositAddress,
  DepositIntentSummary,
  LinkedWalletAddress,
  WithdrawalSummary,
} from "@oddzilla/types";
import { clientApi, ApiFetchError } from "@/lib/api-client";

const STATUS_COLOR: Record<string, string> = {
  pending: "text-[var(--color-warning)]",
  confirming: "text-[var(--color-accent)]",
  credited: "text-[var(--color-positive)]",
  rejected: "text-[var(--color-negative)]",
  requested: "text-[var(--color-warning)]",
  approved: "text-[var(--color-accent)]",
  submitted: "text-[var(--color-accent)]",
  confirmed: "text-[var(--color-positive)]",
  failed: "text-[var(--color-negative)]",
  cancelled: "text-[var(--color-fg-muted)]",
};

export function WalletPanels({
  depositAddress,
  depositsAvailable,
  deposits,
  withdrawals,
  availableMicro,
  linkedWallets,
}: {
  depositAddress: DepositAddress | null;
  depositsAvailable: boolean;
  deposits: DepositIntentSummary[];
  withdrawals: WithdrawalSummary[];
  availableMicro: string;
  linkedWallets: LinkedWalletAddress[];
}) {
  const hasLinkedWallets = linkedWallets.length > 0;
  return (
    <>
      <section className="mt-10 grid gap-6 md:grid-cols-2">
        <DepositCard
          address={depositAddress}
          available={depositsAvailable}
          hasLinkedWallets={hasLinkedWallets}
        />
        <WithdrawCard availableMicro={availableMicro} />
      </section>

      <section className="mt-10">
        <LinkedWalletsCard linkedWallets={linkedWallets} />
      </section>

      <section className="mt-10 grid gap-6 lg:grid-cols-2">
        <DepositList deposits={deposits} />
        <WithdrawalList withdrawals={withdrawals} />
      </section>
    </>
  );
}

// ─── Deposit card ──────────────────────────────────────────────────────────

function DepositCard({
  address,
  available,
  hasLinkedWallets,
}: {
  address: DepositAddress | null;
  available: boolean;
  hasLinkedWallets: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [txHash, setTxHash] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null);
    const trimmed = txHash.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
      setMsg({ kind: "err", text: "Tx hash must be 0x followed by 64 hex characters." });
      return;
    }
    startTransition(async () => {
      try {
        await clientApi("/wallet/deposits/intent", {
          method: "POST",
          body: JSON.stringify({ txHash: trimmed.toLowerCase() }),
        });
        setMsg({
          kind: "ok",
          text: "Tx hash submitted. Your balance will update after the required confirmations.",
        });
        setTxHash("");
        router.refresh();
      } catch (err) {
        setMsg({ kind: "err", text: mapDepositError(err) });
      }
    });
  }

  return (
    <div className="card p-6">
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Deposit
      </h2>

      {!available || !address ? (
        <p className="mt-5 text-sm text-[var(--color-fg-muted)]">
          Deposits are temporarily unavailable. Please check back shortly.
        </p>
      ) : (
        <>
          <div className="mt-5 flex items-start gap-5">
            <div className="rounded-[12px] bg-white p-3">
              <QRCodeSVG value={address.address} size={140} level="M" />
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                  Send {address.currency} on {address.network}
                </p>
                <p className="mt-1 break-all font-mono text-sm">
                  {address.address}
                </p>
              </div>
              <CopyButton text={address.address} />
              <p className="text-xs text-[var(--color-fg-muted)]">
                Send only USDC on Ethereum (ERC20). Tokens on the wrong
                network or contract will be lost.
                {hasLinkedWallets ? (
                  <>
                    {" "}Deposits from your linked wallets are credited
                    automatically — no further action needed.
                  </>
                ) : (
                  <>
                    {" "}Link your sending wallet below to skip the
                    paste-hash step on future deposits, or paste the
                    transaction hash here after sending.
                  </>
                )}
              </p>
            </div>
          </div>

          <form onSubmit={onSubmit} className="mt-5 space-y-3">
            <label className="block">
              <span className="text-xs text-[var(--color-fg-subtle)]">
                Transaction hash
              </span>
              <input
                type="text"
                required
                spellCheck={false}
                autoComplete="off"
                value={txHash}
                onChange={(e) => setTxHash(e.target.value)}
                placeholder="0x…"
                className="mt-1 w-full break-all rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono text-sm outline-none focus:border-[var(--color-accent)]"
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
            <button type="submit" disabled={pending} className="btn btn-primary w-full">
              {pending ? "Submitting…" : "Confirm deposit"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}

function mapDepositError(err: unknown): string {
  if (err instanceof ApiFetchError) {
    switch (err.body.error) {
      case "tx_hash_already_claimed":
        return "That transaction hash has already been submitted.";
      case "deposits_unavailable":
        return "Deposits are currently disabled.";
      case "account_not_active":
        return "Your account is not active. Contact support.";
      default:
        return err.body.message;
    }
  }
  return "Could not submit transaction hash.";
}

// ─── Linked wallets ────────────────────────────────────────────────────────

function LinkedWalletsCard({
  linkedWallets,
}: {
  linkedWallets: LinkedWalletAddress[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null);
    const trimmed = address.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      setMsg({ kind: "err", text: "Address must be 0x followed by 40 hex characters." });
      return;
    }
    startTransition(async () => {
      try {
        await clientApi("/wallet/addresses", {
          method: "POST",
          body: JSON.stringify({
            address: trimmed.toLowerCase(),
            label: label.trim() || undefined,
          }),
        });
        setMsg({ kind: "ok", text: "Wallet linked. Future deposits from it will credit automatically." });
        setAddress("");
        setLabel("");
        router.refresh();
      } catch (err) {
        setMsg({ kind: "err", text: mapLinkError(err) });
      }
    });
  }

  function remove(id: string) {
    setMsg(null);
    setRemovingId(id);
    startTransition(async () => {
      try {
        await clientApi(`/wallet/addresses/${id}`, { method: "DELETE" });
        router.refresh();
      } catch (err) {
        setMsg({
          kind: "err",
          text: err instanceof ApiFetchError ? err.body.message : "Could not unlink.",
        });
      } finally {
        setRemovingId(null);
      }
    });
  }

  return (
    <div className="card p-6">
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Linked wallets
      </h2>
      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
        Register the ERC20 address you send USDC from. Deposits arriving
        from a linked wallet are auto-credited after confirmations — no
        tx hash to paste. One address can only be linked to one
        Oddzilla account.
      </p>

      {linkedWallets.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
          No linked wallets yet.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          {linkedWallets.map((w) => (
            <li
              key={w.id}
              className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                {w.label ? (
                  <p className="text-sm font-medium">{w.label}</p>
                ) : null}
                <p className="break-all font-mono text-xs text-[var(--color-fg-muted)]">
                  {w.address}
                </p>
                <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                  {w.network} · linked {new Date(w.createdAt).toLocaleDateString()}
                </p>
              </div>
              <button
                type="button"
                disabled={pending && removingId === w.id}
                onClick={() => remove(w.id)}
                className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-negative)] disabled:opacity-50"
              >
                {pending && removingId === w.id ? "Removing…" : "Unlink"}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onSubmit} className="mt-5 space-y-3">
        <label className="block">
          <span className="text-xs text-[var(--color-fg-subtle)]">
            Sending address
          </span>
          <input
            type="text"
            required
            spellCheck={false}
            autoComplete="off"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…"
            className="mt-1 w-full break-all rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <label className="block">
          <span className="text-xs text-[var(--color-fg-subtle)]">
            Label (optional)
          </span>
          <input
            type="text"
            maxLength={60}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Coinbase, Ledger, MetaMask"
            className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
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
        <button type="submit" disabled={pending} className="btn btn-primary w-full">
          {pending ? "Linking…" : "Link wallet"}
        </button>
      </form>
    </div>
  );
}

function mapLinkError(err: unknown): string {
  if (err instanceof ApiFetchError) {
    switch (err.body.error) {
      case "address_already_linked":
        return "That address is already linked (possibly to another account).";
      case "address_is_internal":
        return "That's the Oddzilla receive address — pick a sending wallet you control.";
      default:
        return err.body.message;
    }
  }
  return "Could not link wallet.";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // ignore
        }
      }}
      className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
    >
      {copied ? "Copied" : "Copy address"}
    </button>
  );
}

// ─── Withdrawal form ───────────────────────────────────────────────────────

function WithdrawCard({ availableMicro }: { availableMicro: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [amount, setAmount] = useState("");
  const [toAddress, setToAddress] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const available = fromMicro(BigInt(availableMicro));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null);

    let amountMicro: string;
    try {
      const m = toMicro(amount);
      if (m <= 0n) {
        setMsg({ kind: "err", text: "Amount must be positive." });
        return;
      }
      amountMicro = m.toString();
    } catch {
      setMsg({ kind: "err", text: "Invalid amount." });
      return;
    }

    startTransition(async () => {
      try {
        await clientApi("/wallet/withdrawals", {
          method: "POST",
          body: JSON.stringify({
            toAddress: toAddress.trim(),
            amountMicro,
          }),
        });
        setMsg({ kind: "ok", text: "Withdrawal requested. Awaiting admin approval." });
        setAmount("");
        setToAddress("");
        router.refresh();
      } catch (err) {
        setMsg({ kind: "err", text: mapWithdrawError(err) });
      }
    });
  }

  return (
    <form className="card space-y-4 p-6" onSubmit={onSubmit}>
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Withdraw
      </h2>

      <p className="text-xs text-[var(--color-fg-muted)]">
        USDC on Ethereum (ERC20). Manual review by an admin before payout.
      </p>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">Destination address</span>
        <input
          type="text"
          required
          spellCheck={false}
          autoComplete="off"
          value={toAddress}
          onChange={(e) => setToAddress(e.target.value)}
          placeholder="0x…"
          className="mt-1 w-full break-all rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">
          Amount (USDC) — available {available}
        </span>
        <input
          type="number"
          required
          min="0.000001"
          step="0.000001"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono outline-none focus:border-[var(--color-accent)]"
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
        Withdrawals are reviewed manually. The amount is locked while pending
        and refunded if rejected. Cancel an unreviewed request below.
      </p>

      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {pending ? "Submitting…" : "Request withdrawal"}
      </button>
    </form>
  );
}

function mapWithdrawError(err: unknown): string {
  if (err instanceof ApiFetchError) {
    switch (err.body.error) {
      case "insufficient_balance":
        return "Not enough available balance.";
      case "invalid_erc20_address":
        return "Destination is not a valid ERC20 address.";
      case "to_address_is_internal":
        return "That address belongs to Oddzilla — pick an external one.";
      case "amount_must_be_positive":
        return "Amount must be greater than zero.";
      default:
        return err.body.message;
    }
  }
  return "Could not submit withdrawal.";
}

// ─── Deposit list ──────────────────────────────────────────────────────────

function DepositList({ deposits }: { deposits: DepositIntentSummary[] }) {
  return (
    <div>
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Deposits
      </h2>
      {deposits.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
          No deposits yet.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          {deposits.map((d) => {
            const required = Math.max(1, d.confirmationsRequired);
            const pct = Math.min(
              100,
              Math.round((d.confirmations / required) * 100),
            );
            const showProgress =
              d.status !== "credited" && d.status !== "rejected";
            return (
              <li key={d.id} className="px-4 py-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                      {d.network} · {new Date(d.submittedAt).toLocaleString()}
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-[var(--color-fg-muted)]">
                      {d.txHash}
                    </p>
                    {d.failureReason ? (
                      <p className="mt-1 text-xs text-[var(--color-negative)]">
                        {d.failureReason}
                      </p>
                    ) : null}
                    {showProgress ? (
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--color-bg-elevated)]">
                        <div
                          className="h-full bg-[var(--color-accent)]"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    ) : null}
                  </div>
                  <div className="text-right">
                    <p
                      className={
                        "text-xs uppercase tracking-[0.15em] " +
                        (STATUS_COLOR[d.status] ?? "")
                      }
                    >
                      {d.status}
                    </p>
                    <p className="mt-1 font-mono text-sm">
                      {d.amountMicro
                        ? `+${fromMicro(BigInt(d.amountMicro))} USDC`
                        : "—"}
                    </p>
                    {showProgress ? (
                      <p className="text-xs text-[var(--color-fg-muted)]">
                        {d.confirmations} / {d.confirmationsRequired}
                      </p>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Withdrawal list ───────────────────────────────────────────────────────

function WithdrawalList({ withdrawals }: { withdrawals: WithdrawalSummary[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  function cancel(id: string) {
    setErrorById((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    startTransition(async () => {
      try {
        await clientApi(`/wallet/withdrawals/${id}/cancel`, { method: "POST" });
        router.refresh();
      } catch (err) {
        setErrorById((m) => ({
          ...m,
          [id]: err instanceof ApiFetchError ? err.body.message : "Cancel failed.",
        }));
      }
    });
  }

  return (
    <div>
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Withdrawals
      </h2>
      {withdrawals.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
          No withdrawals yet.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          {withdrawals.map((w) => (
            <li key={w.id} className="px-4 py-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                    {w.network} · {new Date(w.requestedAt).toLocaleString()}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-[var(--color-fg-muted)]">
                    {w.toAddress}
                  </p>
                  {w.txHash ? (
                    <p className="mt-1 break-all font-mono text-xs text-[var(--color-fg-subtle)]">
                      tx {w.txHash}
                    </p>
                  ) : null}
                  {w.failureReason ? (
                    <p className="mt-1 text-xs text-[var(--color-negative)]">
                      {w.failureReason}
                    </p>
                  ) : null}
                  {errorById[w.id] ? (
                    <p className="mt-1 text-xs text-[var(--color-negative)]">
                      {errorById[w.id]}
                    </p>
                  ) : null}
                </div>
                <div className="text-right">
                  <p
                    className={
                      "text-xs uppercase tracking-[0.15em] " +
                      (STATUS_COLOR[w.status] ?? "")
                    }
                  >
                    {w.status}
                  </p>
                  <p className="mt-1 font-mono text-sm">
                    -{fromMicro(BigInt(w.amountMicro))} USDC
                  </p>
                  {w.status === "requested" ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => cancel(w.id)}
                      className="mt-2 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-negative)] disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
