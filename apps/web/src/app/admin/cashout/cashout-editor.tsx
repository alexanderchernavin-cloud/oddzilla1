"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import type { CashoutLadderStep } from "@oddzilla/types";

export type Scope = "global" | "sport" | "tournament" | "market_type";

export interface CashoutConfigEntry {
  id: number;
  scope: Scope;
  scopeRefId: string | null;
  enabled: boolean;
  prematchFullPaybackSeconds: number;
  deductionLadderJson: CashoutLadderStep[] | null;
  minOfferMicro: string;
  minValueChangeBp: number;
  acceptanceDelaySeconds: number;
  updatedAt: string;
  updatedBy: string | null;
  label: string;
}

export interface CashoutOptions {
  sports: Array<{ id: number; slug: string; name: string }>;
  tournaments: Array<{ id: number; name: string }>;
}

function microToUsdt(s: string): string {
  const n = BigInt(s);
  return (Number(n) / 1_000_000).toFixed(2);
}
function usdtToMicro(usdt: string): string {
  const n = Number(usdt);
  if (!Number.isFinite(n) || n < 0) return "-1";
  return Math.round(n * 1_000_000).toString();
}

export function CashoutEditor({
  initialEntries,
  options,
}: {
  initialEntries: CashoutConfigEntry[];
  options: CashoutOptions;
}) {
  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-[2fr_1fr]">
      <ConfigTable entries={initialEntries} />
      <UpsertForm options={options} />
    </div>
  );
}

