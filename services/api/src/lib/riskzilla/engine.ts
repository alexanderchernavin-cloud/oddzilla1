// RiskZilla engine — pre-bet evaluation.
//
// Runs inside the bet placement transaction. Given a placement intent
// (user, currency, stake, potential payout, per-leg market+outcome list)
// it computes the worst-case operator loss this bet would add per
// (match, market, outcome) bucket, compares it against the per-tier
// caps, the per-bettor slice (bet_factor × tier.match_liability × RS),
// and the global bank limit. Returns either:
//   - { decision: "accepted", meta }  → caller proceeds with INSERT
//   - { decision: "rejected_*", reason, meta }  → caller rolls the
//     placement tx back; the API service then writes a single
//     event_log row OUTSIDE the rolled-back tx (so the rejection is
//     durably recorded) and throws a typed error to the client.
//
// On accept, the caller invokes commitAccepted() AFTER the ticket row
// is inserted (still inside the placement tx). That increments the
// running open_liability_micro counter and writes the event_log row
// with the freshly-minted ticket_id.
//
// Liability model — per the user's brief, we don't simulate joint
// scenarios across correlated markets. Instead, for each (market,
// outcome) bucket the bet touches, we ask: "what's the operator's
// worst-case loss IF that outcome wins?" Combos and BetBuilder charge
// the FULL ticket potential payout to every (market, outcome) bucket
// they touch — overestimates liability, but errs on the side of safety
// (no scenario can make us pay more than the bucket says).

