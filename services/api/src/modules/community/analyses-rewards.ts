// Analysis-side Oz earning hooks.
//
// One credit reason lands in this PR:
//
//   creditEngagementFloor
//     Fires when an analysis's inspiration_count crosses from 9 → 10.
//     Pays the author a stake-scaled Oz amount (25% of stake, capped
//     at 250 Oz, floor 1 Oz), idempotent on the analysis_id so a
//     replay or a row update race can't double-credit.
//
// Follow-up reasons (separate PRs once their signals exist):
//   • analysis_inspirations_milestone — +50 Oz at the 500 inspiration
//     mark. Same crossing-detection pattern; defer until product
//     signals demand it.
//   • analysis_win_bonus — +25% of stake when analysis.outcome flips
//     to 'won'. Blocked on the Go-side analyses settlement projection
//     landing first.

import { sql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";
import { creditOz, type OzLedgerExecutor } from "./oz-ledger.js";

export interface EngagementFloorInput {
  analysisId: string;
  authorId: string;
  // Stake on the analysis's attached ticket, in micros (1 unit =
  // 1_000_000 micros). Currency is whatever the ticket was placed in;
  // the Oz formula collapses across currencies (see ozFromStakeMicros).
  ticketStakeMicro: bigint | number | string;
}

export interface EngagementFloorResult {
  credited: boolean;
  // Oz delta minted (or that would have been minted on a dedup hit).
  // Useful for observability.
  delta: number;
}

// Engagement-floor formula: 25% of stake in "stake units" (micros / 1M),
// floored at 1, capped at 250. Matches the Tipsport "Reward formula
// V1 mapping" doc's intent but collapsed to currency-agnostic Oz so a
// 100 BRL bet and a 100 USDT bet credit the same amount.
//
// 250 cap is the V1 spec's reward_nets_cap_base. 1 Oz floor exists so
// micro-stake bets (≤ ~4 stake units) still surface a non-zero reward
// — better engagement signal than "your analysis crossed the floor
// but you got 0 Oz because the math rounded down".
export function ozFromStakeMicros(
  stakeMicro: bigint | number | string,
): number {
  const stake = typeof stakeMicro === "bigint" ? stakeMicro : BigInt(stakeMicro);
  const stakeUnits = Number(stake / 1_000_000n);
  const raw = Math.floor(stakeUnits * 0.25);
  if (raw < 1) return 1;
  if (raw > 250) return 250;
  return raw;
}

// Fires the engagement-floor credit. The CALLER must guarantee this
// runs exactly once per analysis crossing 9 → 10 (via the +1 UPDATE
// RETURNING new count == 10 pattern). The idempotency_key in creditOz
// provides a second line of defence — if the caller fires twice
// accidentally, the ledger UNIQUE constraint no-ops the second call.
export async function creditEngagementFloor(
  db: OzLedgerExecutor,
  input: EngagementFloorInput,
): Promise<EngagementFloorResult> {
  const delta = ozFromStakeMicros(input.ticketStakeMicro);
  const credit = await creditOz(db, {
    userId: input.authorId,
    delta,
    reason: "analysis_engagement_floor",
    sourceKind: "analysis",
    sourceId: input.analysisId,
    idempotencyKey: `analysis_engagement_floor:${input.analysisId}`,
  });
  return { credited: credit.credited, delta };
}

// Re-export for callers — saves them an extra import.
export type { OzLedgerExecutor };
export type { DbClient };
