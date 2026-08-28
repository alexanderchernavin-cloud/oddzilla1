import { serverApi } from "@/lib/server-fetch";
import {
  BoostedOddsBoard,
  type ImageWorkerStatus,
  type RuleDto,
  type RuleWithLabel,
  type SportRow,
} from "./tree-client";

export const dynamic = "force-dynamic";

interface SportsResponse {
  entries: SportRow[];
}
interface RulesResponse {
  rules: RuleWithLabel[];
  imageWorker?: ImageWorkerStatus | null;
}

export default async function AdminBoostedOddsPage() {
  const [sportsData, rulesData] = await Promise.all([
    serverApi<SportsResponse>("/admin/boosted-odds/sports"),
    serverApi<RulesResponse>("/admin/boosted-odds/rules"),
  ]);
  if (!sportsData || !rulesData) {
    return (
      <p style={{ color: "var(--color-fg-muted)" }}>
        Couldn&apos;t load ZillaBoost configuration.
      </p>
    );
  }
  return (
    <>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 6 }}>
        ZillaBoost
      </h1>
      <p style={{ fontSize: 13, color: "var(--color-fg-muted)", marginBottom: 16 }}>
        Operator-curated odds boosts. Attach a boost to any sport, tournament,
        team, match, single market, or a single selection — every market it
        covers renders the boosted price on the storefront (same Netwinstable
        key-delta math as ZillaFlash) and pays out at it. Optional end time
        stops the boost automatically; optional Min Risk Score hides it from
        bettors whose risk score is below the threshold. Most specific rule
        wins:
        <code> selection </code>&rarr;<code> market </code>&rarr;
        <code> match </code>&rarr;<code> team </code>&rarr;
        <code> tournament </code>&rarr;<code> sport</code>. Expand a market
        row to boost one selection: the delta comes out of that price alone,
        its siblings stay where they are, and any coarser boost on that market
        steps aside while the selection boost exists.
      </p>
      <BoostedOddsBoard
        initialSports={sportsData.entries}
        initialRules={rulesData.rules}
        initialImageWorker={rulesData.imageWorker ?? null}
      />
    </>
  );
}

export type { RuleDto };
