import { serverApi } from "@/lib/server-fetch";
import { BettorsClient, type BettorDto } from "./bettors-client";
import { readRzCurrencyFromSearchParams } from "../currency-switch";

export const dynamic = "force-dynamic";

export default async function RiskzillaBettorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const currency = readRzCurrencyFromSearchParams(sp);
  const data = await serverApi<{ entries: BettorDto[] }>(
    `/admin/riskzilla/bettors?limit=100&sort=recent&currency=${currency}`,
  );
  if (!data) {
    return (
      <p style={{ color: "var(--color-fg-muted)" }}>Couldn&apos;t load bettors.</p>
    );
  }
  return (
    <>
      <p style={{ fontSize: 13, color: "var(--color-fg-muted)", marginBottom: 16 }}>
        Every bettor with their lifetime risk-relevant stats. Stats reflect
        the active currency view ({currency}); RS is a per-bettor multiplier
        applied at placement regardless of currency. Click into a bettor to
        edit it.
      </p>
      <BettorsClient initial={data.entries} currency={currency} />
    </>
  );
}
