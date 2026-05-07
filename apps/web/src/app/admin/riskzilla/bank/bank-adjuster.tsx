"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { fromMicro, toMicro } from "@oddzilla/types/money";

export interface BankStateDto {
  bankLimitMicro: string;
  openLiabilityMicro: string;
  userBalancesMicro: string;
  freeCapacityMicro: string;
  updatedAt: string;
  updatedBy: string | null;
}

export function BankAdjuster({ initial: _initial }: { initial: BankStateDto }) {
  const router = useRouter();
  const [mode, setMode] = useState<"set" | "delta">("delta");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!memo.trim()) {
      setError("Memo is required for audit purposes");
      return;
    }
    let micro: bigint;
    try {
      micro = BigInt(toMicro(amount));
    } catch {
      setError("Invalid amount");
      return;
    }
    const body: Record<string, string> = { memo: memo.trim() };
    if (mode === "set") body.setMicro = micro.toString();
    else body.deltaMicro = (mode === "delta" ? micro : micro).toString();
    startTransition(async () => {
      try {
        const next = await clientApi<BankStateDto>("/admin/riskzilla/bank/limit", {
          method: "PUT",
          body: JSON.stringify(body),
        });
        setInfo(`Bank limit now ${fromMicro(BigInt(next.bankLimitMicro))} USDC`);
        setAmount("");
        setMemo("");
        router.refresh();
      } catch (err) {
        if (err instanceof ApiFetchError) {
          setError(
            err.message === "bank_admin_only"
              ? "This action is reserved for the bank admin (q1qooo@gmail.com)."
              : err.message,
          );
        } else {
          setError("Save failed");
        }
      }
    });
  };

  const recompute = () => {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      try {
        await clientApi<BankStateDto>("/admin/riskzilla/bank/recompute", {
          method: "POST",
        });
        setInfo("Open liability recomputed from open tickets.");
        router.refresh();
      } catch (err) {
        if (err instanceof ApiFetchError) {
          setError(
            err.message === "bank_admin_only"
              ? "This action is reserved for the bank admin (q1qooo@gmail.com)."
              : err.message,
          );
        } else {
          setError("Recompute failed");
        }
      }
    });
  };

  return (
    <section
      style={{
        background: "var(--color-bg-subtle)",
        border: "1px solid var(--color-border)",
        borderRadius: 10,
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <h2
        className="mono"
        style={{
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--color-fg-subtle)",
          margin: 0,
        }}
      >
        Bank admin
      </h2>
      <p style={{ fontSize: 12.5, color: "var(--color-fg-muted)", margin: 0 }}>
        Restricted to <code>q1qooo@gmail.com</code>. Other admins will see a
        403 and the form below will not submit.
      </p>
      <form
        onSubmit={submit}
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr 1fr auto",
          gap: 8,
          alignItems: "center",
        }}
      >
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as "set" | "delta")}
          style={{
            height: 36,
            padding: "0 8px",
            border: "1px solid var(--color-border)",
            background: "var(--color-bg)",
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          <option value="delta">Delta (+/−)</option>
          <option value="set">Set absolute</option>
        </select>
        <input
          type="text"
          inputMode="decimal"
          placeholder={mode === "set" ? "100000.00" : "+/-1000.00"}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          style={{
            height: 36,
            padding: "0 10px",
            border: "1px solid var(--color-border)",
            background: "var(--color-bg)",
            borderRadius: 6,
            fontFamily: "var(--font-mono, monospace)",
            fontVariantNumeric: "tabular-nums",
            fontSize: 13,
          }}
        />
        <input
          type="text"
          placeholder="Memo (required)"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          required
          maxLength={500}
          style={{
            height: 36,
            padding: "0 10px",
            border: "1px solid var(--color-border)",
            background: "var(--color-bg)",
            borderRadius: 6,
            fontSize: 13,
          }}
        />
        <button
          type="submit"
          disabled={pending}
          style={{
            height: 36,
            padding: "0 16px",
            background: "var(--accent, #16a34a)",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: pending ? "default" : "pointer",
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? "Saving…" : "Apply"}
        </button>
      </form>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={recompute}
          disabled={pending}
          style={{
            height: 32,
            padding: "0 12px",
            background: "transparent",
            border: "1px solid var(--color-border)",
            color: "var(--color-fg)",
            borderRadius: 6,
            fontSize: 12,
            cursor: pending ? "default" : "pointer",
          }}
        >
          Recompute open liability
        </button>
        <span style={{ fontSize: 11, color: "var(--color-fg-muted)", alignSelf: "center" }}>
          Walks open tickets and resets the running counter from scratch.
        </span>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            fontSize: 12.5,
            color: "#dc2626",
            background: "color-mix(in oklab, #dc2626 8%, transparent)",
            padding: "8px 12px",
            borderRadius: 8,
          }}
        >
          {error}
        </div>
      )}
      {info && (
        <div
          style={{
            fontSize: 12.5,
            color: "var(--accent, #16a34a)",
            background: "color-mix(in oklab, #16a34a 8%, transparent)",
            padding: "8px 12px",
            borderRadius: 8,
          }}
        >
          {info}
        </div>
      )}
    </section>
  );
}
