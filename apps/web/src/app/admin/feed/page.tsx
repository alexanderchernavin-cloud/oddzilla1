import { serverApi } from "@/lib/server-fetch";
import { RecoveryPanel, type FeedStatus } from "./recovery-panel";

export default async function AdminFeedPage() {
  const status = await serverApi<FeedStatus>("/admin/feed/status");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1
          className="display"
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 500,
            letterSpacing: "-0.02em",
          }}
        >
          Feed controls
        </h1>
        <p
          style={{
            margin: "6px 0 0",
            color: "var(--color-fg-muted)",
            fontSize: 13.5,
            lineHeight: 1.5,
            maxWidth: 640,
          }}
        >
          Trigger a full odds replay from the Oddin AMQP feed. Use this when
          matches are stuck LIVE without odds, markets look stale, or after
          a bet-delay gap. The button rewinds the ingest cursor and asks
          Oddin to re-send every message from that point forward. Flushing
          odds additionally suspends every currently-active market until the
          replay re-populates them, so users never see phantom prices while
          recovery is in flight.
        </p>
      </div>

      <RecoveryPanel initialStatus={status ?? { producers: [] }} />
    </div>
  );
}
