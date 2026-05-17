"use client";

// Admin debug knob — view + override the user's ZillaPass stage.
//
// PUT /admin/users/:id/zillapass-stage takes a `currentSetNumber`
// (≥ 1) and optionally `lastSetCompletedDate` ('YYYY-MM-DD' | null |
// omitted). Two common shortcuts surface inline:
//
//   - Reset to set 1, clear stamp — the user starts over from day-1.
//   - Mark this set complete yesterday — the user advances to the
//     next set on their next /zillapass/me read (the reader sees a
//     stamp < today and bumps current_set_number by one).

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export function ZillapassStageForm({
  userId,
  initial,
}: {
  userId: string;
  initial: { currentSetNumber: number; lastSetCompletedDate: string | null };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [setNumber, setSetNumber] = useState(String(initial.currentSetNumber));
  // Tri-state for the stamp: empty string ⇒ "no stamp", a YYYY-MM-DD
  // string ⇒ stamp set. The form serialises to null vs the date.
  const [stampDate, setStampDate] = useState(initial.lastSetCompletedDate ?? "");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null);
    const n = Number(setNumber);
    if (!Number.isInteger(n) || n < 1) {
      setMsg({ kind: "err", text: "Set number must be a positive integer." });
      return;
    }
    const body: {
      currentSetNumber: number;
      lastSetCompletedDate: string | null;
    } = {
      currentSetNumber: n,
      lastSetCompletedDate: stampDate.trim() === "" ? null : stampDate.trim(),
    };
    if (
      body.lastSetCompletedDate !== null &&
      !/^\d{4}-\d{2}-\d{2}$/.test(body.lastSetCompletedDate)
    ) {
      setMsg({ kind: "err", text: "Stamp must be YYYY-MM-DD or empty." });
      return;
    }

    startTransition(async () => {
      try {
        await clientApi(`/admin/users/${userId}/zillapass-stage`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        setMsg({ kind: "ok", text: "Saved." });
        router.refresh();
      } catch (e) {
        setMsg({
          kind: "err",
          text: e instanceof ApiFetchError ? e.message : "Save failed",
        });
      }
    });
  }

  function applyPreset(preset: "reset" | "advance-tomorrow") {
    if (preset === "reset") {
      setSetNumber("1");
      setStampDate("");
      return;
    }
    // advance-tomorrow — stamp = yesterday so /zillapass/me bumps
    // current_set_number on the user's next read.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    setStampDate(yesterday);
  }

  return (
    <form onSubmit={submit} className="space-y-4 text-sm">
      <p className="text-xs text-[var(--color-fg-muted)]">
        Debug-only override. Server applies normal advancement rules on
        the user's next /zillapass/me read — setting the stamp to{" "}
        <span className="font-mono">yesterday</span> is the cleanest way
        to push someone into the next set on their next open. Audit-
        logged.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
            Current set number
          </span>
          <input
            type="number"
            min={1}
            value={setNumber}
            onChange={(e) => setSetNumber(e.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
            Last set completed date (UTC, empty = none)
          </span>
          <input
            type="text"
            placeholder="YYYY-MM-DD or empty"
            value={stampDate}
            onChange={(e) => setStampDate(e.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-[var(--color-fg)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => applyPreset("reset")}
          disabled={pending}
          className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-60"
        >
          Reset to set 1
        </button>
        <button
          type="button"
          onClick={() => applyPreset("advance-tomorrow")}
          disabled={pending}
          className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-60"
        >
          Stamp yesterday (advances next read)
        </button>
      </div>

      {msg ? (
        <p
          className={
            msg.kind === "ok"
              ? "text-xs text-[var(--color-positive,#3a8a3a)]"
              : "text-xs text-[var(--color-negative,#c1342f)]"
          }
        >
          {msg.text}
        </p>
      ) : null}
    </form>
  );
}
