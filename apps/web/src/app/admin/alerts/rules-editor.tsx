"use client";

// Rules tab of the alert center. One row per rule: on/off, severity,
// the rule's numeric parameters (labels + bounds come from the API so
// the editor stays generic), active-alert count, last editor. Each row
// saves on its own through PUT /admin/riskzilla/alerts/rules/:kind.

import { useState, useTransition } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { SEVERITY_COLOR } from "@/components/admin/alerts-banner";

export interface AlertRuleDto {
  kind: string;
  label: string;
  description: string;
  seeded: boolean;
  enabled: boolean;
  severity: "critical" | "serious" | "warning";
  params: Record<string, number>;
  defaultParams: Record<string, number>;
  paramMeta: Record<string, { label: string; min: number; max: number; unit?: string }>;
  activeCount: number;
  updatedAt: string | null;
  updatedByEmail: string | null;
}

const SEVERITIES = ["critical", "serious", "warning"] as const;

export function RulesEditor({
  rules,
  onSaved,
}: {
  rules: AlertRuleDto[];
  onSaved: (rule: AlertRuleDto) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-[var(--color-fg-muted)]">
        Money thresholds are USDC; the demo OZ currency never raises money
        alerts. A change applies from the next sweep. Use &quot;Run sweep
        now&quot; above to see the effect immediately.
      </p>
      {rules.map((r) => (
        <RuleRow key={r.kind} rule={r} onSaved={onSaved} />
      ))}
    </div>
  );
}

function RuleRow({
  rule,
  onSaved,
}: {
  rule: AlertRuleDto;
  onSaved: (rule: AlertRuleDto) => void;
}) {
  const [enabled, setEnabled] = useState(rule.enabled);
  const [severity, setSeverity] = useState(rule.severity);
  const [params, setParams] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(rule.params).map(([k, v]) => [k, String(v)])),
  );
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const parsed: Record<string, number> = {};
  let invalid: string | null = null;
  for (const [k, meta] of Object.entries(rule.paramMeta)) {
    const n = Number(params[k]);
    if (!Number.isFinite(n)) invalid = `${meta.label}: enter a number`;
    else if (n < meta.min || n > meta.max) invalid = `${meta.label}: ${meta.min} to ${meta.max}`;
    parsed[k] = n;
  }
  const dirty =
    enabled !== rule.enabled ||
    severity !== rule.severity ||
    Object.entries(parsed).some(([k, v]) => v !== rule.params[k]);

  function save() {
    if (invalid) return;
    setMsg(null);
    startTransition(async () => {
      try {
        const res = await clientApi<{ enabled: boolean; severity: AlertRuleDto["severity"]; params: Record<string, number> }>(
          `/admin/riskzilla/alerts/rules/${rule.kind}`,
          { method: "PUT", body: JSON.stringify({ enabled, severity, params: parsed }) },
        );
        onSaved({ ...rule, enabled: res.enabled, severity: res.severity, params: res.params, seeded: true });
        setMsg({ kind: "ok", text: "Saved" });
        setTimeout(() => setMsg(null), 1500);
      } catch (e) {
        setMsg({ kind: "err", text: e instanceof ApiFetchError ? e.body.message : "Save failed" });
      }
    });
  }

  const color = SEVERITY_COLOR[severity] ?? "var(--color-fg)";

  return (
    <div
      className="card p-4"
      style={{ opacity: enabled ? 1 : 0.7, borderLeft: `3px solid ${enabled ? color : "var(--color-border)"}` }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              {rule.label}
            </label>
            <code className="text-[11px] text-[var(--color-fg-subtle)]">{rule.kind}</code>
            {rule.activeCount > 0 ? (
              <span className="mono rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.1em]" style={{ borderColor: color, color }}>
                {rule.activeCount} active
              </span>
            ) : null}
            {!rule.seeded ? (
              <span className="text-[11px] text-[var(--color-negative)]">not seeded in DB</span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{rule.description}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">Severity</span>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as AlertRuleDto["severity"])}
              className="h-8 rounded-[6px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-2 text-sm"
              style={{ color }}
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {Object.entries(rule.paramMeta).map(([k, meta]) => (
            <label key={k} className="flex flex-col gap-1 text-xs">
              <span className="uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                {meta.label}
                {meta.unit ? <span className="ml-1 normal-case tracking-normal">({meta.unit})</span> : null}
              </span>
              <input
                type="number"
                value={params[k] ?? ""}
                min={meta.min}
                max={meta.max}
                onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))}
                className="h-8 w-28 rounded-[6px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-2 font-mono text-sm"
              />
            </label>
          ))}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || pending || !!invalid}
            className={
              "h-8 rounded-[6px] border px-3 text-xs uppercase tracking-[0.12em] disabled:opacity-50 " +
              (dirty
                ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                : "border-[var(--color-border)] text-[var(--color-fg-subtle)]")
            }
          >
            {pending ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-[var(--color-fg-subtle)]">
        {invalid ? <span className="text-[var(--color-negative)]">{invalid}</span> : null}
        {msg ? (
          <span className={msg.kind === "ok" ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]"}>
            {msg.text}
          </span>
        ) : null}
        {rule.updatedAt ? (
          <span>
            updated {new Date(rule.updatedAt).toLocaleString()}
            {rule.updatedByEmail ? ` by ${rule.updatedByEmail}` : ""}
          </span>
        ) : null}
        <span>
          defaults:{" "}
          {Object.entries(rule.defaultParams)
            .map(([k, v]) => `${rule.paramMeta[k]?.label ?? k} ${v}`)
            .join(" · ") || "none"}
        </span>
      </div>
    </div>
  );
}
