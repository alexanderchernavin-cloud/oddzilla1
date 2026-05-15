import { serverApi } from "@/lib/server-fetch";
import { LiveDelayTree, type SportRow, type Override } from "./tree-client";

export const dynamic = "force-dynamic";

interface SportsResponse {
  global: Override;
  entries: SportRow[];
}

export default async function RiskzillaLiveDelayPage() {
  // Fetch sports + global in one round-trip. Tournament / match tiers
  // load on demand from the client when the user expands a sport row.
  const data = await serverApi<SportsResponse>(
    "/admin/riskzilla/live-delay/sports",
  );
  if (!data) {
    return (
      <p style={{ color: "var(--color-fg-muted)" }}>
        Couldn&apos;t load live-delay configuration.
      </p>
    );
  }
  return (
    <>
      <p style={{ fontSize: 13, color: "var(--color-fg-muted)", marginBottom: 16 }}>
        Live bet acceptance delay. Applies on top of the per-user
        <code> bet_delay_seconds </code>
        and only when at least one leg is on a live match. Cascade per leg:
        <code> match </code> &rarr; <code> tournament </code> &rarr;{" "}
        <code> sport </code> &rarr; <code> global </code> (first override
        wins). Across legs, the worst case (MAX) is applied. The global
        default seeds at <code>5s</code> and cannot be deleted; clearing a
        sport / tournament / match override falls back to the level above.
      </p>
      <LiveDelayTree global={data.global} sports={data.entries} />
    </>
  );
}
