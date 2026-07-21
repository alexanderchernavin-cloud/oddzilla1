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
import { useLocale, useTranslations } from "@/lib/i18n";

// Translator signature shared by the error mappers below — they resolve
// API error codes to dictionary keys at the call site so the message
// renders in the active locale.
type Translator = (key: string, values?: Record<string, string | number>) => string;

// NOTE: there is intentionally no "paste your tx hash" form. With one
// shared receive address, on-chain Transfers are public — anyone
// watching Etherscan could see another user's tx and try to claim it
// for themselves. The only safe attribution channel is the linked-
// wallet whitelist (POST /wallet/addresses): the watcher matches
// incoming Transfers' from-address against per-user whitelists and
// auto-credits. Deposits from unlinked senders fall through to admin
// review at /admin/deposits.
//
// Linking requires PROOF OF CONTROL: the user signs an EIP-191 challenge
// (GET /wallet/addresses/challenge) with the wallet, and the server
// verifies the signature recovers the address before storing it — so a
// bettor can't claim an address (e.g. a CEX hot wallet) they don't own.

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

// Minimal EIP-1193 provider shape — we only call request(). Avoids pulling
// a web3 library into the storefront bundle just to personal_sign.
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function getEthereum(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return eth ?? null;
}

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
  const t = useTranslations("wallet");
  return (
    <div className="card p-6">
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {t("deposit")}
      </h2>

      {!available || !address ? (
        <p className="mt-5 text-sm text-[var(--color-fg-muted)]">
          {t("depositsUnavailable")}
        </p>
      ) : (
        <div className="mt-5 flex items-start gap-5">
          <div className="rounded-[12px] bg-white p-3">
            <QRCodeSVG value={address.address} size={140} level="M" />
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <div>
              <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                {t("sendOn", { currency: address.currency, network: address.network })}
              </p>
              <p className="mt-1 break-all font-mono text-sm">
                {address.address}
              </p>
            </div>
            <CopyButton text={address.address} />
            {hasLinkedWallets ? (
              <p className="text-xs text-[var(--color-fg-muted)]">
                {t("depositNoteLinked")}
              </p>
            ) : (
              <p className="text-xs text-[var(--color-warning)]">
                {t("depositNoteUnlinked")}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Linked wallets ────────────────────────────────────────────────────────

function LinkedWalletsCard({
  linkedWallets,
}: {
  linkedWallets: LinkedWalletAddress[];
}) {
  const router = useRouter();
  const t = useTranslations("wallet");
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Connect the browser wallet and pre-fill the address with the active
  // account, so the user links the wallet they actually control.
  async function connect() {
    setMsg(null);
    const eth = getEthereum();
    if (!eth) {
      setMsg({ kind: "err", text: t("noWalletDetected") });
      return;
    }
    try {
      const accounts = (await eth.request({
        method: "eth_requestAccounts",
      })) as string[];
      const account = accounts?.[0];
      if (!account) {
        setMsg({ kind: "err", text: t("noWalletAccount") });
        return;
      }
      setAddress(account);
    } catch {
      setMsg({ kind: "err", text: t("walletConnRejected") });
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null);
    const trimmed = address.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      setMsg({ kind: "err", text: t("addressFormat") });
      return;
    }
    const eth = getEthereum();
    if (!eth) {
      setMsg({ kind: "err", text: t("noWalletDetected") });
      return;
    }
    startTransition(async () => {
      try {
        // 1. The connected wallet must BE the address being linked.
        const accounts = (await eth.request({
          method: "eth_requestAccounts",
        })) as string[];
        const account = accounts?.[0];
        if (!account) {
          setMsg({ kind: "err", text: t("noWalletAccount") });
          return;
        }
        if (account.toLowerCase() !== trimmed.toLowerCase()) {
          setMsg({
            kind: "err",
            text: t("accountMismatch"),
          });
          return;
        }
        // 2. Fetch the server challenge and sign it (proof of control).
        const challenge = await clientApi<{ issuedAt: number; message: string }>(
          `/wallet/addresses/challenge?address=${encodeURIComponent(trimmed)}`,
        );
        const signature = (await eth.request({
          method: "personal_sign",
          params: [challenge.message, account],
        })) as string;
        // 3. Submit the signed proof.
        await clientApi("/wallet/addresses", {
          method: "POST",
          body: JSON.stringify({
            address: trimmed,
            label: label.trim() || undefined,
            signature,
            issuedAt: challenge.issuedAt,
          }),
        });
        setMsg({ kind: "ok", text: t("linkSuccess") });
        setAddress("");
        setLabel("");
        router.refresh();
      } catch (err) {
        setMsg({ kind: "err", text: mapLinkError(err, t) });
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
          text: err instanceof ApiFetchError ? err.body.message : t("errUnlink"),
        });
      } finally {
        setRemovingId(null);
      }
    });
  }

  return (
    <div className="card p-6">
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {t("linkedWallets")}
      </h2>
      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
        {t("linkedWalletsIntro")}
      </p>

      {linkedWallets.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
          {t("noLinkedWallets")}
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
                  {t("linkedMeta", {
                    network: w.network,
                    date: new Date(w.createdAt).toLocaleDateString(locale),
                  })}
                </p>
              </div>
              <button
                type="button"
                disabled={pending && removingId === w.id}
                onClick={() => remove(w.id)}
                className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-negative)] disabled:opacity-50"
              >
                {pending && removingId === w.id ? t("removing") : t("unlink")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onSubmit} className="mt-5 space-y-3">
        <button
          type="button"
          onClick={connect}
          disabled={pending}
          className="w-full rounded-[10px] border border-[var(--color-border-strong)] px-3 py-2 text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-50"
        >
          {t("connectWallet")}
        </button>
        <label className="block">
          <span className="text-xs text-[var(--color-fg-subtle)]">
            {t("sendingAddress")}
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
            {t("labelOptional")}
          </span>
          <input
            type="text"
            maxLength={60}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("labelPlaceholder")}
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
          {pending ? t("signing") : t("signAndLink")}
        </button>
      </form>
    </div>
  );
}

