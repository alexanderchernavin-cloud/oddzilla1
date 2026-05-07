import { serverApi } from "@/lib/server-fetch";
import { BettorsClient, type BettorDto } from "./bettors-client";

export const dynamic = "force-dynamic";

export default async function RiskzillaBettorsPage() {
  const data = await serverApi<{ entries: BettorDto[] }>(
    "/admin/riskzilla/bettors?limit=100&sort=recent",
  );
  if (!data) {
    return (
      <p style={{ color: "var(--color-fg-muted)" }}>Couldn&apos;t load bettors.</p>
    );
  }
  return (
    <>
      <p style={{ fontSize: 13, color: "var(--color-fg-muted)", marginBottom: 16 }}>
        Every bettor with their lifetime risk-relevant stats. RS is the
        per-bettor multiplier on match liability slice; click into a
        bettor to edit it.
      </p>
      <BettorsClient initial={data.entries} />
    </>
  );
}
