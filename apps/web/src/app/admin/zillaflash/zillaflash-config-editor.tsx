"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface ZillaflashConfigDto {
  enabled: boolean;
  prematchTtlSeconds: number;
  liveTtlSeconds: number;
  prematchKeyDeltaPct: number;
  liveKeyDeltaPct: number;
  prematchMinTier: number;
  prematchMaxTier: number;
  liveMinTier: number;
  liveMaxTier: number;
  updatedAt: string;
  updatedBy: string | null;
}

interface KindDraft {
  ttlSeconds: string;
  keyDeltaPct: string;
  minTier: string;
  maxTier: string;
}

interface Draft {
  enabled: boolean;
  prematch: KindDraft;
  live: KindDraft;
}

function toDraft(cfg: ZillaflashConfigDto): Draft {
  return {
    enabled: cfg.enabled,
    prematch: {
      ttlSeconds: String(cfg.prematchTtlSeconds),
      keyDeltaPct: cfg.prematchKeyDeltaPct.toFixed(2),
      minTier: String(cfg.prematchMinTier),
      maxTier: String(cfg.prematchMaxTier),
    },
    live: {
      ttlSeconds: String(cfg.liveTtlSeconds),
      keyDeltaPct: cfg.liveKeyDeltaPct.toFixed(2),
      minTier: String(cfg.liveMinTier),
      maxTier: String(cfg.liveMaxTier),
    },
  };
}

function validateKind(label: string, k: KindDraft): string | null {
  const ttl = Number.parseInt(k.ttlSeconds, 10);
  if (!Number.isInteger(ttl) || ttl < 5 || ttl > 600) {
    return `${label}: window must be an integer between 5 and 600 seconds.`;
  }
  const delta = Number.parseFloat(k.keyDeltaPct);
  if (!Number.isFinite(delta) || delta < 0 || delta > 50) {
    return `${label}: key delta must be between 0 and 50 percentage points.`;
  }
  const min = Number.parseInt(k.minTier, 10);
  const max = Number.parseInt(k.maxTier, 10);
  if (!Number.isInteger(min) || min < 1 || min > 32) {
    return `${label}: min tier must be an integer between 1 and 32.`;
  }
  if (!Number.isInteger(max) || max < 1 || max > 32) {
    return `${label}: max tier must be an integer between 1 and 32.`;
  }
  if (min > max) {
    return `${label}: min tier must be ≤ max tier.`;
  }
  return null;
}

function validate(draft: Draft): string | null {
  return (
    validateKind("Prematch", draft.prematch) ??
    validateKind("Live", draft.live)
  );
}

export function ZillaflashConfigEditor({
  initial,
}: {
  initial: ZillaflashConfigDto;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [savedAt, setSavedAt] = useState<string>(initial.updatedAt);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = (() => {
    if (draft.enabled !== initial.enabled) return true;
    const fromInitial: Draft = toDraft(initial);
    return JSON.stringify(draft) !== JSON.stringify(fromInitial);
  })();

  const updateKind = (
    which: "prematch" | "live",
    patch: Partial<KindDraft>,
  ) => {
    setDraft((prev) => ({ ...prev, [which]: { ...prev[which], ...patch } }));
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
        const updated = await clientApi<ZillaflashConfigDto>(
          "/admin/zillaflash-config",
          {
            method: "PUT",
            body: JSON.stringify({
              enabled: draft.enabled,
              prematchTtlSeconds: Number.parseInt(draft.prematch.ttlSeconds, 10),
              liveTtlSeconds: Number.parseInt(draft.live.ttlSeconds, 10),
              prematchKeyDeltaPct: Number.parseFloat(draft.prematch.keyDeltaPct),
              liveKeyDeltaPct: Number.parseFloat(draft.live.keyDeltaPct),
              prematchMinTier: Number.parseInt(draft.prematch.minTier, 10),
              prematchMaxTier: Number.parseInt(draft.prematch.maxTier, 10),
              liveMinTier: Number.parseInt(draft.live.minTier, 10),
              liveMaxTier: Number.parseInt(draft.live.maxTier, 10),
            }),
          },
        );
        setSavedAt(updated.updatedAt);
        setDraft(toDraft(updated));
        router.refresh();
      } catch (err) {
        if (err instanceof ApiFetchError) setError(err.message);
        else setError("Save failed. Please try again.");
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
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            fontSize: 14,
          }}
        >
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft((p) => ({ ...p, enabled: e.target.checked }))}
          />
          <span>
            <strong>Enabled.</strong> When off, the engine clears every slot and
            the storefront row + match-page chips disappear immediately.
          </span>
        </label>
      </Section>

      <KindSection
        title="Prematch"
        helper="Offers drawn from upcoming matches. A longer window suits the slower pace of prematch betting."
        draft={draft.prematch}
        onChange={(p) => updateKind("prematch", p)}
      />

      <KindSection
        title="Live"
        helper="Offers drawn from in-play matches. Keep the window short — live odds move fast, and the boost feels real only when it's a micro-moment."
        draft={draft.live}
        onChange={(p) => updateKind("live", p)}
      />

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
            background: dirty
              ? "var(--accent, #16a34a)"
              : "var(--color-bg-subtle, var(--surface-2))",
            color: dirty
              ? "var(--accent-fg, #fff)"
              : "var(--color-fg-muted, var(--fg-muted))",
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

function KindSection({
  title,
  helper,
  draft,
  onChange,
}: {
  title: string;
  helper: string;
  draft: KindDraft;
  onChange: (patch: Partial<KindDraft>) => void;
}) {
  return (
    <Section title={title}>
      <p style={{ fontSize: 12.5, color: "var(--color-fg-muted)", marginBottom: 4 }}>
        {helper}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
          <span style={{ color: "var(--color-fg-muted)" }}>
            Window (seconds)
          </span>
          <input
            type="number"
            min="5"
            max="600"
            step="1"
            value={draft.ttlSeconds}
            onChange={(e) => onChange({ ttlSeconds: e.target.value })}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
          <span style={{ color: "var(--color-fg-muted)" }}>
            Key delta (pp)
          </span>
          <input
            type="number"
            min="0"
            max="50"
            step="0.25"
            value={draft.keyDeltaPct}
            onChange={(e) => onChange({ keyDeltaPct: e.target.value })}
            style={inputStyle}
          />
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
          <span style={{ color: "var(--color-fg-muted)" }}>Min tier</span>
          <input
            type="number"
            min="1"
            max="32"
            step="1"
            value={draft.minTier}
            onChange={(e) => onChange({ minTier: e.target.value })}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
          <span style={{ color: "var(--color-fg-muted)" }}>Max tier</span>
          <input
            type="number"
            min="1"
            max="32"
            step="1"
            value={draft.maxTier}
            onChange={(e) => onChange({ maxTier: e.target.value })}
            style={inputStyle}
          />
        </label>
      </div>
      <p
        style={{
          fontSize: 11.5,
          color: "var(--color-fg-muted)",
          marginTop: 8,
          lineHeight: 1.4,
        }}
      >
        Tournament risk tier window (inclusive). 1–3 = flagship events only;
        widen to draw boosts from a deeper bench. Key delta = percentage
        points shaved off the published book key — 3 pp is the
        product baseline.
      </p>
    </Section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
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

const buttonStyle: React.CSSProperties = {
  height: 36,
  padding: "0 16px",
  borderRadius: 8,
  border: "1px solid transparent",
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 500,
};
