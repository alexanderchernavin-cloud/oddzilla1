import { BetsClient } from "./bets-client";

export const dynamic = "force-dynamic";

export default function RiskzillaBetsPage() {
  return (
    <>
      <p style={{ fontSize: 13, color: "var(--color-fg-muted)", marginBottom: 16 }}>
        Historical search across every placement attempt. Filter by date,
        decision type, sport, or risk tier. Use the cursor button at the
        bottom to load older rows.
      </p>
      <BetsClient />
    </>
  );
}
