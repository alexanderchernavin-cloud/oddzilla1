"use client";

// Client half of /admin/unsettled/denylist: the rule table with per-rule
// open-market drill-down, and the add form.

import { useCallback, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface DenylistRule {
  id: number;
  kind: "table" | "label_prefix";
  tableNum: number | null;
  labelPrefix: string | null;
  reason: string;
  createdAt: string;
  openMarkets: number;
  openMatches: number;
}

interface RuleMarket {
  marketId: string;
  matchId: string;
  // This MARKET's own provider_market_id, not the rule's table number.
  providerMarketId: number;
  marketStatus: number;
  specifiers: string | null;
  marketName: string | null;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string;
  matchStatus: string;
  sportSlug: string;
  tournamentName: string;
  openTickets: number;
}

const MARKET_STATUS: Record<number, string> = {
  1: "active",
  0: "inactive",
  [-1]: "suspended",
  [-2]: "handover",
};

export function DenylistEditor({
  initialRules,
  scanDays,
}: {
  initialRules: DenylistRule[];
  scanDays: number;
}) {
  return (
    <div className="mt-6 space-y-6">
      <AddRuleForm />
      <div className="overflow-x-auto rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
            <tr>
              <Th>Rule</Th>
              <Th>Reason</Th>
              <Th className="text-right">Open markets ({scanDays} d)</Th>
              <Th className="text-right">Matches</Th>
              <Th>Added</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {initialRules.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-sm text-[var(--color-fg-muted)]">
                  No rules. Every Fonbet table is offered.
                </td>
              </tr>
            ) : (
              initialRules.map((r) => <RuleRow key={r.id} rule={r} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddRuleForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<"table" | "label_prefix">("table");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body: Record<string, unknown> = { kind, reason };
    if (kind === "table") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        setError("A table rule needs the Fonbet catalogue table number, e.g. 7800.");
        return;
      }
      body.tableNum = n;
    } else {
      if (value.trim().length < 2) {
        setError("A label prefix needs at least two characters.");
        return;
      }
      body.labelPrefix = value.trim();
    }
    startTransition(async () => {
      try {
        await clientApi("/admin/unsettled/denylist", {
          method: "POST",
          body: JSON.stringify(body),
        });
        setValue("");
        setReason("");
        router.refresh();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.body.message : "Could not add the rule.");
      }
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] px-4 py-3"
    >
      <label className="text-xs">
        <div className="mb-1 uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">Kind</div>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as "table" | "label_prefix")}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
        >
          <option value="table">Catalogue table (Fonbet table number)</option>
          <option value="label_prefix">Sub-event label prefix</option>
        </select>
      </label>
      <label className="text-xs">
        <div className="mb-1 uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
          {kind === "table" ? "Provider market id" : "Label prefix"}
        </div>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={kind === "table" ? "7800" : "Player specials"}
          className="w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-sm"
        />
      </label>
      <label className="flex-1 text-xs">
        <div className="mb-1 uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">Reason</div>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="why no grader can settle this shape"
          className="w-full min-w-[16rem] rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-full border border-[var(--color-fg)] px-4 py-1.5 text-sm font-medium disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add rule"}
      </button>
      {error ? (
        <div className="basis-full text-xs text-[var(--color-danger,#b4443c)]">{error}</div>
      ) : null}
    </form>
  );
}

function RuleRow({ rule }: { rule: DenylistRule }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<RuleMarket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await clientApi<{ markets: RuleMarket[] }>(
        `/admin/unsettled/denylist/${rule.id}/markets`,
      );
      setRows(res.markets);
    } catch {
      setError("Could not load the markets under this rule.");
    }
  }, [rule.id]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && rows === null) void load();
  }

  function remove() {
    if (!window.confirm("Remove this rule? The ingester will offer the shape again within a minute.")) return;
    startTransition(async () => {
      try {
        await clientApi(`/admin/unsettled/denylist/${rule.id}`, { method: "DELETE" });
        router.refresh();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.body.message : "Could not remove the rule.");
      }
    });
  }

  return (
    <>
      <tr className="align-top">
        <Td>
          {rule.kind === "table" ? (
            <div>
              <span className="text-[11px] uppercase tracking-[0.1em] text-[var(--color-fg-subtle)]">table</span>{" "}
              <span className="font-mono">table {rule.tableNum}</span>
            </div>
          ) : (
            <div>
              <span className="text-[11px] uppercase tracking-[0.1em] text-[var(--color-fg-subtle)]">label prefix</span>{" "}
              <span className="font-mono">&quot;{rule.labelPrefix}&quot;</span>
            </div>
          )}
        </Td>
        <Td className="max-w-md text-[var(--color-fg-muted)]">{rule.reason || "—"}</Td>
        <Td className="text-right font-mono">{rule.openMarkets.toLocaleString()}</Td>
        <Td className="text-right font-mono">{rule.openMatches.toLocaleString()}</Td>
        <Td className="whitespace-nowrap text-[var(--color-fg-muted)]">
          {new Date(rule.createdAt).toLocaleDateString()}
        </Td>
        <Td className="whitespace-nowrap text-right">
          <button
            type="button"
            onClick={toggle}
            className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            aria-expanded={open}
          >
            {open ? "Hide" : "Markets"}
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            className="ml-2 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-danger,#b4443c)] disabled:opacity-50"
          >
            Remove
          </button>
        </Td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={6} className="bg-[var(--color-bg)] px-4 py-3">
            {error ? (
              <p className="text-xs text-[var(--color-danger,#b4443c)]">{error}</p>
            ) : rows === null ? (
              <p className="text-xs text-[var(--color-fg-muted)]">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="text-xs text-[var(--color-fg-muted)]">
                No open market under this rule on a finished match.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-fg-subtle)]">
                    <tr>
                      <th className="py-1 pr-4 font-medium">Match</th>
                      <th className="py-1 pr-4 font-medium">Market</th>
                      <th className="py-1 pr-4 font-medium">Specifiers</th>
                      <th className="py-1 pr-4 font-medium">Status</th>
                      <th className="py-1 text-right font-medium">Tickets</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {rows.map((r) => (
                      <tr key={r.marketId}>
                        <td className="py-1.5 pr-4">
                          {r.homeTeam} <span className="text-[var(--color-fg-subtle)]">vs</span> {r.awayTeam}
                          <div className="text-[10px] text-[var(--color-fg-subtle)]">
                            {r.sportSlug} · {r.tournamentName} · {new Date(r.scheduledAt).toLocaleString()} · match {r.matchId}
                          </div>
                        </td>
                        <td className="py-1.5 pr-4">
                          {r.marketName?.trim() ? r.marketName : `Market #${r.providerMarketId}`}
                          <span className="ml-2 font-mono text-[10px] text-[var(--color-fg-subtle)]">id {r.marketId}</span>
                        </td>
                        <td className="py-1.5 pr-4 font-mono text-[10px] text-[var(--color-fg-muted)]">
                          {r.specifiers && r.specifiers !== "{}" ? r.specifiers : "—"}
                        </td>
                        <td className="py-1.5 pr-4">{MARKET_STATUS[r.marketStatus] ?? r.marketStatus}</td>
                        <td
                          className={`py-1.5 text-right font-mono ${
                            r.openTickets > 0 ? "text-[var(--color-danger,#b4443c)]" : ""
                          }`}
                        >
                          {r.openTickets}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length === 200 ? (
                  <p className="mt-2 text-[10px] text-[var(--color-fg-subtle)]">Showing the first 200.</p>
                ) : null}
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2 font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 ${className}`}>{children}</td>;
}
