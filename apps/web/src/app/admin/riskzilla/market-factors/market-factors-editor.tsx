"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface MarketFactorEntry {
  providerMarketId: number;
  factor: string;
  label: string;
  notes: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export function MarketFactorsEditor({ entries }: { entries: MarketFactorEntry[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [drafts, setDrafts] = useState<Record<number, string>>(() =>
    Object.fromEntries(entries.map((e) => [e.providerMarketId, e.factor])),
  );
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.label.toLowerCase().includes(q) ||
        String(e.providerMarketId).includes(q),
    );
  }, [filter, entries]);

  const save = (e: MarketFactorEntry) => {
    const v = drafts[e.providerMarketId] ?? e.factor;
    const num = Number.parseFloat(v);
    if (!Number.isFinite(num) || num < 0 || num > 1) {
      setError("Factor must be between 0 and 1");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/riskzilla/market-factors/${e.providerMarketId}`, {
          method: "PUT",
          body: JSON.stringify({ factor: num.toFixed(3), label: e.label }),
        });
        setSavedId(e.providerMarketId);
        setTimeout(() => setSavedId(null), 1500);
        router.refresh();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.message : "save failed");
      }
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <input
        type="search"
        placeholder="Filter by name or market id"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{
          height: 36,
          padding: "0 12px",
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          color: "var(--color-fg)",
          fontSize: 13,
          maxWidth: 360,
        }}
      />
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
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "60px 1fr 100px 80px",
          gap: 6,
          alignItems: "center",
          fontSize: 13,
        }}
      >
        <Header>ID</Header>
        <Header>Market</Header>
        <Header>Factor</Header>
        <Header />
        {filtered.map((e) => {
          const draft = drafts[e.providerMarketId] ?? e.factor;
          const dirty = draft !== e.factor;
          return (
            <RowFragment key={e.providerMarketId}>
              <span style={{ color: "var(--color-fg-muted)", fontVariantNumeric: "tabular-nums" }}>
                {e.providerMarketId}
              </span>
              <span>{e.label}</span>
              <input
                type="text"
                value={draft}
                onChange={(ev) =>
                  setDrafts((p) => ({ ...p, [e.providerMarketId]: ev.target.value }))
                }
                style={{
                  height: 28,
                  padding: "0 6px",
                  background: "var(--color-bg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 4,
                  color: "var(--color-fg)",
                  fontFamily: "var(--font-mono, monospace)",
                  fontVariantNumeric: "tabular-nums",
                  fontSize: 13,
                }}
              />
              <button
                type="button"
                onClick={() => save(e)}
                disabled={!dirty || pending}
                style={{
                  height: 28,
                  padding: "0 10px",
                  borderRadius: 4,
                  border: "1px solid var(--color-border)",
                  background: dirty ? "var(--accent, #16a34a)" : "var(--color-bg-subtle)",
                  color: dirty ? "#fff" : "var(--color-fg-muted)",
                  fontSize: 12,
                  cursor: dirty && !pending ? "pointer" : "default",
                }}
              >
                {savedId === e.providerMarketId ? "Saved" : "Save"}
              </button>
            </RowFragment>
          );
        })}
      </div>
    </div>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 11,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--color-fg-muted)",
      }}
    >
      {children}
    </span>
  );
}

function RowFragment({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
