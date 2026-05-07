import { serverApi } from "@/lib/server-fetch";
import { SettingsEditor, type SettingsEntry } from "./settings-editor";

export const dynamic = "force-dynamic";

export default async function RiskzillaSettingsPage() {
  const data = await serverApi<{ entries: SettingsEntry[] }>(
    "/admin/riskzilla/settings",
  );
  if (!data) {
    return (
      <p style={{ color: "var(--color-fg-muted)" }}>
        Couldn&apos;t load settings.
      </p>
    );
  }
  return (
    <>
      <p style={{ fontSize: 13, color: "var(--color-fg-muted)", marginBottom: 16 }}>
        Per-tier defaults. Tier 0 is the global fallback used when a match
        has no <code>risk_tier</code>. Tiers 1–6 mirror Oddin&apos;s
        risk_tier on tournaments. Min bet defaults to <code>0.1 USDC</code>;
        bet factor defaults to <code>0.1</code> (10% of match liability).
      </p>
      <SettingsEditor entries={data.entries} />
    </>
  );
}
