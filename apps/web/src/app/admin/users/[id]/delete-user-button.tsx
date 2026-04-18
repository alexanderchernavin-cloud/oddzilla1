"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export function DeleteUserButton({
  userId,
  email,
}: {
  userId: string;
  email: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function remove() {
    setErr(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/users/${userId}`, { method: "DELETE" });
        router.replace("/admin/users");
        router.refresh();
      } catch (e) {
        const msg =
          e instanceof ApiFetchError
            ? e.body.message === "user_has_financial_history"
              ? "Cannot delete: user has tickets, ledger entries, or balance. Block the account instead."
              : e.body.message
            : "Delete failed";
        setErr(msg);
        setConfirming(false);
      }
    });
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-[8px] border border-[var(--color-negative)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-negative)] hover:bg-[color-mix(in_oklab,var(--color-negative)_10%,transparent)]"
      >
        Delete user
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-[var(--color-fg)]">
        Permanently delete <span className="font-mono">{email}</span>? Only works
        for accounts with no tickets, ledger entries, or balance.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={remove}
          disabled={pending}
          className="rounded-[8px] border border-[var(--color-negative)] bg-[var(--color-negative)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-bg)] disabled:opacity-50"
        >
          {pending ? "Deleting..." : "Confirm delete"}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            setErr(null);
          }}
          disabled={pending}
          className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          Cancel
        </button>
      </div>
      {err ? (
        <p role="alert" className="text-sm text-[var(--color-negative)]">
          {err}
        </p>
      ) : null}
    </div>
  );
}
