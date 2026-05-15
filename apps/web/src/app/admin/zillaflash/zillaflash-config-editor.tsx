"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface ZillaflashConfigDto {
  enabled: boolean;
  prematchTtlSeconds: number;
  liveTtlSeconds: number;
  updatedAt: string;
  updatedBy: string | null;
}

interface Draft {
  enabled: boolean;
  prematchTtlSeconds: string;
  liveTtlSeconds: string;
}

function toDraft(cfg: ZillaflashConfigDto): Draft {
  return {
    enabled: cfg.enabled,
    prematchTtlSeconds: String(cfg.prematchTtlSeconds),
    liveTtlSeconds: String(cfg.liveTtlSeconds),
  };
}

function validate(draft: Draft): string | null {
  const p = Number.parseInt(draft.prematchTtlSeconds, 10);
  const l = Number.parseInt(draft.liveTtlSeconds, 10);
  if (!Number.isInteger(p) || p < 5 || p > 600) {
    return "Prematch window must be an integer between 5 and 600 seconds.";
  }
  if (!Number.isInteger(l) || l < 5 || l > 600) {
    return "Live window must be an integer between 5 and 600 seconds.";
  }
  return null;
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

  const dirty =
    draft.enabled !== initial.enabled ||
    Number.parseInt(draft.prematchTtlSeconds, 10) !== initial.prematchTtlSeconds ||
    Number.parseInt(draft.liveTtlSeconds, 10) !== initial.liveTtlSeconds;

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
              prematchTtlSeconds: Number.parseInt(draft.prematchTtlSeconds, 10),
              liveTtlSeconds: Number.parseInt(draft.liveTtlSeconds, 10),
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
        maxWidth: 560,
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
            <strong>Enabled.</strong> When off the engine clears every slot and the
            storefront row + match-page chips disappear immediately.
          </span>
        </label>
      </Section>

      <Section title="Offer windows">
        <p style={{ fontSize: 12.5, color: "var(--color-fg-muted)", marginBottom: 4 }}>
          How long each offer is visible before rotation picks a fresh
          fixture. Live needs to be short (the underlying odds move fast);
          prematch can be longer.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
            <span style={{ color: "var(--color-fg-muted)" }}>
              Prematch window (seconds)
            </span>
            <input
              type="number"
              min="5"
              max="600"
              step="1"
              value={draft.prematchTtlSeconds}
              onChange={(e) =>
                setDraft((p) => ({ ...p, prematchTtlSeconds: e.target.value }))
              }
              style={inputStyle}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
            <span style={{ color: "var(--color-fg-muted)" }}>
              Live window (seconds)
            </span>
            <input
              type="number"
              min="5"
              max="600"
              step="1"
              value={draft.liveTtlSeconds}
              onChange={(e) =>
                setDraft((p) => ({ ...p, liveTtlSeconds: e.target.value }))
              }
              style={inputStyle}
            />
          </label>
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
