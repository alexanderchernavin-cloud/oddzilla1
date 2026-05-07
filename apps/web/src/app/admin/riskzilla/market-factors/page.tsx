import { serverApi } from "@/lib/server-fetch";
import { MarketFactorsEditor, type MarketFactorEntry } from "./market-factors-editor";

export const dynamic = "force-dynamic";

export default async function RiskzillaMarketFactorsPage() {
  const data = await serverApi<{ entries: MarketFactorEntry[] }>(
    "/admin/riskzilla/market-factors",
  );
  if (!data) {
    return (
      <p style={{ color: "var(--color-fg-muted)" }}>
        Couldn&apos;t load market factors.
      </p>
    );
  }
  return (
    <>
      <p style={{ fontSize: 13, color: "var(--color-fg-muted)", marginBottom: 16 }}>
        Per-market multiplier on the per-tier match liability cap.
        Down-only — values are between <code>0.000</code> and{" "}
        <code>1.000</code>. Markets without a row here use{" "}
        <code>1.000</code> implicitly. A factor of <code>0</code> hard-rejects
        every bet on that market type with{" "}
        <code>rejected_market_factor</code>.
      </p>
      <MarketFactorsEditor entries={data.entries} />
    </>
  );
}
