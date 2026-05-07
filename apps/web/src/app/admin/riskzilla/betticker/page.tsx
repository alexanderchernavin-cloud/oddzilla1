import { BettickerClient } from "./betticker-client";

export const dynamic = "force-dynamic";

export default function RiskzillaBettickerPage() {
  return (
    <>
      <p style={{ fontSize: 13, color: "var(--color-fg-muted)", marginBottom: 16 }}>
        Live decision feed. Polls every 3 seconds. Use the filter pills to
        narrow by accept / reject status, sport, currency, or risk tier.
        Click a row to expand the full liability breakdown that the engine
        produced for that decision.
      </p>
      <BettickerClient />
    </>
  );
}
