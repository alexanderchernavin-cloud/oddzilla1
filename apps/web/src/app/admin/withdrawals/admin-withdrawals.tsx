"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fromMicro } from "@oddzilla/types/money";
import type { ChainNetwork, WithdrawalStatus } from "@oddzilla/types";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface AdminWithdrawalEntry {
  id: string;
  userId: string;
  network: ChainNetwork;
  toAddress: string;
  amountMicro: string;
  feeMicro: string;
  status: WithdrawalStatus;
  txHash: string | null;
  requestedAt: string;
  approvedAt: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  failureReason: string | null;
}

const STATUS_COLOR: Record<WithdrawalStatus, string> = {
  requested: "text-[var(--color-warning)]",
  approved: "text-[var(--color-accent)]",
  submitted: "text-[var(--color-accent)]",
  confirmed: "text-[var(--color-positive)]",
  failed: "text-[var(--color-negative)]",
  cancelled: "text-[var(--color-fg-muted)]",
};

export function AdminWithdrawals({ entries }: { entries: AdminWithdrawalEntry[] }) {
  return (
    <ul className="divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
      {entries.map((e) => (
        <Row key={e.id} entry={e} />
      ))}
    </ul>
  );
}

function Row({ entry }: { entry: AdminWithdrawalEntry }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function call(path: string, body?: object) {
    setErr(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/withdrawals/${entry.id}/${path}`, {
          method: "POST",
          body: JSON.stringify(body ?? {}),
        });
        router.refresh();
      } catch (e) {
        setErr(e instanceof ApiFetchError ? e.body.message : "Action failed.");
      }
    });
  }

  function approve() {
    const note = window.prompt("Optional note for the audit log:") ?? undefined;
    call("approve", { feeMicro: "0", note });
  }
  function reject() {
    const reason = window.prompt("Reason for rejection:");
    if (!reason || reason.length < 3) return;
    call("reject", { reason });
  }
  function markSubmitted() {
    const txHash = window.prompt("On-chain tx hash:");
    if (!txHash) return;
    call("mark-submitted", { txHash });
  }
  function markConfirmed() {
    const txHash = entry.txHash ?? window.prompt("Tx hash:");
    if (!txHash) return;
    call("mark-confirmed", { txHash });
  }
  function markFailed() {
    const reason = window.prompt("Failure reason:");
    if (!reason || reason.length < 3) return;
    const txHash = window.prompt("Tx hash (if any, blank to skip):") ?? undefined;
    call("mark-failed", { reason, txHash: txHash || undefined });
  }

  return (
    <li className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            <span>{entry.network}</span>
            <span>·</span>
            <time dateTime={entry.requestedAt}>
              {new Date(entry.requestedAt).toLocaleString()}
            </time>
            <span>·</span>
            <span className="font-mono normal-case">user {entry.userId.slice(0, 8)}</span>
          </div>
          <p className="mt-2 break-all font-mono text-sm">{entry.toAddress}</p>
          {entry.txHash ? (
            <p className="mt-1 break-all font-mono text-xs text-[var(--color-fg-muted)]">
              tx {entry.txHash}
            </p>
          ) : null}
          {entry.failureReason ? (
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
          <p className={"text-xs uppercase tracking-[0.15em] " + STATUS_COLOR[entry.status]}>
            {entry.status}
          </p>
          <p className="mt-1 font-mono text-sm">
            {fromMicro(BigInt(entry.amountMicro))} USDT
          </p>
          {BigInt(entry.feeMicro) > 0n ? (
            <p className="font-mono text-xs text-[var(--color-fg-muted)]">
              fee {fromMicro(BigInt(entry.feeMicro))}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {entry.status === "requested" ? (
          <>
            <ActionButton onClick={approve} disabled={pending} accent="positive">
              Approve
            </ActionButton>
            <ActionButton onClick={reject} disabled={pending} accent="negative">
              Reject
            </ActionButton>
          </>
        ) : null}
        {entry.status === "approved" ? (
          <>
            <ActionButton onClick={markSubmitted} disabled={pending} accent="accent">
              Mark submitted (tx hash)
            </ActionButton>
            <ActionButton onClick={markFailed} disabled={pending} accent="negative">
              Mark failed
            </ActionButton>
          </>
        ) : null}
        {entry.status === "submitted" ? (
          <>
            <ActionButton onClick={markConfirmed} disabled={pending} accent="positive">
              Mark confirmed
            </ActionButton>
            <ActionButton onClick={markFailed} disabled={pending} accent="negative">
              Mark failed
            </ActionButton>
          </>
        ) : null}
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
