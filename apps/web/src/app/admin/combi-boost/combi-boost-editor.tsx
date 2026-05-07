"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface TierDto {
  minLegs: number;
  multiplier: number;
  label: string;
}

export interface CombiBoostConfigDto {
  enabled: boolean;
  minOdds: number;
  tiers: TierDto[];
  updatedAt: string;
  updatedBy: string | null;
}

interface DraftTier {
  minLegs: string;
  multiplier: string;
}

interface Draft {
  enabled: boolean;
  minOdds: string;
  tiers: DraftTier[];
}

function toDraft(cfg: CombiBoostConfigDto): Draft {
  return {
    enabled: cfg.enabled,
    minOdds: cfg.minOdds.toFixed(2),
    tiers: cfg.tiers.map((t) => ({
      minLegs: String(t.minLegs),
      multiplier: t.multiplier.toFixed(2),
    })),
  };
}

function validate(draft: Draft): string | null {
  const min = Number.parseFloat(draft.minOdds);
  if (!Number.isFinite(min) || min < 1.01 || min > 10) {
    return "Min odds must be between 1.01 and 10.";
  }
  for (let i = 0; i < draft.tiers.length; i++) {
    const t = draft.tiers[i]!;
    const legs = Number.parseInt(t.minLegs, 10);
    const mul = Number.parseFloat(t.multiplier);
    if (!Number.isInteger(legs) || legs < 2 || legs > 30) {
      return `Tier ${i + 1}: min legs must be an integer between 2 and 30.`;
    }
    if (!Number.isFinite(mul) || mul <= 1.0 || mul > 5) {
      return `Tier ${i + 1}: multiplier must be greater than 1.00 and at most 5.00.`;
    }
  }
  for (let i = 1; i < draft.tiers.length; i++) {
    const prevLegs = Number.parseInt(draft.tiers[i - 1]!.minLegs, 10);
    const legs = Number.parseInt(draft.tiers[i]!.minLegs, 10);
    if (legs <= prevLegs) {
      return `Tier ${i + 1}: min legs must be strictly greater than tier ${i}.`;
    }
    const prevMul = Number.parseFloat(draft.tiers[i - 1]!.multiplier);
    const mul = Number.parseFloat(draft.tiers[i]!.multiplier);
    if (mul <= prevMul) {
      return `Tier ${i + 1}: multiplier must be strictly greater than tier ${i}.`;
    }
  }
  return null;
}

