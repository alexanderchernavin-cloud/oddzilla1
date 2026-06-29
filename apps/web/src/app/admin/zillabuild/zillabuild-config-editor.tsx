"use client";

import { useState, useTransition, type FormEvent, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface ZillabuildConfigDto {
  enabled: boolean;
  eligibleProviderMarketIds: number[];
  cardsPerMap: number;
  mapCount: number;
  minLegs: number;
  maxLegs: number;
  minCombinedOdds: number;
  cacheTtlSeconds: number;
  updatedAt: string;
  updatedBy: string | null;
}

interface Draft {
  enabled: boolean;
  eligible: number[];
  cardsPerMap: string;
  mapCount: string;
  minLegs: string;
  maxLegs: string;
  minCombinedOdds: string;
  cacheTtlSeconds: string;
}

function toDraft(cfg: ZillabuildConfigDto): Draft {
  return {
    enabled: cfg.enabled,
    eligible: [...cfg.eligibleProviderMarketIds],
    cardsPerMap: String(cfg.cardsPerMap),
    mapCount: String(cfg.mapCount),
    minLegs: String(cfg.minLegs),
    maxLegs: String(cfg.maxLegs),
    minCombinedOdds: cfg.minCombinedOdds.toFixed(2),
    cacheTtlSeconds: String(cfg.cacheTtlSeconds),
  };
}

function validate(draft: Draft): string | null {
  const cpm = Number.parseInt(draft.cardsPerMap, 10);
  if (!Number.isInteger(cpm) || cpm < 1 || cpm > 4)
    return "Cards per map must be an integer between 1 and 4.";
  const maps = Number.parseInt(draft.mapCount, 10);
  if (!Number.isInteger(maps) || maps < 1 || maps > 5)
    return "Map count must be an integer between 1 and 5.";
  const minL = Number.parseInt(draft.minLegs, 10);
  const maxL = Number.parseInt(draft.maxLegs, 10);
  if (!Number.isInteger(minL) || minL < 2 || minL > 8)
    return "Min legs must be an integer between 2 and 8.";
  if (!Number.isInteger(maxL) || maxL < 2 || maxL > 8)
    return "Max legs must be an integer between 2 and 8.";
  if (minL > maxL) return "Min legs must be ≤ max legs.";
  const minOdds = Number.parseFloat(draft.minCombinedOdds);
  if (!Number.isFinite(minOdds) || minOdds < 1.01 || minOdds > 1000)
    return "Min combined odds must be between 1.01 and 1000.";
  const ttl = Number.parseInt(draft.cacheTtlSeconds, 10);
  if (!Number.isInteger(ttl) || ttl < 5 || ttl > 600)
    return "Cache window must be an integer between 5 and 600 seconds.";
  return null;
}

export function ZillabuildConfigEditor({
  initial,
}: {
  initial: ZillabuildConfigDto;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [marketInput, setMarketInput] = useState("");
  const [savedAt, setSavedAt] = useState<string>(initial.updatedAt);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(initial));

  const addMarket = () => {
    const n = Number.parseInt(marketInput.trim(), 10);
    if (!Number.isInteger(n) || n <= 0) {
      setError("Enter a positive provider_market_id to add.");
      return;
    }
    setError(null);
    setMarketInput("");
    setDraft((prev) =>
      prev.eligible.includes(n)
        ? prev
        : { ...prev, eligible: [...prev.eligible, n].sort((a, b) => a - b) },
    );
  };

  const removeMarket = (n: number) =>
    setDraft((prev) => ({
      ...prev,
      eligible: prev.eligible.filter((x) => x !== n),
    }));

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
        const updated = await clientApi<ZillabuildConfigDto>(
          "/admin/zillabuild-config",
          {
            method: "PUT",
            body: JSON.stringify({
              enabled: draft.enabled,
              eligibleProviderMarketIds: draft.eligible,
              cardsPerMap: Number.parseInt(draft.cardsPerMap, 10),
              mapCount: Number.parseInt(draft.mapCount, 10),
              minLegs: Number.parseInt(draft.minLegs, 10),
              maxLegs: Number.parseInt(draft.maxLegs, 10),
              minCombinedOdds: Number.parseFloat(draft.minCombinedOdds),
              cacheTtlSeconds: Number.parseInt(draft.cacheTtlSeconds, 10),
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
    setMarketInput("");
    setError(null);
  };

  return (
    <form
      onSubmit={onSubmit}
      style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 20, maxWidth: 720 }}
    >
      <Section title="Master switch">
        <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft((p) => ({ ...p, enabled: e.target.checked }))}
          />
          <span>
            <strong>Enabled.</strong> When off, the ZillaBuild section disappears
            from every match page immediately.
          </span>
        </label>
      </Section>

      <Section title="Which markets to consider">
        <p style={{ fontSize: 12.5, color: "var(--color-fg-muted)", marginBottom: 4 }}>
          Allowlist of Oddin <code>provider_market_id</code> values eligible for
          card composition. Leave empty to consider every BetBuilder-eligible
          per-map market. Only markets carrying a <code>map</code> specifier are
          ever used — ZillaBuild combos are always within a single map.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          {draft.eligible.length === 0 ? (
            <span style={{ fontSize: 12.5, color: "var(--color-fg-subtle, var(--fg-dim))" }}>
              All eligible markets considered.
            </span>
          ) : (
            draft.eligible.map((n) => (
              <span
                key={n}
                className="mono"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 26,
                  padding: "0 6px 0 10px",
                  borderRadius: 999,
                  border: "1px solid var(--color-border, var(--border))",
                  background: "var(--color-bg, var(--bg))",
                  fontSize: 12.5,
                }}
              >
                #{n}
                <button
                  type="button"
                  aria-label={`Remove market ${n}`}
                  onClick={() => removeMarket(n)}
                  style={{
                    border: 0,
                    background: "transparent",
                    cursor: "pointer",
                    color: "var(--color-fg-muted, var(--fg-muted))",
                    fontSize: 14,
                    lineHeight: 1,
                    padding: "0 2px",
                  }}
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="number"
            min="1"
            step="1"
            placeholder="provider_market_id"
            value={marketInput}
            onChange={(e) => setMarketInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addMarket();
              }
            }}
            style={{ ...inputStyle, maxWidth: 200 }}
          />
          <button
            type="button"
            onClick={addMarket}
            style={{
              ...buttonStyle,
              background: "transparent",
              border: "1px solid var(--color-border, var(--border))",
              color: "var(--color-fg, var(--fg))",
              cursor: "pointer",
            }}
          >
            Add market
          </button>
        </div>
      </Section>

      <Section title="Card shape">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <NumberField
            label="Cards per map"
            min={1}
            max={4}
            value={draft.cardsPerMap}
            onChange={(v) => setDraft((p) => ({ ...p, cardsPerMap: v }))}
          />
          <NumberField
            label="Map count"
            min={1}
            max={5}
            value={draft.mapCount}
            onChange={(v) => setDraft((p) => ({ ...p, mapCount: v }))}
          />
          <NumberField
            label="Min legs per card"
            min={2}
            max={8}
            value={draft.minLegs}
            onChange={(v) => setDraft((p) => ({ ...p, minLegs: v }))}
          />
          <NumberField
            label="Max legs per card"
            min={2}
            max={8}
            value={draft.maxLegs}
            onChange={(v) => setDraft((p) => ({ ...p, maxLegs: v }))}
          />
          <NumberField
            label="Min combined odds"
            min={1.01}
            max={1000}
            step={0.01}
            value={draft.minCombinedOdds}
            onChange={(v) => setDraft((p) => ({ ...p, minCombinedOdds: v }))}
          />
          <NumberField
            label="Cache window (seconds)"
            min={5}
            max={600}
            value={draft.cacheTtlSeconds}
            onChange={(v) => setDraft((p) => ({ ...p, cacheTtlSeconds: v }))}
          />
        </div>
        <p style={{ fontSize: 11.5, color: "var(--color-fg-muted)", marginTop: 8, lineHeight: 1.4 }}>
          Default: 2 cards on Map 1 + 2 cards on Map 2, each a random 2–4 leg
          combo. A card is only kept if Oddin still prices it; the combined-odds
          floor drops trivially-short combos so cards read as worthwhile.
        </p>
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

function NumberField({
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
      <span style={{ color: "var(--color-fg-muted)" }}>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
    </label>
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

const inputStyle: CSSProperties = {
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

const buttonStyle: CSSProperties = {
  height: 36,
  padding: "0 16px",
  borderRadius: 8,
  border: "1px solid transparent",
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 500,
};
