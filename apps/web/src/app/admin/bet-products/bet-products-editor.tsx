"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface BetProduct {
  productName: "tiple" | "tippot";
  marginBp: number;
  marginBpPerLeg: number;
  minLegs: number;
  maxLegs: number;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

function bpToPercent(bp: number): string {
  return (bp / 100).toFixed(2);
}

function percentToBp(pct: string): number {
  const n = Number(pct);
  if (!Number.isFinite(n)) return -1;
  return Math.round(n * 100);
}

export function BetProductsEditor({ initial }: { initial: BetProduct[] }) {
  return (
    <div className="mt-8 grid gap-6 sm:grid-cols-2">
      {initial.map((p) => (
        <ProductCard key={p.productName} product={p} />
      ))}
    </div>
  );
}

function ProductCard({ product }: { product: BetProduct }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [marginPct, setMarginPct] = useState(bpToPercent(product.marginBp));
  const [marginPerLegPct, setMarginPerLegPct] = useState(
    bpToPercent(product.marginBpPerLeg),
  );
  const [minLegs, setMinLegs] = useState(String(product.minLegs));
  const [maxLegs, setMaxLegs] = useState(String(product.maxLegs));
  const [enabled, setEnabled] = useState(product.enabled);

  function save() {
    setErr(null);
    const bp = percentToBp(marginPct);
    const bpPerLeg = percentToBp(marginPerLegPct);
    const minN = Number(minLegs);
    const maxN = Number(maxLegs);
    if (bp < 0 || bp > 5000) {
      setErr("Base margin must be between 0% and 50%.");
      return;
    }
    if (bpPerLeg < 0 || bpPerLeg > 5000) {
      setErr("Per-leg margin must be between 0% and 50%.");
      return;
    }
    if (!Number.isInteger(minN) || minN < 2 || minN > 30) {
      setErr("min_legs must be an integer in [2, 30].");
      return;
    }
    if (!Number.isInteger(maxN) || maxN < minN || maxN > 30) {
      setErr("max_legs must be an integer in [min_legs, 30].");
      return;
    }
    startTransition(async () => {
      try {
        await clientApi(`/admin/bet-products/${product.productName}`, {
          method: "PUT",
          body: JSON.stringify({
            marginBp: bp,
            marginBpPerLeg: bpPerLeg,
            minLegs: minN,
            maxLegs: maxN,
            enabled,
          }),
        });
        router.refresh();
      } catch (e) {
        if (e instanceof ApiFetchError) {
          setErr(e.message);
        } else {
          setErr("Save failed");
        }
      }
    });
  }

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-elev)] p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold uppercase tracking-wide">
          {product.productName}
        </h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enabled
        </label>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="flex flex-col text-xs">
          <span className="text-[var(--color-fg-muted)]">Base margin (%)</span>
          <input
            type="number"
            step="0.01"
            min={0}
            max={50}
            value={marginPct}
            onChange={(e) => setMarginPct(e.target.value)}
            className="mt-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs">
          <span className="text-[var(--color-fg-muted)]">
            Per-leg margin (% × N)
          </span>
          <input
            type="number"
            step="0.01"
            min={0}
            max={50}
            value={marginPerLegPct}
            onChange={(e) => setMarginPerLegPct(e.target.value)}
            className="mt-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs">
          <span className="text-[var(--color-fg-muted)]">Min legs</span>
          <input
            type="number"
            min={2}
            max={30}
            value={minLegs}
            onChange={(e) => setMinLegs(e.target.value)}
            className="mt-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col text-xs">
          <span className="text-[var(--color-fg-muted)]">Max legs</span>
          <input
            type="number"
            min={2}
            max={30}
            value={maxLegs}
            onChange={(e) => setMaxLegs(e.target.value)}
            className="mt-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
          />
        </label>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
        Effective margin at placement is{" "}
        <span className="font-mono">base + per-leg × N</span>. Per-leg
        margin compounds the way a combo&apos;s odds product does, so
        Tippot&apos;s all-wins multiplier stays below an equivalent combo.
      </p>

      {err && <p className="mt-3 text-xs text-red-500">{err}</p>}

      <div className="mt-4 flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
        <span>
          Updated {new Date(product.updatedAt).toLocaleString()}
        </span>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded border border-[var(--color-border)] px-3 py-1 text-sm hover:bg-[var(--color-bg)] disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
