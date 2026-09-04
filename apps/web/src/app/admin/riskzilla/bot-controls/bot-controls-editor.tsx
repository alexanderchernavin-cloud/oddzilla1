"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface BotControlsDto {
  intentRequired: boolean;
  intentTtlSeconds: number;
  minHumanMs: number;
  velocityEnabled: boolean;
  maxBetsPerMinute: number;
  maxMatchesPerMinute: number;
  behaviourAlertThreshold: number;
  behaviourMinSessions: number;
  updatedAt: string;
  updatedBy: string | null;
}

type Draft = {
  intentRequired: boolean;
  intentTtlSeconds: string;
  minHumanMs: string;
  velocityEnabled: boolean;
  maxBetsPerMinute: string;
  maxMatchesPerMinute: string;
  behaviourAlertThreshold: string;
  behaviourMinSessions: string;
};

function toDraft(c: BotControlsDto): Draft {
  return {
    intentRequired: c.intentRequired,
    intentTtlSeconds: String(c.intentTtlSeconds),
    minHumanMs: String(c.minHumanMs),
    velocityEnabled: c.velocityEnabled,
    maxBetsPerMinute: String(c.maxBetsPerMinute),
    maxMatchesPerMinute: String(c.maxMatchesPerMinute),
    behaviourAlertThreshold: String(Math.round(c.behaviourAlertThreshold * 100)),
    behaviourMinSessions: String(c.behaviourMinSessions),
  };
}

function intIn(v: string, min: number, max: number, label: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

export function BotControlsEditor({ initial }: { initial: BotControlsDto }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(initial));
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = () => {
    let payload: Omit<BotControlsDto, "updatedAt" | "updatedBy">;
    try {
      const thresholdPct = intIn(draft.behaviourAlertThreshold, 1, 100, "Alert threshold (%)");
      payload = {
        intentRequired: draft.intentRequired,
        intentTtlSeconds: intIn(draft.intentTtlSeconds, 15, 900, "Intent TTL (s)"),
        minHumanMs: intIn(draft.minHumanMs, 0, 10_000, "Minimum human time (ms)"),
        velocityEnabled: draft.velocityEnabled,
        maxBetsPerMinute: intIn(draft.maxBetsPerMinute, 1, 1000, "Bets per minute"),
        maxMatchesPerMinute: intIn(draft.maxMatchesPerMinute, 1, 1000, "Matches per minute"),
        behaviourAlertThreshold: thresholdPct / 100,
        behaviourMinSessions: intIn(draft.behaviourMinSessions, 1, 100, "Minimum sessions"),
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "invalid value");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await clientApi("/admin/riskzilla/bot-controls", {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        router.refresh();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.message : "save failed");
      }
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && (
        <div
          role="alert"
          style={{
            fontSize: 12.5,
            color: "#dc2626",
            background: "color-mix(in oklab, #dc2626 8%, transparent)",
            padding: "6px 10px",
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <Card title="Placement intent">
          <Toggle
            label="Require an intent token on POST /bets"
            checked={draft.intentRequired}
            onChange={(v) => set({ intentRequired: v })}
            hint="Emergency off-switch. When off, a token is still read for the confirm-time measurement but never rejected."
          />
          <Field
            label="Token TTL (seconds)"
            value={draft.intentTtlSeconds}
            onChange={(v) => set({ intentTtlSeconds: v })}
            hint="15 to 900. The slip re-quotes 15 s before expiry while it sits open."
          />
          <Field
            label="Minimum human time (ms)"
            value={draft.minHumanMs}
            onChange={(v) => set({ minHumanMs: v })}
            hint="Quote to place. 0 disables. A confirm faster than this rejects with intent_too_fast; the slip waits it out, so bettors never see it."
          />
        </Card>

        <Card title="Velocity caps">
          <Toggle
            label="Enforce per-account velocity caps"
            checked={draft.velocityEnabled}
            onChange={(v) => set({ velocityEnabled: v })}
            hint="Applies to every currency, OZ included."
          />
          <Field
            label="Bets per minute (at RS 1.000)"
            value={draft.maxBetsPerMinute}
            onChange={(v) => set({ maxBetsPerMinute: v })}
            hint="Effective cap = max(1, round(base x risk score)). RS 0.5 halves it, RS 2 doubles it."
          />
          <Field
            label="Distinct matches per minute (at RS 1.000)"
            value={draft.maxMatchesPerMinute}
            onChange={(v) => set({ maxMatchesPerMinute: v })}
            hint="Counts the union of matches touched in the trailing minute plus this bet's legs."
          />
        </Card>

        <Card title="Behaviour alerts">
          <Field
            label="Alert threshold (%)"
            value={draft.behaviourAlertThreshold}
            onChange={(v) => set({ behaviourAlertThreshold: v })}
            hint="Automation score at which a bettor is flagged. Alerts clear 10 points below (hysteresis)."
          />
          <Field
            label="Minimum scored sessions"
            value={draft.behaviourMinSessions}
            onChange={(v) => set({ behaviourMinSessions: v })}
            hint="A single odd session never raises an alert on its own."
          />
        </Card>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button
          type="button"
          disabled={!dirty || pending}
          onClick={save}
          style={{
            height: 36,
            padding: "0 16px",
            borderRadius: 6,
            border: "1px solid var(--color-border)",
            background: dirty ? "var(--accent, #16a34a)" : "var(--color-bg-subtle)",
            color: dirty ? "#fff" : "var(--color-fg-muted)",
            cursor: dirty && !pending ? "pointer" : "default",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {saved ? "Saved" : pending ? "Saving…" : "Save bot controls"}
        </button>
        <span style={{ fontSize: 11.5, color: "var(--color-fg-muted)" }}>
          Last updated {new Date(initial.updatedAt).toLocaleString()}. Every save is audit-logged.
        </span>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "var(--color-bg-subtle)",
        border: "1px solid var(--color-border)",
        borderRadius: 10,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--color-fg-subtle)",
        }}
      >
        {title}
      </span>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5 }}>
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          height: 32,
          padding: "0 8px",
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 6,
          color: "var(--color-fg)",
          fontFamily: "var(--font-mono, monospace)",
          fontVariantNumeric: "tabular-nums",
          fontSize: 13,
          maxWidth: 160,
        }}
      />
      {hint && <span style={{ fontSize: 11, color: "var(--color-fg-muted)" }}>{hint}</span>}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </span>
      {hint && <span style={{ fontSize: 11, color: "var(--color-fg-muted)" }}>{hint}</span>}
    </label>
  );
}
