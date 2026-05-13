"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fromMicro } from "@oddzilla/types/money";
import type { ChainNetwork, DepositIntentStatus } from "@oddzilla/types";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface AdminDepositEntry {
  id: string;
  userId: string;
  userEmail: string | null;
  userDisplayName: string | null;
  network: ChainNetwork;
  txHash: string;
  fromAddress: string | null;
  toAddress: string | null;
  amountMicro: string | null;
  blockNumber: string | null;
  blockHash: string | null;
  logIndex: number | null;
  confirmations: number;
  status: DepositIntentStatus;
  failureReason: string | null;
  detectedTokenContract: string | null;
  detectedTokenAmountRaw: string | null;
  acknowledgedAt: string | null;
  submittedAt: string;
  creditedAt: string | null;
  rejectedAt: string | null;
}

export interface AdminUnattributedEntry {
  id: string;
  network: ChainNetwork;
  txHash: string;
  logIndex: number;
  blockNumber: string;
  blockHash: string;
  fromAddress: string;
  toAddress: string;
  tokenContract: string;
  tokenSymbol: string | null;
  tokenDecimals: number | null;
  amountRaw: string;
  detectedAt: string;
  acknowledgedAt: string | null;
  note: string | null;
}

const STATUS_COLOR: Record<DepositIntentStatus, string> = {
  pending: "text-[var(--color-warning)]",
  confirming: "text-[var(--color-accent)]",
  credited: "text-[var(--color-positive)]",
  rejected: "text-[var(--color-negative)]",
};

export function AdminDeposits({ entries }: { entries: AdminDepositEntry[] }) {
  return (
    <ul className="divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
      {entries.map((e) => (
        <Row key={e.id} entry={e} />
      ))}
    </ul>
  );
}

export function AdminUnattributed({
  entries,
}: {
  entries: AdminUnattributedEntry[];
}) {
  return (
    <ul className="divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
      {entries.map((e) => (
        <UnattributedRow key={e.id} entry={e} />
      ))}
    </ul>
  );
}

function Row({ entry }: { entry: AdminDepositEntry }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const isWrongToken = entry.failureReason === "wrong_token";

  function call(path: string, body: object) {
    setErr(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/deposits/${entry.id}/${path}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        router.refresh();
      } catch (e) {
        setErr(e instanceof ApiFetchError ? e.body.message : "Action failed.");
      }
    });
  }

  function manualCredit() {
    const amount = window.prompt(
      "Amount in USDC to credit (decimal, e.g. 100.50):",
      entry.amountMicro ? fromMicro(BigInt(entry.amountMicro)) : "",
    );
    if (!amount || amount.trim() === "") return;
    let amountMicro: string;
    try {
      amountMicro = decimalToMicro(amount.trim());
    } catch {
      setErr("Invalid amount.");
      return;
    }
    const note =
      window.prompt("Optional note for the audit log:") ?? undefined;
    call("credit-manual", { amountMicro, note });
  }

  function reject() {
    const reason = window.prompt("Reason for rejection:");
    if (!reason || reason.length < 3) return;
    call("reject", { reason });
  }

  function acknowledge(undo: boolean) {
    if (!undo) {
      const note = window.prompt(
        "Optional note (e.g. 'refunded manually to 0x…'):",
      );
      call("acknowledge", { note: note ?? undefined });
    } else {
      call("acknowledge", { undo: true });
    }
  }

  const canCreditOrReject = entry.status !== "credited" && entry.status !== "rejected";

  return (
    <li
      className="p-5"
      style={
        isWrongToken && !entry.acknowledgedAt
          ? { borderLeft: "3px solid var(--color-negative)" }
          : undefined
      }
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            <span>{entry.network}</span>
            <span>·</span>
            <time dateTime={entry.submittedAt}>
              {new Date(entry.submittedAt).toLocaleString()}
            </time>
            {entry.confirmations > 0 ? (
              <>
                <span>·</span>
                <span>{entry.confirmations} conf</span>
              </>
            ) : null}
            {isWrongToken ? (
              <>
                <span>·</span>
                <span className="text-[var(--color-negative)]">wrong token</span>
              </>
            ) : null}
            {entry.acknowledgedAt ? (
              <>
                <span>·</span>
                <span className="text-[var(--color-positive)]">
                  acked {new Date(entry.acknowledgedAt).toLocaleDateString()}
                </span>
              </>
            ) : null}
          </div>
          <p className="mt-1 text-sm normal-case tracking-normal text-[var(--color-fg)]">
            {entry.userEmail ?? "(unknown user)"}
            {entry.userDisplayName ? (
              <span className="ml-2 text-[var(--color-fg-muted)]">
                {entry.userDisplayName}
              </span>
            ) : null}
            <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
              {entry.userId.slice(0, 8)}
            </span>
          </p>
          <p className="mt-2 break-all font-mono text-xs text-[var(--color-fg-muted)]">
            tx {entry.txHash}
          </p>
          {entry.fromAddress ? (
            <p className="mt-1 break-all font-mono text-xs text-[var(--color-fg-muted)]">
              from {entry.fromAddress}
            </p>
          ) : null}
          {isWrongToken && entry.detectedTokenContract ? (
            <p className="mt-1 break-all font-mono text-xs text-[var(--color-negative)]">
              sent {entry.detectedTokenAmountRaw ?? "?"} of token{" "}
              {entry.detectedTokenContract} (not USDC)
            </p>
          ) : null}
          {entry.failureReason && !isWrongToken ? (
            <p className="mt-1 text-xs text-[var(--color-negative)]">
              {entry.failureReason}
            </p>
          ) : null}
          {err ? (
            <p role="alert" className="mt-2 text-sm text-[var(--color-negative)]">
              {err}
            </p>
          ) : null}
        </div>

        <div className="text-right">
          <p
            className={
              "text-xs uppercase tracking-[0.15em] " + STATUS_COLOR[entry.status]
            }
          >
            {entry.status}
          </p>
          <p className="mt-1 font-mono text-sm">
            {entry.amountMicro
              ? `+${fromMicro(BigInt(entry.amountMicro))} USDC`
              : "—"}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {canCreditOrReject ? (
          <>
            <ActionButton onClick={manualCredit} disabled={pending} accent="positive">
              Credit manually
            </ActionButton>
            <ActionButton onClick={reject} disabled={pending} accent="negative">
              Reject
            </ActionButton>
          </>
        ) : null}
        {isWrongToken ? (
          entry.acknowledgedAt ? (
            <ActionButton
              onClick={() => acknowledge(true)}
              disabled={pending}
              accent="accent"
            >
              Unacknowledge
            </ActionButton>
          ) : (
            <ActionButton
              onClick={() => acknowledge(false)}
              disabled={pending}
              accent="accent"
            >
              Acknowledge
            </ActionButton>
          )
        ) : null}
      </div>
    </li>
  );
}

