"use client";

// Shared editor for the two match-page insight widgets. ZillaTips and
// ZillaFacts carry exactly the same settings, so they share one component
// and differ only by the `widget` key in the route.
//
// The cascade is most-specific-wins: market > tournament > category >
// sport > everywhere. The page states that in words above the table,
// because a list of rules with no stated precedence is a list of rules
// nobody can predict.

import { useCallback, useEffect, useState } from "react";
import { clientApi } from "@/lib/api-client";

export type InsightScope = "global" | "sport" | "category" | "tournament" | "market";

export interface InsightRuleDto {
  scope: InsightScope;
  refId: string;
  label: string;
  sublabel: string | null;
  enabled: boolean;
  updatedAt: string;
}

export interface InsightConfigDto {
  widget: "zillatips" | "zillafacts";
  fullyDisabled: boolean;
  globalEnabled: boolean;
  rules: InsightRuleDto[];
}

interface Option {
  id: number;
  name: string;
  categoryName?: string;
  markets?: number;
}

const SCOPE_LABEL: Record<InsightScope, string> = {
  global: "Everywhere",
  sport: "Sport",
  category: "Category",
  tournament: "Tournament",
  market: "Market type",
};

// Narrower first — this is the order the resolver walks, and showing it
// any other way would misrepresent which rule wins.
const ADD_SCOPES: InsightScope[] = ["market", "tournament", "category", "sport"];