export function CombiBoostEditor({ initial }: { initial: CombiBoostConfigDto }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [savedAt, setSavedAt] = useState<string>(initial.updatedAt);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty =
    draft.enabled !== initial.enabled ||
    draft.minOdds !== initial.minOdds.toFixed(2) ||
    draft.tiers.some((t, i) => {
      const o = initial.tiers[i]!;
      return (
        Number.parseInt(t.minLegs, 10) !== o.minLegs ||
        Number.parseFloat(t.multiplier) !== o.multiplier
      );
    });

  const updateTier = (i: number, patch: Partial<DraftTier>) => {
    setDraft((prev) => ({
      ...prev,
      tiers: prev.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)),
    }));
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const validationError = validate(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const updated = await clientApi<CombiBoostConfigDto>(
          "/admin/combi-boost-config",
          {
            method: "PUT",
            body: JSON.stringify({
              enabled: draft.enabled,
              minOdds: Number.parseFloat(draft.minOdds),
              tiers: draft.tiers.map((t) => ({
                minLegs: Number.parseInt(t.minLegs, 10),
                multiplier: Number.parseFloat(t.multiplier),
              })),
            }),
          },
        );
        setSavedAt(updated.updatedAt);
        // Reset the dirty baseline by re-seeding the draft from the API
        // response (server may have rounded).
        setDraft(toDraft(updated));
        router.refresh();
      } catch (err) {
        if (err instanceof ApiFetchError) {
          setError(err.message);
        } else {
          setError("Save failed. Please try again.");
        }
      }
    });
  };

  const onReset = () => {
    setDraft(toDraft(initial));
    setError(null);
  };

  return (
    <form
      onSubmit={onSubmit}
      style={{
        marginTop: 24,
        display: "flex",
        flexDirection: "column",
        gap: 20,
        maxWidth: 720,
      }}
    >
      <Section title="Master switch">
        <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft((p) => ({ ...p, enabled: e.target.checked }))}
          />
          <span>
            <strong>Enabled.</strong> When off, no combo gets a boost regardless of leg
            count or odds.
          </span>
        </label>
      </Section>

      <Section title="Per-leg odds floor">
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14, maxWidth: 240 }}>
          <span style={{ color: "var(--color-fg-muted)" }}>Min odds (decimal)</span>
          <input
            type="number"
            step="0.01"
            min="1.01"
            max="10"
            value={draft.minOdds}
            onChange={(e) => setDraft((p) => ({ ...p, minOdds: e.target.value }))}
            style={inputStyle}
          />
        </label>
      </Section>

      <Section title="Boost tiers">
        <p style={{ fontSize: 12.5, color: "var(--color-fg-muted)", marginBottom: 6 }}>
          Both columns must be strictly increasing across tiers. Multipliers
          are decimals; e.g. 1.05 means a 5% boost on potential winnings.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr", gap: 12, alignItems: "center" }}>
          <span style={headerStyle}>Tier</span>
          <span style={headerStyle}>Min legs (≥ 1.50 odds)</span>
          <span style={headerStyle}>Multiplier</span>
          {draft.tiers.map((t, i) => (
            <TierRow
              key={i}
              index={i}
              tier={t}
              onChange={(patch) => updateTier(i, patch)}
            />
          ))}
        </div>
      </Section>

      {error && (
        <div
          role="alert"
          style={{
            fontSize: 12.5,
            color: "var(--negative, #dc2626)",
            background: "color-mix(in oklab, var(--negative, #dc2626) 8%, transparent)",
            padding: "8px 12px",
            borderRadius: 8,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="submit"
          disabled={!dirty || pending}
          style={{
            ...buttonStyle,
            background: dirty ? "var(--accent, #16a34a)" : "var(--color-bg-subtle, var(--surface-2))",
            color: dirty ? "var(--accent-fg, #fff)" : "var(--color-fg-muted, var(--fg-muted))",
            cursor: dirty && !pending ? "pointer" : "default",
            opacity: pending ? 0.7 : 1,
          }}
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={!dirty || pending}
          style={{
            ...buttonStyle,
            background: "transparent",
            border: "1px solid var(--color-border, var(--border))",
            color: "var(--color-fg, var(--fg))",
            cursor: dirty && !pending ? "pointer" : "default",
            opacity: dirty ? 1 : 0.5,
          }}
        >
          Discard changes
        </button>
        <span style={{ fontSize: 11, color: "var(--color-fg-muted, var(--fg-muted))" }}>
          Last saved: {new Date(savedAt).toLocaleString()}
        </span>
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "16px 18px",
        background: "var(--color-bg-subtle, var(--surface-2))",
        border: "1px solid var(--color-border, var(--border))",
        borderRadius: 10,
      }}
    >
      <h2
        className="mono"
        style={{
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--color-fg-subtle, var(--fg-dim))",
          margin: 0,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function TierRow({
  index,
  tier,
  onChange,
}: {
  index: number;
  tier: DraftTier;
  onChange: (patch: Partial<DraftTier>) => void;
}) {
  return (
    <>
      <span style={{ fontSize: 13, color: "var(--color-fg-muted, var(--fg-muted))" }}>
        {index + 1}
      </span>
      <input
        type="number"
        min="2"
        max="30"
        step="1"
        value={tier.minLegs}
        onChange={(e) => onChange({ minLegs: e.target.value })}
        style={inputStyle}
      />
      <input
        type="number"
        min="1.01"
        max="5"
        step="0.01"
        value={tier.multiplier}
        onChange={(e) => onChange({ multiplier: e.target.value })}
        style={inputStyle}
      />
    </>
  );
}

const inputStyle: React.CSSProperties = {
  height: 36,
  padding: "0 10px",
  background: "var(--color-bg, var(--bg))",
  border: "1px solid var(--color-border, var(--border))",
  borderRadius: 8,
  color: "var(--color-fg, var(--fg))",
  fontFamily: "var(--font-mono, monospace)",
  fontVariantNumeric: "tabular-nums",
  fontSize: 14,
};

const headerStyle: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--color-fg-muted, var(--fg-muted))",
};

const buttonStyle: React.CSSProperties = {
  height: 36,
  padding: "0 16px",
  borderRadius: 8,
  border: "1px solid transparent",
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
};
