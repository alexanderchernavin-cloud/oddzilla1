"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export type Scope = "global" | "sport" | "tournament" | "market_type";

export interface MarginEntry {
  id: number;
  scope: Scope;
  scopeRefId: string | null;
  paybackMarginBp: number;
  updatedAt: string;
  updatedBy: string | null;
  label: string;
}

export interface MarginOptions {
  sports: Array<{ id: number; slug: string; name: string }>;
  tournaments: Array<{ id: number; name: string }>;
}

// 100 bp = 1%.
function bpToPercent(bp: number): string {
  return (bp / 100).toFixed(2);
}
function percentToBp(pct: string): number {
  const n = Number(pct);
  if (Number.isNaN(n)) return -1;
  return Math.round(n * 100);
}

export function MarginsEditor({
  initialEntries,
  options,
}: {
  initialEntries: MarginEntry[];
  options: MarginOptions;
}) {
  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-[2fr_1fr]">
      <MarginTable entries={initialEntries} />
      <AddMarginForm options={options} />
    </div>
  );
}

function MarginTable({ entries }: { entries: MarginEntry[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function del(id: number) {
    setErr(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/odds-config/${id}`, { method: "DELETE" });
        router.refresh();
      } catch (e) {
        setErr(e instanceof ApiFetchError ? e.body.message : "Delete failed.");
      }
    });
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">
        No margins set — the publisher uses 0% (pass-through).
      </p>
    );
  }

  return (
    <div className="card overflow-hidden">
      {err ? (
        <p role="alert" className="px-5 py-3 text-sm text-[var(--color-negative)]">
          {err}
        </p>
      ) : null}
      <table className="w-full text-sm">
        <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          <tr>
            <th className="px-5 py-3 text-left">Scope</th>
            <th className="px-5 py-3 text-right">Margin</th>
            <th className="px-5 py-3 text-right">Updated</th>
            <th className="px-5 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="px-5 py-3">{e.label}</td>
              <td className="px-5 py-3 text-right font-mono">{bpToPercent(e.paybackMarginBp)}%</td>
              <td className="px-5 py-3 text-right text-[var(--color-fg-muted)]">
                {new Date(e.updatedAt).toLocaleString()}
              </td>
              <td className="px-5 py-3 text-right">
                {e.scope === "global" ? (
                  <span className="text-xs text-[var(--color-fg-subtle)]">required</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => del(e.id)}
                    disabled={pending}
                    className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-negative)] disabled:opacity-50"
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddMarginForm({ options }: { options: MarginOptions }) {
  const router = useRouter();
  const [scope, setScope] = useState<Scope>("sport");
  const [refId, setRefId] = useState<string>("");
  const [percent, setPercent] = useState<string>("5.00");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null);
    const bp = percentToBp(percent);
    if (bp < 0 || bp > 5000) {
      setMsg({ kind: "err", text: "Margin must be between 0% and 50%." });
      return;
    }
    if (scope !== "global" && !refId) {
      setMsg({ kind: "err", text: "Pick a target for this scope." });
      return;
    }
    setBusy(true);
    try {
      await clientApi("/admin/odds-config", {
        method: "PUT",
        body: JSON.stringify({
          scope,
          scopeRefId: scope === "global" ? null : refId,
          paybackMarginBp: bp,
        }),
      });
      setMsg({ kind: "ok", text: "Saved." });
      setPercent("5.00");
      setRefId("");
      router.refresh();
    } catch (err) {
      setMsg({
        kind: "err",
        text: err instanceof ApiFetchError ? err.body.message : "Save failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-4 p-6">
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Add / update margin
      </h2>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">Scope</span>
        <select
          value={scope}
          onChange={(e) => {
            setScope(e.target.value as Scope);
            setRefId("");
          }}
          className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        >
          <option value="global">Global (default)</option>
          <option value="sport">Sport</option>
          <option value="tournament">Tournament</option>
          <option value="market_type">Market type</option>
        </select>
      </label>

      {scope === "sport" ? (
        <label className="block">
          <span className="text-xs text-[var(--color-fg-subtle)]">Sport</span>
          <select
            value={refId}
            onChange={(e) => setRefId(e.target.value)}
            className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
          >
            <option value="">Choose…</option>
            {options.sports.map((s) => (
              <option key={s.id} value={s.id.toString()}>
                {s.name} ({s.slug})
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {scope === "tournament" ? (
        <label className="block">
          <span className="text-xs text-[var(--color-fg-subtle)]">Tournament</span>
          <select
            value={refId}
            onChange={(e) => setRefId(e.target.value)}
            className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
          >
            <option value="">Choose…</option>
            {options.tournaments.map((t) => (
              <option key={t.id} value={t.id.toString()}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {scope === "market_type" ? (
        <label className="block">
          <span className="text-xs text-[var(--color-fg-subtle)]">
            Provider market ID (1 = match winner, 4 = map winner)
          </span>
          <input
            type="number"
            min={1}
            value={refId}
            onChange={(e) => setRefId(e.target.value)}
            className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
          />
        </label>
      ) : null}

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">Margin (%)</span>
        <input
          type="number"
          min={0}
          max={50}
          step={0.01}
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
          className="mt-1 w-32 rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono outline-none focus:border-[var(--color-accent)]"
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

      <button type="submit" disabled={busy} className="btn btn-primary">
        {busy ? "Saving…" : "Save margin"}
      </button>
    </form>
  );
}