function mapLinkError(err: unknown, t: Translator): string {
  if (err instanceof ApiFetchError) {
    switch (err.body.error) {
      case "address_already_linked":
        return t("errAlreadyLinked");
      case "address_is_internal":
        return t("errInternalAddress");
      case "address_not_allowed":
        return t("errCustodialAddress");
      case "signature_address_mismatch":
        return t("errSignatureMismatch");
      case "invalid_signature":
        return t("errInvalidSignature");
      case "challenge_expired":
        return t("errChallengeExpired");
      case "invalid_address":
        return t("errInvalidAddress");
      default:
        return err.body.message;
    }
  }
  // EIP-1193 user-rejected-request (e.g. closed the wallet prompt).
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === 4001
  ) {
    return t("errSignatureRejected");
  }
  return t("errLinkGeneric");
}

function CopyButton({ text }: { text: string }) {
  const t = useTranslations("wallet");
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
      {copied ? t("copied") : t("copyAddress")}
    </button>
  );
}

// ─── Withdrawal form ───────────────────────────────────────────────────────

function WithdrawCard({ availableMicro }: { availableMicro: string }) {
  const router = useRouter();
  const t = useTranslations("wallet");
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
        setMsg({ kind: "err", text: t("amountPositive") });
        return;
      }
      amountMicro = m.toString();
    } catch {
      setMsg({ kind: "err", text: t("invalidAmount") });
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
        setMsg({ kind: "ok", text: t("withdrawRequested") });
        setAmount("");
        setToAddress("");
        router.refresh();
      } catch (err) {
        setMsg({ kind: "err", text: mapWithdrawError(err, t) });
      }
    });
  }

  return (
    <form className="card space-y-4 p-6" onSubmit={onSubmit}>
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {t("withdraw")}
      </h2>

      <p className="text-xs text-[var(--color-fg-muted)]">
        {t("withdrawNote")}
      </p>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">{t("destinationAddress")}</span>
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
          {t("amountAvailable", { amount: available })}
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
        {t("withdrawReviewNote")}
      </p>

      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {pending ? t("submitting") : t("requestWithdrawal")}
      </button>
    </form>
  );
}

function mapWithdrawError(err: unknown, t: Translator): string {
  if (err instanceof ApiFetchError) {
    switch (err.body.error) {
      case "insufficient_balance":
        return t("errInsufficientBalance");
      case "invalid_erc20_address":
        return t("errInvalidDestination");
      case "to_address_is_internal":
        return t("errInternalDestination");
      case "amount_must_be_positive":
        return t("errAmountZero");
      default:
        return err.body.message;
    }
  }
  return t("errWithdrawGeneric");
}

// ─── Deposit list ──────────────────────────────────────────────────────────

function DepositList({ deposits }: { deposits: DepositIntentSummary[] }) {
  const t = useTranslations("wallet");
  const locale = useLocale();
  return (
    <div>
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {t("deposits")}
      </h2>
      {deposits.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
          {t("noDeposits")}
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
                      {d.network} · {new Date(d.submittedAt).toLocaleString(locale)}
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
                      {t(`status.${d.status}`)}
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
  const t = useTranslations("wallet");
  const locale = useLocale();
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
          [id]: err instanceof ApiFetchError ? err.body.message : t("cancelFailed"),
        }));
      }
    });
  }

  return (
    <div>
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {t("withdrawals")}
      </h2>
      {withdrawals.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
          {t("noWithdrawals")}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          {withdrawals.map((w) => (
            <li key={w.id} className="px-4 py-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                    {w.network} · {new Date(w.requestedAt).toLocaleString(locale)}
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
                    {t(`status.${w.status}`)}
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
                      {t("cancel")}
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
