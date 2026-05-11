import type { ReactNode } from "react";
import { RiskzillaCurrencySwitch } from "./currency-switch";
import { RiskzillaTabs } from "./tabs";

// Visual hierarchy: top header sets the "RiskZilla" brand, then a
// currency switch (USDC default, OZ for demo monitoring), then a tab
// strip switches between the seven sub-pages. Tabs preserve the
// active `?cur=` so the user stays in the chosen view as they
// navigate.
export default function RiskzillaLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <h1 className="text-2xl font-semibold tracking-tight">RiskZilla</h1>
        <span
          className="mono"
          style={{
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--color-fg-subtle, var(--fg-dim))",
          }}
        >
          Internal risk management
        </span>
        <span style={{ flex: 1 }} />
        <RiskzillaCurrencySwitch />
      </header>
      <p
        style={{
          fontSize: 13,
          color: "var(--color-fg-muted)",
          marginBottom: 16,
        }}
      >
        Per-tier liability caps, per-market factors, the operator
        bankroll, and a live decision feed for every bet placed against
        the storefront. USDC is the real-money operator view; the OZ
        toggle scopes ticket/bettor stats to demo-currency volume.
      </p>
      <RiskzillaTabs />
      <div>{children}</div>
    </div>
  );
}
