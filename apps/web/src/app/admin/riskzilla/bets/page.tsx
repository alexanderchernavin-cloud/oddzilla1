import { BetsClient } from "./bets-client";

export const dynamic = "force-dynamic";

export default function RiskzillaBetsPage() {
  return (
    <>
      <p style={{ fontSize: 13, color: "var(--color-fg-muted)", marginBottom: 16 }}>
        Historical search across every placement attempt. Filter by date,
        decision type, sport, risk tier, or stake range. Use the cursor
        button at the bottom to load older rows. The currency switch at
        the top of the page scopes results to either USDC (real) or OZ
        (demo) volume.
      </p>
      <BetsClient />
    </>
  );
}
