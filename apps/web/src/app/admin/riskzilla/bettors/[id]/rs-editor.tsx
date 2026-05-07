"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export function RsEditor({
  userId,
  initial,
}: {
  userId: string;
  initial: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = draft !== initial;

  const submit = () => {
    const num = Number.parseFloat(draft);
    if (!Number.isFinite(num) || num < 0.01 || num > 10) {
      setError("RS must be between 0.01 and 10");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/riskzilla/bettors/${userId}/risk-score`, {
          method: "PATCH",
          body: JSON.stringify({ riskScore: num.toFixed(3) }),
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
        router.refresh();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.message : "save failed");
      }
    });
  };

  return (
    <section
      style={{
        background: "var(--color-bg-subtle)",
        border: "1px solid var(--color-border)",
        borderRadius: 10,
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 240,
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
        Risk score (RS)
      </span>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{
            height: 36,
            padding: "0 10px",
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            color: "var(--color-fg)",
            fontFamily: "var(--font-mono, monospace)",
            fontVariantNumeric: "tabular-nums",
            fontSize: 14,
            width: 100,
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!dirty || pending}
          style={{
            height: 36,
            padding: "0 14px",
            background: dirty ? "var(--accent, #16a34a)" : "var(--color-bg)",
            color: dirty ? "#fff" : "var(--color-fg-muted)",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: dirty && !pending ? "pointer" : "default",
          }}
        >
          {saved ? "Saved" : pending ? "…" : "Save"}
        </button>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--color-fg-muted)", margin: 0 }}>
        Range 0.01–10. Multiplier on the bettor&apos;s slice of match
        liability. VIP-damped above RS 3.
      </p>
      {error && (
        <span style={{ fontSize: 12, color: "#dc2626" }}>{error}</span>
      )}
    </section>
  );
}