function UnattributedRow({ entry }: { entry: AdminUnattributedEntry }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function acknowledge(undo: boolean) {
    setErr(null);
    const body: { undo?: boolean; note?: string } = {};
    if (undo) {
      body.undo = true;
    } else {
      const note = window.prompt(
        "Optional note (e.g. 'refunded manually'):",
      );
      if (note) body.note = note;
    }
    startTransition(async () => {
      try {
        await clientApi(
          `/admin/deposits/unattributed/${entry.id}/acknowledge`,
          {
            method: "POST",
            body: JSON.stringify(body),
          },
        );
        router.refresh();
      } catch (e) {
        setErr(e instanceof ApiFetchError ? e.body.message : "Action failed.");
      }
    });
  }

  return (
    <li
      className="p-5"
      style={
        !entry.acknowledgedAt
          ? { borderLeft: "3px solid var(--color-negative)" }
          : undefined
      }
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            <span>{entry.network}</span>
            <span>·</span>
            <time dateTime={entry.detectedAt}>
              {new Date(entry.detectedAt).toLocaleString()}
            </time>
            <span>·</span>
            <span>block {entry.blockNumber}</span>
            {entry.acknowledgedAt ? (
              <>
                <span>·</span>
                <span className="text-[var(--color-positive)]">
                  acked {new Date(entry.acknowledgedAt).toLocaleDateString()}
                </span>
              </>
            ) : null}
          </div>
          <p className="mt-1 text-sm normal-case tracking-normal text-[var(--color-fg)]">
            <span className="font-semibold">
              {entry.tokenSymbol ?? "Unknown token"}
            </span>
            <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
              {entry.tokenContract}
            </span>
          </p>
          <p className="mt-2 break-all font-mono text-xs text-[var(--color-fg-muted)]">
            tx {entry.txHash} · log {entry.logIndex}
          </p>
          <p className="mt-1 break-all font-mono text-xs text-[var(--color-fg-muted)]">
            from {entry.fromAddress}
          </p>
          {entry.note ? (
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
              {entry.note}
            </p>
          ) : null}
          {err ? (
            <p role="alert" className="mt-2 text-sm text-[var(--color-negative)]">
              {err}
            </p>
          ) : null}
        </div>

        <div className="text-right">
          <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-negative)]">
            wrong token
          </p>
          <p className="mt-1 font-mono text-sm">
            {formatAmountRaw(entry.amountRaw, entry.tokenDecimals)}
            {entry.tokenSymbol ? ` ${entry.tokenSymbol}` : ""}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {entry.acknowledgedAt ? (
          <ActionButton
            onClick={() => acknowledge(true)}
            disabled={pending}
            accent="accent"
          >
            Unacknowledge
          </ActionButton>
        ) : (
          <ActionButton
            onClick={() => acknowledge(false)}
            disabled={pending}
            accent="accent"
          >
            Acknowledge
          </ActionButton>
        )}
      </div>
    </li>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  accent,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  accent: "positive" | "negative" | "accent";
}) {
  const colorClass =
    accent === "positive"
      ? "hover:border-[var(--color-positive)] hover:text-[var(--color-positive)]"
      : accent === "negative"
        ? "hover:border-[var(--color-negative)] hover:text-[var(--color-negative)]"
        : "hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] disabled:opacity-50 " +
        colorClass
      }
    >
      {children}
    </button>
  );
}

// formatAmountRaw shifts a uint256 decimal string by `decimals` to
// produce a human-readable display. NULL decimals → render the raw
// value as-is so the operator still sees the magnitude.
function formatAmountRaw(raw: string, decimals: number | null): string {
  if (decimals === null || decimals < 0) return raw;
  if (decimals === 0) return raw;
  if (!/^\d+$/.test(raw)) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// 6-decimal decimal → bigint string. Mirrors @oddzilla/types/money toMicro
// inline so the manual-credit prompt can produce the wire shape.
function decimalToMicro(decimal: string): string {
  if (!/^\d+(\.\d+)?$/.test(decimal)) {
    throw new Error("invalid decimal");
  }
  const [whole = "0", frac = ""] = decimal.split(".");
  const padded = (frac + "000000").slice(0, 6);
  const total = BigInt(whole) * 1_000_000n + BigInt(padded);
  if (total <= 0n) throw new Error("amount must be positive");
  return total.toString();
}
