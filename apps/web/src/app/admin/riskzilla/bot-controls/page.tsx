import { serverApi } from "@/lib/server-fetch";
import { BotControlsEditor, type BotControlsDto } from "./bot-controls-editor";
import { AlertsTable, type BehaviourAlertDto } from "./alerts-table";

export const dynamic = "force-dynamic";

export default async function RiskzillaBotControlsPage() {
  const [controls, alerts] = await Promise.all([
    serverApi<BotControlsDto>("/admin/riskzilla/bot-controls"),
    serverApi<{ entries: BehaviourAlertDto[] }>(
      "/admin/riskzilla/behaviour/alerts?includeAcknowledged=true&limit=200",
    ),
  ]);
  if (!controls) {
    return (
      <p style={{ color: "var(--color-fg-muted)" }}>
        Couldn&apos;t load bot controls.
      </p>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <section>
        <p style={{ fontSize: 13, color: "var(--color-fg-muted)", marginBottom: 16 }}>
          Anti-automation controls on bet placement. None of these make the
          slip &quot;mouse-only&quot; — a script can drive a real browser — they
          make automation gain nothing and get noticed. The <strong>intent
          token</strong> forces every placement through the same quote step
          the slip uses and gives the server a trustworthy quote timestamp;
          the <strong>minimum human time</strong> rejects a confirm faster than a
          hand could manage, which is exactly what removes the latency edge;
          <strong> velocity caps</strong> bound placements and distinct matches per
          minute, scaled by the bettor&apos;s risk score
          (cap = round(base &times; RS), floor 1). Rejections show up in the
          betticker as <code>rejected_velocity</code>.
        </p>
        <BotControlsEditor initial={controls} />
      </section>

      <section>
        <h2
          className="mono"
          style={{
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--color-fg-subtle)",
            margin: "0 0 12px 0",
          }}
        >
          Automation alerts
        </h2>
        <p style={{ fontSize: 13, color: "var(--color-fg-muted)", marginBottom: 12 }}>
          Bettors whose behaviour score is over the threshold above. Scored
          every five minutes from the first-party analytics (pointer
          geometry, click rhythm) plus the quote-to-place confirm time on
          their tickets; touch devices and thin sessions are left unscored.
          Acknowledge once reviewed — a fresh spike re-opens the alert.
        </p>
        <AlertsTable initial={alerts?.entries ?? []} />
      </section>
    </div>
  );
}