export function InsightWidgetEditor({ initial }: { initial: InsightConfigDto }) {
  const [config, setConfig] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [addScope, setAddScope] = useState<InsightScope>("sport");
  const [sportId, setSportId] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [sportOptions, setSportOptions] = useState<Option[]>([]);
  const [refOptions, setRefOptions] = useState<Option[]>([]);
  const [refId, setRefId] = useState<string>("");

  const widget = config.widget;

  const mutate = useCallback(
    async (fn: () => Promise<InsightConfigDto>) => {
      setBusy(true);
      setError(null);
      try {
        setConfig(await fn());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const setRule = (scope: InsightScope, ref: string, enabled: boolean) =>
    mutate(() =>
      clientApi<InsightConfigDto>(`/admin/insight-widgets/${widget}/rules/${scope}/${ref}`, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }),
    );

  const clearRule = (scope: InsightScope, ref: string) =>
    mutate(() =>
      clientApi<InsightConfigDto>(`/admin/insight-widgets/${widget}/rules/${scope}/${ref}`, {
        method: "DELETE",
      }),
    );

  // Sports drive every other picker, so they load once.
  useEffect(() => {
    clientApi<{ sports: Option[] }>("/admin/insight-widgets/options/sports")
      .then((r: { sports: Option[] }) => setSportOptions(r.sports))
      .catch(() => setSportOptions([]));
  }, []);

  // Refs for the chosen scope. Categories and tournaments are scoped
  // downward on purpose — football alone has ~200 country buckets.
  useEffect(() => {
    setRefId("");
    if (addScope === "sport") {
      setRefOptions(sportOptions);
      return;
    }
    if (addScope === "category") {
      if (sportId == null) return setRefOptions([]);
      clientApi<{ categories: Option[] }>(
        `/admin/insight-widgets/options/categories?sportId=${sportId}`,
      )
        .then((r: { categories: Option[] }) => setRefOptions(r.categories))
        .catch(() => setRefOptions([]));
      return;
    }
    if (addScope === "tournament") {
      const qs =
        categoryId != null
          ? `categoryId=${categoryId}`
          : sportId != null
            ? `sportId=${sportId}`
            : null;
      if (!qs) return setRefOptions([]);
      clientApi<{ tournaments: Option[] }>(`/admin/insight-widgets/options/tournaments?${qs}`)
        .then((r: { tournaments: Option[] }) => setRefOptions(r.tournaments))
        .catch(() => setRefOptions([]));
      return;
    }
    if (addScope === "market") {
      const qs = sportId != null ? `?sportId=${sportId}` : "";
      clientApi<{ markets: Option[] }>(`/admin/insight-widgets/options/markets${qs}`)
        .then((r: { markets: Option[] }) => setRefOptions(r.markets))
        .catch(() => setRefOptions([]));
    }
  }, [addScope, sportId, categoryId, sportOptions]);

  const globalRule = config.rules.find((r) => r.scope === "global");
  const overrides = config.rules.filter((r) => r.scope !== "global");

  return (
    <div className="mt-6">
      {config.fullyDisabled ? (
        <div
          role="status"
          className="mb-6 rounded border border-red-500/50 bg-red-500/10 px-4 py-3"
        >
          <p className="text-sm font-semibold text-red-500">
            This feature is currently disabled.
          </p>
          <p className="mt-1 text-xs text-red-500/80">
            It is off everywhere — nothing renders on the storefront and the
            historical query does not run. Turn it on below, or switch it on
            for a single sport, category, tournament or market type.
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="mb-4 text-sm text-red-500">{error}</p>
      ) : null}

      <section className="rounded border border-[var(--color-border)] p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Everywhere</h2>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
              The cascade&apos;s floor. Every scope below inherits this unless it
              carries its own rule.
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => setRule("global", "global", !config.globalEnabled)}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm"
          >
            {config.globalEnabled ? "On — turn off" : "Off — turn on"}
          </button>
        </div>
        {globalRule ? (
          <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
            Last changed {new Date(globalRule.updatedAt).toLocaleString()}
          </p>
        ) : null}
      </section>

      <section className="mt-6 rounded border border-[var(--color-border)] p-4">
        <h2 className="text-sm font-semibold">Add an override</h2>
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
          Most specific wins: market type beats tournament, which beats
          category, which beats sport, which beats everywhere.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            value={addScope}
            onChange={(e) => setAddScope(e.target.value as InsightScope)}
            className="rounded border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm"
          >
            {ADD_SCOPES.map((s) => (
              <option key={s} value={s}>
                {SCOPE_LABEL[s]}
              </option>
            ))}
          </select>

          {addScope !== "sport" ? (
            <select
              value={sportId ?? ""}
              onChange={(e) => {
                setSportId(e.target.value ? Number(e.target.value) : null);
                setCategoryId(null);
              }}
              className="rounded border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm"
            >
              <option value="">
                {addScope === "market" ? "All sports" : "Pick a sport…"}
              </option>
              {sportOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : null}

          <select
            value={refId}
            onChange={(e) => setRefId(e.target.value)}
            className="min-w-[16rem] rounded border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm"
          >
            <option value="">Pick a {SCOPE_LABEL[addScope].toLowerCase()}…</option>
            {refOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.categoryName ? ` — ${o.categoryName}` : ""}
                {o.markets ? ` (${o.markets} live)` : ""}
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={busy || !refId}
            onClick={() => setRule(addScope, refId, true)}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Add as On
          </button>
          <button
            type="button"
            disabled={busy || !refId}
            onClick={() => setRule(addScope, refId, false)}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Add as Off
          </button>
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-semibold">Overrides ({overrides.length})</h2>
        {overrides.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
            None — every scope follows the setting above.
          </p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-xs uppercase text-[var(--color-fg-muted)]">
              <tr>
                <th className="py-2">Scope</th>
                <th className="py-2">What</th>
                <th className="py-2">State</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {overrides.map((r) => (
                <tr key={`${r.scope}:${r.refId}`} className="border-t border-[var(--color-border)]">
                  <td className="py-2 text-xs uppercase text-[var(--color-fg-muted)]">
                    {SCOPE_LABEL[r.scope]}
                  </td>
                  <td className="py-2">
                    {r.label}
                    {r.sublabel ? (
                      <span className="ml-2 text-xs text-[var(--color-fg-muted)]">
                        {r.sublabel}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2">
                    <span className={r.enabled ? "text-green-500" : "text-red-500"}>
                      {r.enabled ? "On" : "Off"}
                    </span>
                  </td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setRule(r.scope, r.refId, !r.enabled)}
                      className="mr-2 rounded border border-[var(--color-border)] px-2 py-1 text-xs"
                    >
                      Flip
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => clearRule(r.scope, r.refId)}
                      className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
                    >
                      Clear
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