import { sql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";
import { riskzillaEventLog } from "@oddzilla/db";

// Currency that RiskZilla manages. OZ is a demo currency with no
// real-money exposure; OZ placements bypass RiskZilla entirely.
export const RISKZILLA_CURRENCY = "USDC" as const;

export type RiskzillaDecision =
  | "accepted"
  | "rejected_min_stake"
  | "rejected_max_payout"
  | "rejected_match_liability"
  | "rejected_bet_factor"
  | "rejected_bank_limit"
  | "rejected_user_blocked"
  | "rejected_market_factor";

export interface RiskzillaIntentLeg {
  marketId: bigint;
  outcomeId: string;
  // Internal denormalised values resolved from the catalog by the caller
  // (BetsService already has them in scope after its existing per-leg
  // SELECT). Passing them in keeps the engine free of duplicate joins.
  matchId: bigint;
  providerMarketId: number;
  sportId: number;
  tournamentId: number;
  riskTier: number | null;
}

export interface RiskzillaIntent {
  userId: string;
  currency: string;
  stakeMicro: bigint;
  potentialPayoutMicro: bigint;
  legs: RiskzillaIntentLeg[];
  // Resolved by the caller from `users` row (authoritative).
  userStatus: string;
  userRiskScore: number;
}

export interface RiskzillaAccepted {
  decision: "accepted";
  meta: RiskzillaDecisionMeta;
}

export interface RiskzillaRejected {
  decision: Exclude<RiskzillaDecision, "accepted">;
  reason: string;
  meta: RiskzillaDecisionMeta;
}

export type RiskzillaResult = RiskzillaAccepted | RiskzillaRejected;

export interface RiskzillaDecisionMeta {
  // The first-leg's tier (used for top-level min stake / max payout
  // gates). Multi-leg combos use the strictest tier across legs for the
  // match-liability check, but a single tier carries the placement-time
  // floor / ceiling settings.
  effectiveTier: number;
  effectiveMinBetMicro: string;
  effectiveMaxPayoutMicro: string;
  effectiveBetFactor: string;
  bankLimitMicro: string;
  openLiabilityMicroBefore: string;
  // Sum of every user's USDC wallet `balance_micro` at decision time.
  // Subtracted from bank_limit alongside open_liability to compute the
  // operator's free capacity — bettors could withdraw their balances on
  // demand, so the bank's risk capital is everything we configured the
  // limit at MINUS what we already owe bettors.
  userBalancesMicro: string;
  freeCapacityMicroBefore: string;
  // Per-(match, market, outcome) bucket breakdown. Only includes
  // buckets the bet touches. Useful for the betticker decision panel.
  buckets: Array<{
    matchId: string;
    marketId: string;
    providerMarketId: number;
    outcomeId: string;
    tier: number;
    marketFactor: string;
    matchLiabilityCapMicro: string;
    bettorCapMicro: string;
    bucketLiabilityBeforeMicro: string;
    bucketLiabilityAfterMicro: string;
    bettorBucketLiabilityBeforeMicro: string;
    bettorBucketLiabilityAfterMicro: string;
  }>;
}

interface BucketRow {
  market_id: string;
  outcome_id: string;
  payout_micro: string;
  stake_micro: string;
}

interface MarketSumRow {
  market_id: string;
  total_stake_micro: string;
}

interface SettingsRow {
  tier: number;
  match_liability_micro: string;
  min_bet_micro: string;
  max_payout_micro: string;
  bet_factor: string;
}

interface MarketFactorRow {
  provider_market_id: number;
  factor: string;
}

interface BankRow {
  bank_limit_micro: string;
  open_liability_micro: string;
}

function bigintMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

// Multiply a bigint by a decimal factor in [0, 1]. We treat the factor
// as a 4-decimal fraction (matches the NUMERIC(4,3) / (5,4) precision
// used in our config tables) and floor the result.
function multiplyMicroByFactor(amountMicro: bigint, factor: number): bigint {
  if (!Number.isFinite(factor) || factor <= 0) return 0n;
  if (factor >= 1) return amountMicro;
  const scaled = BigInt(Math.round(factor * 10_000));
  return (amountMicro * scaled) / 10_000n;
}

// `tx` is a Drizzle pgx transaction handle (or the raw db client when
// called outside a tx — e.g. for rejection logging).
type SqlRunner = DbClient | Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export class RiskzillaEngine {
  constructor(private readonly db: DbClient) {}

  /**
   * Pre-bet evaluation. Pure read; safe to call inside the placement tx
   * without write-locking RiskZilla rows. Use commitAccepted() to
   * persist the new ticket's contribution.
   */
  async evaluate(tx: SqlRunner, intent: RiskzillaIntent): Promise<RiskzillaResult> {
    // OZ demo currency is fenced at the engine boundary — no real-money
    // exposure, no bookkeeping. Caller still passes the intent so the
    // event_log can record the bypass if we ever want to.
    if (intent.currency !== RISKZILLA_CURRENCY) {
      return {
        decision: "accepted",
        meta: this.emptyMeta({ reason: "non_riskzilla_currency" }),
      };
    }

    if (intent.userStatus !== "active") {
      return {
        decision: "rejected_user_blocked",
        reason: "account_not_active",
        meta: this.emptyMeta({ reason: "account_not_active" }),
      };
    }

    // ── Load configuration ────────────────────────────────────────
    const tiersInPlay = new Set<number>([0]);
    for (const leg of intent.legs) {
      if (leg.riskTier != null) tiersInPlay.add(leg.riskTier);
    }
    // Pass the int set as a Postgres array literal (`{0,10}`) cast to
    // int[]. Drizzle's `${array}` interpolation expands to `$1, $2, …`
    // — valid for `IN (...)` but NOT for `ANY(...)::int[]` (Postgres
    // would read `($1, $2)` as a row and refuse to cast it to int[]).
    // The literal-string approach sends the whole array as one param,
    // and Postgres parses it as a real array.
    const tiersLiteral = `{${[...tiersInPlay].join(",")}}`;
    const settingsRows = (await tx.execute(sql`
      SELECT tier,
             match_liability_micro::text,
             min_bet_micro::text,
             max_payout_micro::text,
             bet_factor::text
        FROM riskzilla_settings
       WHERE tier = ANY(${tiersLiteral}::int[])
    `)) as unknown as SettingsRow[];
    const settingsByTier = new Map<number, SettingsRow>();
    for (const r of settingsRows) settingsByTier.set(Number(r.tier), r);
    const fallback = settingsByTier.get(0);
    if (!fallback) {
      throw new Error("riskzilla_settings_global_missing");
    }
    const tierFor = (leg: RiskzillaIntentLeg): SettingsRow => {
      if (leg.riskTier == null) return fallback;
      return settingsByTier.get(leg.riskTier) ?? fallback;
    };

    const providerMarketIds = Array.from(
      new Set(intent.legs.map((l) => l.providerMarketId)),
    );
    const providerMarketIdsLiteral = `{${providerMarketIds.join(",")}}`;
    const factorRows = (await tx.execute(sql`
      SELECT provider_market_id, factor::text
        FROM riskzilla_market_factors
       WHERE provider_market_id = ANY(${providerMarketIdsLiteral}::int[])
    `)) as unknown as MarketFactorRow[];
    const factorByProvider = new Map<number, number>();
    for (const r of factorRows) {
      factorByProvider.set(Number(r.provider_market_id), Number(r.factor));
    }

    const bankRows = (await tx.execute(sql`
      SELECT bank_limit_micro::text, open_liability_micro::text
        FROM riskzilla_bank_state
       WHERE id = 'default'
       LIMIT 1
    `)) as unknown as BankRow[];
    if (bankRows.length === 0) {
      throw new Error("riskzilla_bank_state_missing");
    }
    const bankLimit = BigInt(bankRows[0]!.bank_limit_micro);
    const openLiability = BigInt(bankRows[0]!.open_liability_micro);

    // Sum of every USDC wallet's AVAILABLE balance (balance − locked).
    // Locked stakes are already committed to open bets and their
    // potential payouts are counted in open_liability — including the
    // locked portion in user_balances would double-charge the same
    // dollars (once as "withdrawable" and again as "potential payout").
    // Available is what bettors could ACTUALLY withdraw on demand.
    // Computing this on the fly is cheap at MVP scale (~10K wallets);
    // for higher scale we'd cache the sum on the bank_state row and
    // bump it on every wallet mutation.
    const balanceRows = (await tx.execute(sql`
      SELECT COALESCE(SUM(balance_micro - locked_micro), 0)::text AS total
        FROM wallets
       WHERE currency = ${RISKZILLA_CURRENCY}
    `)) as unknown as Array<{ total: string }>;
    const userBalances = BigInt(balanceRows[0]?.total ?? "0");
    const freeCapacityBefore = bankLimit - userBalances - openLiability;

    // ── Per-leg gates: min stake, max payout, market factor =0 ──────
    // First-leg tier governs min/max for the ticket as a whole.
    const firstTier = tierFor(intent.legs[0]!);
    const minBet = BigInt(firstTier.min_bet_micro);
    const maxPayout = BigInt(firstTier.max_payout_micro);

    const baseMeta = {
      effectiveTier: Number(firstTier.tier),
      effectiveMinBetMicro: minBet.toString(),
      effectiveMaxPayoutMicro: maxPayout.toString(),
      effectiveBetFactor: firstTier.bet_factor,
      bankLimitMicro: bankLimit.toString(),
      openLiabilityMicroBefore: openLiability.toString(),
      userBalancesMicro: userBalances.toString(),
      freeCapacityMicroBefore: freeCapacityBefore.toString(),
    };

    if (intent.stakeMicro < minBet) {
      return {
        decision: "rejected_min_stake",
        reason: "stake_below_min",
        meta: { ...baseMeta, buckets: [] },
      };
    }
    if (intent.potentialPayoutMicro > maxPayout) {
      return {
        decision: "rejected_max_payout",
        reason: "payout_above_max",
        meta: { ...baseMeta, buckets: [] },
      };
    }

    // factor=0 means "this market type is suspended for liability".
    // We surface a distinct rejection so admins can see a market they
    // turned off cold-rejecting bets in the betticker.
    for (const leg of intent.legs) {
      const factor = factorByProvider.get(leg.providerMarketId) ?? 1;
      if (factor <= 0) {
        return {
          decision: "rejected_market_factor",
          reason: "market_factor_zero",
          meta: { ...baseMeta, buckets: [] },
        };
      }
    }

    // ── Per-(market, outcome) liability buckets ─────────────────────
    // Pull current bucket sums for every match touched. We do this
    // once per match (not per leg) to amortise the scan; combos
    // typically touch ≤ 10 matches.
    const matchIds = Array.from(new Set(intent.legs.map((l) => l.matchId.toString())));
    const matchIdsLiteral = `{${matchIds.join(",")}}`;
    const bucketRows = (await tx.execute(sql`
      SELECT ts.market_id::text         AS market_id,
             ts.outcome_id              AS outcome_id,
             COALESCE(SUM(t.potential_payout_micro), 0)::text AS payout_micro,
             COALESCE(SUM(t.stake_micro),            0)::text AS stake_micro
        FROM tickets t
        JOIN ticket_selections ts ON ts.ticket_id = t.id
        JOIN markets m            ON m.id = ts.market_id
       WHERE m.match_id = ANY(${matchIdsLiteral}::bigint[])
         AND t.status IN ('accepted', 'pending_delay')
         AND t.currency = ${RISKZILLA_CURRENCY}
       GROUP BY ts.market_id, ts.outcome_id
    `)) as unknown as BucketRow[];

    const marketSumRows = (await tx.execute(sql`
      SELECT ts.market_id::text AS market_id,
             COALESCE(SUM(t.stake_micro), 0)::text AS total_stake_micro
        FROM tickets t
        JOIN ticket_selections ts ON ts.ticket_id = t.id
        JOIN markets m            ON m.id = ts.market_id
       WHERE m.match_id = ANY(${matchIdsLiteral}::bigint[])
         AND t.status IN ('accepted', 'pending_delay')
         AND t.currency = ${RISKZILLA_CURRENCY}
       GROUP BY ts.market_id
    `)) as unknown as MarketSumRow[];

    // Per-bettor bucket sums (for the bet_factor cap).
    const bettorBucketRows = (await tx.execute(sql`
      SELECT ts.market_id::text         AS market_id,
             ts.outcome_id              AS outcome_id,
             COALESCE(SUM(t.potential_payout_micro), 0)::text AS payout_micro,
             COALESCE(SUM(t.stake_micro),            0)::text AS stake_micro
        FROM tickets t
        JOIN ticket_selections ts ON ts.ticket_id = t.id
        JOIN markets m            ON m.id = ts.market_id
       WHERE m.match_id = ANY(${matchIdsLiteral}::bigint[])
         AND t.user_id = ${intent.userId}::uuid
         AND t.status IN ('accepted', 'pending_delay')
         AND t.currency = ${RISKZILLA_CURRENCY}
       GROUP BY ts.market_id, ts.outcome_id
    `)) as unknown as BucketRow[];

    const bucketKey = (mId: string, oId: string) => `${mId}:${oId}`;
    const payoutByBucket = new Map<string, bigint>();
    const stakeByBucket = new Map<string, bigint>();
    for (const r of bucketRows) {
      payoutByBucket.set(bucketKey(r.market_id, r.outcome_id), BigInt(r.payout_micro));
      stakeByBucket.set(bucketKey(r.market_id, r.outcome_id), BigInt(r.stake_micro));
    }
    const totalStakeByMarket = new Map<string, bigint>();
    for (const r of marketSumRows) {
      totalStakeByMarket.set(r.market_id, BigInt(r.total_stake_micro));
    }
    const bettorPayoutByBucket = new Map<string, bigint>();
    const bettorStakeByBucket = new Map<string, bigint>();
    for (const r of bettorBucketRows) {
      bettorPayoutByBucket.set(
        bucketKey(r.market_id, r.outcome_id),
        BigInt(r.payout_micro),
      );
      bettorStakeByBucket.set(
        bucketKey(r.market_id, r.outcome_id),
        BigInt(r.stake_micro),
      );
    }

    // Per-leg evaluation. For each leg we compute the bucket's
    // pre-bet liability and the post-bet liability (after we add
    // this ticket's payout to the (m, o) bucket and this ticket's
    // stake to the market sum). Reject as soon as any bucket
    // breaches.
    const meta: RiskzillaDecisionMeta = {
      ...baseMeta,
      buckets: [],
    };

    for (const leg of intent.legs) {
      const tier = tierFor(leg);
      const factor = factorByProvider.get(leg.providerMarketId) ?? 1;
      const baseMatchCap = BigInt(tier.match_liability_micro);
      const matchCap = multiplyMicroByFactor(baseMatchCap, factor);

      // Per-bettor cap: bet_factor × match_cap × RS. Ceiling at the
      // absolute match cap so a high RS can't push one bettor past the
      // everyone-combined pool. No automatic damping above RS 3 — the
      // RS knob is the operator's single point of control; if a bettor
      // shouldn't get the full multiplier, dial RS down explicitly.
      const betFactor = Number(tier.bet_factor);
      const bettorCapRaw = multiplyMicroByFactor(matchCap, betFactor * intent.userRiskScore);
      const bettorCap = bigintMin(bettorCapRaw, matchCap);

      const key = bucketKey(leg.marketId.toString(), leg.outcomeId);
      const payoutBefore = payoutByBucket.get(key) ?? 0n;
      const stakeBucketBefore = stakeByBucket.get(key) ?? 0n;
      const totalStakeMarketBefore =
        totalStakeByMarket.get(leg.marketId.toString()) ?? 0n;

      // Per-our-formula liability for THIS bucket pre-bet:
      //   liability_before = payoutBefore − (totalStakeMarketBefore − stakeBucketBefore)
      // post-bet (we add this leg's full ticket payout to bucket, this
      // leg's stake to market):
      //   liability_after = (payoutBefore + ticketPayout) − ((totalStakeMarketBefore + stake) − (stakeBucketBefore + stake))
      //                   =  payoutBefore + ticketPayout − totalStakeMarketBefore + stakeBucketBefore
      // The new stake cancels in the (market_total - bucket_stake)
      // term, so the incremental liability is exactly +ticketPayout.
      const liabilityBefore = bigintMax(
        0n,
        payoutBefore - (totalStakeMarketBefore - stakeBucketBefore),
      );
      const liabilityAfter = bigintMax(
        0n,
        payoutBefore + intent.potentialPayoutMicro - totalStakeMarketBefore + stakeBucketBefore,
      );

      const bettorPayoutBefore = bettorPayoutByBucket.get(key) ?? 0n;
      const bettorStakeBucketBefore = bettorStakeByBucket.get(key) ?? 0n;
      const bettorTotalStakeMarketBefore = await this.bettorTotalStakeOnMarket(
        tx,
        intent.userId,
        leg.marketId,
      );
      const bettorLiabilityBefore = bigintMax(
        0n,
        bettorPayoutBefore - (bettorTotalStakeMarketBefore - bettorStakeBucketBefore),
      );
      const bettorLiabilityAfter = bigintMax(
        0n,
        bettorPayoutBefore + intent.potentialPayoutMicro - bettorTotalStakeMarketBefore + bettorStakeBucketBefore,
      );

      const bucketEntry = {
        matchId: leg.matchId.toString(),
        marketId: leg.marketId.toString(),
        providerMarketId: leg.providerMarketId,
        outcomeId: leg.outcomeId,
        tier: Number(tier.tier),
        marketFactor: factor.toFixed(3),
        matchLiabilityCapMicro: matchCap.toString(),
        bettorCapMicro: bettorCap.toString(),
        bucketLiabilityBeforeMicro: liabilityBefore.toString(),
        bucketLiabilityAfterMicro: liabilityAfter.toString(),
        bettorBucketLiabilityBeforeMicro: bettorLiabilityBefore.toString(),
        bettorBucketLiabilityAfterMicro: bettorLiabilityAfter.toString(),
      };
      meta.buckets.push(bucketEntry);

      if (liabilityAfter > matchCap) {
        return {
          decision: "rejected_match_liability",
          reason: "match_liability_exceeded",
          meta,
        };
      }
      if (bettorLiabilityAfter > bettorCap) {
        return {
          decision: "rejected_bet_factor",
          reason: "bettor_match_share_exceeded",
          meta,
        };
      }
    }

    // ── Bank limit gate ─────────────────────────────────────────────
    // The bank limit is a hard ceiling on TOTAL operator exposure
    // including bettor balances (which are withdrawable on demand).
    // Stricter check: bettor wallets + open liability + this bet's
    // worst-case payout must all fit under the configured limit. Risk
    // example we want to reject: bank=1000, sum_user_balances=950,
    // open_liability=0, new bet potential payout=1000. The naive check
    // (open + new ≤ bank) accepts and leaves us with 50 of free
    // operator capital after a 1000-payout win — we'd be at risk-of-
    // ruin on a single roll. The stricter check rejects upfront.
    const bankIncremental = intent.potentialPayoutMicro;
    if (userBalances + openLiability + bankIncremental > bankLimit) {
      return {
        decision: "rejected_bank_limit",
        reason: "bank_limit_exceeded",
        meta,
      };
    }

    return { decision: "accepted", meta };
  }

  /**
   * Persist the accepted ticket's risk impact: bump the running
   * open_liability counter and write the event_log row. Must be
   * called inside the same tx that inserted the ticket row.
   */
  async commitAccepted(
    tx: SqlRunner,
    ticketId: string,
    intent: RiskzillaIntent,
    result: RiskzillaAccepted,
    matchContext: MatchContext,
  ): Promise<void> {
    if (intent.currency !== RISKZILLA_CURRENCY) {
      // Skipped — engine bypassed for OZ demo currency.
      return;
    }

    // Increment open_liability by the sum of incremental bucket
    // contributions (already constrained against bank_limit by
    // evaluate()). Conservative: add the ticket's full potential
    // payout once. Mirrors the SQL we'd run if we recomputed from
    // scratch — close enough for MVP.
    const incremental = intent.potentialPayoutMicro;
    await tx.execute(sql`
      UPDATE riskzilla_bank_state
         SET open_liability_micro = open_liability_micro + ${incremental.toString()}::bigint,
             updated_at = NOW()
       WHERE id = 'default'
    `);

    await tx.insert(riskzillaEventLog).values({
      ticketId,
      userId: intent.userId,
      decision: "accepted",
      reasonMessage: null,
      currency: intent.currency,
      stakeMicro: intent.stakeMicro,
      potentialPayoutMicro: intent.potentialPayoutMicro,
      matchId: matchContext.matchId,
      sportId: matchContext.sportId,
      tournamentId: matchContext.tournamentId,
      riskTier: matchContext.riskTier,
      rsAtDecision: intent.userRiskScore.toFixed(3),
      bankAtDecisionMicro: BigInt(result.meta.bankLimitMicro),
      decisionMeta: result.meta as unknown as Record<string, unknown>,
    });
  }

  /**
   * Write a rejection event_log row. Called OUTSIDE the rolled-back
   * placement tx so the rejection is durably recorded. Uses app.db,
   * not the rolled-back tx.
   */
  async recordRejection(
    intent: RiskzillaIntent,
    result: RiskzillaRejected,
    matchContext: MatchContext | null,
  ): Promise<void> {
    if (intent.currency !== RISKZILLA_CURRENCY) return;
    await this.db.insert(riskzillaEventLog).values({
      ticketId: null,
      userId: intent.userId,
      decision: result.decision,
      reasonMessage: result.reason,
      currency: intent.currency,
      stakeMicro: intent.stakeMicro,
      potentialPayoutMicro: intent.potentialPayoutMicro,
      matchId: matchContext?.matchId ?? null,
      sportId: matchContext?.sportId ?? null,
      tournamentId: matchContext?.tournamentId ?? null,
      riskTier: matchContext?.riskTier ?? null,
      rsAtDecision: intent.userRiskScore.toFixed(3),
      bankAtDecisionMicro: BigInt(result.meta.bankLimitMicro),
      decisionMeta: result.meta as unknown as Record<string, unknown>,
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private emptyMeta(extra: Record<string, unknown>): RiskzillaDecisionMeta {
    return {
      effectiveTier: 0,
      effectiveMinBetMicro: "0",
      effectiveMaxPayoutMicro: "0",
      effectiveBetFactor: "0.0000",
      bankLimitMicro: "0",
      openLiabilityMicroBefore: "0",
      userBalancesMicro: "0",
      freeCapacityMicroBefore: "0",
      buckets: [],
      ...(extra as object),
    } as RiskzillaDecisionMeta;
  }

  private async bettorTotalStakeOnMarket(
    tx: SqlRunner,
    userId: string,
    marketId: bigint,
  ): Promise<bigint> {
    const rows = (await tx.execute(sql`
      SELECT COALESCE(SUM(t.stake_micro), 0)::text AS total
        FROM tickets t
        JOIN ticket_selections ts ON ts.ticket_id = t.id
       WHERE ts.market_id = ${marketId.toString()}::bigint
         AND t.user_id = ${userId}::uuid
         AND t.status IN ('accepted', 'pending_delay')
         AND t.currency = ${RISKZILLA_CURRENCY}
    `)) as unknown as Array<{ total: string }>;
    return BigInt(rows[0]?.total ?? "0");
  }
}

export interface MatchContext {
  matchId: bigint | null;
  sportId: number | null;
  tournamentId: number | null;
  riskTier: number | null;
}