function ConfigTable({ entries }: { entries: CashoutConfigEntry[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function toggleEnabled(entry: CashoutConfigEntry) {
    setErr(null);
    startTransition(async () => {
      try {
        await clientApi("/admin/cashout-config", {
          method: "PUT",
          body: JSON.stringify({
            scope: entry.scope,
            scopeRefId: entry.scopeRefId,
            enabled: !entry.enabled,
            prematchFullPaybackSeconds: entry.prematchFullPaybackSeconds,
            deductionLadder: entry.deductionLadderJson,
            minOfferMicro: entry.minOfferMicro,
            minValueChangeBp: entry.minValueChangeBp,
            acceptanceDelaySeconds: entry.acceptanceDelaySeconds,
          }),
        });
        router.refresh();
      } catch (e) {
        setErr(e instanceof ApiFetchError ? e.body.message : "Update failed.");
      }
    });
  }

  function del(id: number) {
    setErr(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/cashout-config/${id}`, { method: "DELETE" });
        router.refresh();
      } catch (e) {
        setErr(e instanceof ApiFetchError ? e.body.message : "Delete failed.");
      }
    });
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">
        No cashout config rows. The default global row is missing — re-run
        migration 0014.
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
            <th className="px-5 py-3 text-left">Enabled</th>
            <th className="px-5 py-3 text-right">Prematch full-stake</th>
            <th className="px-5 py-3 text-right">Accept delay</th>
            <th className="px-5 py-3 text-right">Min offer</th>
            <th className="px-5 py-3 text-right">Change gate</th>
            <th className="px-5 py-3 text-right">Ladder</th>
            <th className="px-5 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="px-5 py-3">{e.label}</td>
              <td className="px-5 py-3">
                <button
                  type="button"
                  onClick={() => toggleEnabled(e)}
                  disabled={pending}
                  className={
                    "rounded-full px-2 py-0.5 text-xs uppercase tracking-[0.15em] " +
                    (e.enabled
                      ? "bg-[var(--color-positive)]/15 text-[var(--color-positive)]"
                      : "bg-[var(--color-fg-subtle)]/15 text-[var(--color-fg-subtle)]")
                  }
                >
                  {e.enabled ? "On" : "Off"}
                </button>
              </td>
              <td className="px-5 py-3 text-right font-mono">
                {e.prematchFullPaybackSeconds}s
              </td>
              <td className="px-5 py-3 text-right font-mono">
                {e.acceptanceDelaySeconds}s
              </td>
              <td className="px-5 py-3 text-right font-mono">
                {microToUsdt(e.minOfferMicro)} USDT
              </td>
              <td className="px-5 py-3 text-right font-mono">
                {(e.minValueChangeBp / 100).toFixed(2)}%
              </td>
              <td className="px-5 py-3 text-right text-[var(--color-fg-muted)]">
                {e.deductionLadderJson && e.deductionLadderJson.length > 0
                  ? `${e.deductionLadderJson.length} steps`
                  : "—"}
              </td>
              <td className="px-5 py-3 text-right">
                {e.scope === "global" ? null : (
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

function UpsertForm({ options }: { options: CashoutOptions }) {
  const router = useRouter();
  const [scope, setScope] = useState<Scope>("global");
  const [refId, setRefId] = useState<string>("");
  const [enabled, setEnabled] = useState(true);
  const [prematchSec, setPrematchSec] = useState("60");
  const [acceptDelaySec, setAcceptDelaySec] = useState("5");
  const [minOfferUsdt, setMinOfferUsdt] = useState("0.10");
  const [minChangePct, setMinChangePct] = useState("0.00");
  const [ladderText, setLadderText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMsg(null);

    if (scope !== "global" && !refId) {
      setMsg({ kind: "err", text: "Pick a target for this scope." });
      return;
    }
    const sec = Number.parseInt(prematchSec, 10);
    if (!Number.isFinite(sec) || sec < 0 || sec > 86400) {
      setMsg({ kind: "err", text: "Prematch seconds must be 0–86400." });
      return;
    }
    const acceptSec = Number.parseInt(acceptDelaySec, 10);
    if (!Number.isFinite(acceptSec) || acceptSec < 0 || acceptSec > 60) {
      setMsg({ kind: "err", text: "Accept delay must be 0–60 seconds." });
      return;
    }
    const minMicro = usdtToMicro(minOfferUsdt);
    if (minMicro === "-1") {
      setMsg({ kind: "err", text: "Min offer must be a non-negative number." });
      return;
    }
    const changeBp = Math.round(Number(minChangePct) * 100);
    if (!Number.isFinite(changeBp) || changeBp < 0 || changeBp > 10000) {
      setMsg({ kind: "err", text: "Change gate must be 0–100%." });
      return;
    }

    let ladder: CashoutLadderStep[] | null = null;
    if (ladderText.trim() !== "") {
      try {
        const parsed = JSON.parse(ladderText) as CashoutLadderStep[];
        if (
          !Array.isArray(parsed) ||
          parsed.some(
            (s) =>
              typeof s.factor !== "number" || typeof s.deduction !== "number",
          )
        ) {
          throw new Error("ladder must be array of {factor, deduction}");
        }
        ladder = parsed;
      } catch (err) {
        setMsg({
          kind: "err",
          text: `Ladder JSON invalid: ${(err as Error).message}`,
        });
        return;
      }
    }

    setBusy(true);
    try {
      await clientApi("/admin/cashout-config", {
        method: "PUT",
        body: JSON.stringify({
          scope,
          scopeRefId: scope === "global" ? null : refId,
          enabled,
          prematchFullPaybackSeconds: sec,
          deductionLadder: ladder,
          minOfferMicro: minMicro,
          minValueChangeBp: changeBp,
          acceptanceDelaySeconds: acceptSec,
        }),
      });
      setMsg({ kind: "ok", text: "Saved." });
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
        Add / update cashout config
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
            Provider market ID
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

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm">Enabled</span>
      </label>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">
          Prematch full-stake window (seconds; 0 = off)
        </span>
        <input
          type="number"
          min={0}
          max={86400}
          value={prematchSec}
          onChange={(e) => setPrematchSec(e.target.value)}
          className="mt-1 w-32 rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">
          Acceptance delay (seconds; 0 = no delay, 5 = default)
        </span>
        <input
          type="number"
          min={0}
          max={60}
          value={acceptDelaySec}
          onChange={(e) => setAcceptDelaySec(e.target.value)}
          className="mt-1 w-32 rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">
          Minimum offer (USDT)
        </span>
        <input
          type="number"
          min={0}
          step={0.01}
          value={minOfferUsdt}
          onChange={(e) => setMinOfferUsdt(e.target.value)}
          className="mt-1 w-32 rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">
          Min value change to offer (%; 0 = always)
        </span>
        <input
          type="number"
          min={0}
          max={100}
          step={0.01}
          value={minChangePct}
          onChange={(e) => setMinChangePct(e.target.value)}
          className="mt-1 w-32 rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">
          Deduction ladder (JSON array; leave empty for pure simple cashout)
        </span>
        <textarea
          value={ladderText}
          onChange={(e) => setLadderText(e.target.value)}
          rows={5}
          placeholder='[{"factor":0.5,"deduction":1.025},{"factor":1,"deduction":1.005}]'
          className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
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
        {busy ? "Saving…" : "Save config"}
      </button>
    </form>
  );
}
