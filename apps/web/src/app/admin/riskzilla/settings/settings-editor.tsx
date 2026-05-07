"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { fromMicro, toMicro } from "@oddzilla/types";

export interface SettingsEntry {
  tier: number;
  matchLiabilityMicro: string;
  minBetMicro: string;
  maxPayoutMicro: string;
  betFactor: string;
  updatedAt: string;
  updatedBy: string | null;
}

interface DraftRow {
  tier: number;
  matchLiability: string;
  minBet: string;
  maxPayout: string;
  betFactor: string;
}

function toDraft(e: SettingsEntry): DraftRow {
  return {
    tier: e.tier,
    matchLiability: fromMicro(BigInt(e.matchLiabilityMicro)),
    minBet: fromMicro(BigInt(e.minBetMicro)),
    maxPayout: fromMicro(BigInt(e.maxPayoutMicro)),
    betFactor: e.betFactor,
  };
}

export function SettingsEditor({ entries }: { entries: SettingsEntry[] }) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<DraftRow[]>(() => entries.map(toDraft));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedTier, setSavedTier] = useState<number | null>(null);

  const onChange = (i: number, patch: Partial<DraftRow>) => {
    setDrafts((prev) => prev.map((d, j) => (i === j ? { ...d, ...patch } : d)));
  };

  const save = (i: number) => {
    const d = drafts[i]!;
    let payload: {
      matchLiabilityMicro: string;
      minBetMicro: string;
      maxPayoutMicro: string;
      betFactor: string;
    };
    try {
      payload = {
        matchLiabilityMicro: BigInt(toMicro(d.matchLiability)).toString(),
        minBetMicro: BigInt(toMicro(d.minBet)).toString(),
        maxPayoutMicro: BigInt(toMicro(d.maxPayout)).toString(),
        betFactor: d.betFactor,
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "invalid value");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/riskzilla/settings/${d.tier}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        setSavedTier(d.tier);
        setTimeout(() => setSavedTier(null), 2000);
        router.refresh();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.message : "save failed");
      }
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
          gridTemplateColumns: "auto 1fr 1fr 1fr 1fr auto",
          gap: 8,
          alignItems: "center",
          fontSize: 13,
        }}
      >
        <Header>Tier</Header>
        <Header>Match liability (USDC)</Header>
        <Header>Min bet (USDC)</Header>
        <Header>Max payout (USDC)</Header>
        <Header>Bet factor</Header>
        <Header />
        {drafts.map((d, i) => {
          const original = entries[i]!;
          const dirty =
            d.matchLiability !== fromMicro(BigInt(original.matchLiabilityMicro)) ||
            d.minBet !== fromMicro(BigInt(original.minBetMicro)) ||
            d.maxPayout !== fromMicro(BigInt(original.maxPayoutMicro)) ||
            d.betFactor !== original.betFactor;
          return (
            <Row key={d.tier}>
              <span style={{ fontWeight: 600 }}>{d.tier === 0 ? "Default" : d.tier}</span>
              <Input value={d.matchLiability} onChange={(v) => onChange(i, { matchLiability: v })} />
              <Input value={d.minBet} onChange={(v) => onChange(i, { minBet: v })} />
              <Input value={d.maxPayout} onChange={(v) => onChange(i, { maxPayout: v })} />
              <Input value={d.betFactor} onChange={(v) => onChange(i, { betFactor: v })} />
              <button
                type="button"
                disabled={!dirty || pending}
                onClick={() => save(i)}
                style={{
                  height: 32,
                  padding: "0 12px",
                  borderRadius: 6,
                  border: "1px solid var(--color-border)",
                  background: dirty
                    ? "var(--accent, #16a34a)"
                    : "var(--color-bg-subtle)",
                  color: dirty ? "#fff" : "var(--color-fg-muted)",
                  cursor: dirty && !pending ? "pointer" : "default",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {savedTier === d.tier ? "Saved" : "Save"}
              </button>
            </Row>
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

function Row({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function Input({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
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
      }}
    />
  );
}
