import { pgEnum } from "drizzle-orm/pg-core";

export const userStatusEnum = pgEnum("user_status", ["active", "blocked", "pending_kyc"]);
export const userRoleEnum = pgEnum("user_role", ["user", "admin", "support"]);
export const kycStatusEnum = pgEnum("kyc_status", ["none", "pending", "approved", "rejected"]);

export const walletTxTypeEnum = pgEnum("wallet_tx_type", [
  "deposit",
  "withdrawal",
  "bet_stake",
  "bet_payout",
  "bet_refund",
  "adjustment",
  "cashout",
]);
export const chainNetworkEnum = pgEnum("chain_network", ["TRC20", "ERC20"]);
// Legacy deposits table status. Kept for the dormant `deposits` table —
// migration 0032 stopped writing to it but did not DROP it.
export const depositStatusEnum = pgEnum("deposit_status", ["seen", "confirming", "credited", "orphaned"]);
// Migration 0032: user-submitted tx-hash claim lifecycle. The
// wallet-watcher polls pending/confirming rows, validates the on-chain
// USDC Transfer, counts confirmations, and either credits or rejects.
export const depositIntentStatusEnum = pgEnum("deposit_intent_status", [
  "pending",
  "confirming",
  "credited",
  "rejected",
]);
export const withdrawalStatusEnum = pgEnum("withdrawal_status", [
  "requested",
  "approved",
  "submitted",
  "confirmed",
  "failed",
  "cancelled",
]);

export const sportKindEnum = pgEnum("sport_kind", ["esport", "traditional"]);
export const matchStatusEnum = pgEnum("match_status", [
  "not_started",
  "live",
  "closed",
  "cancelled",
  "suspended",
]);

export const outcomeResultEnum = pgEnum("outcome_result", [
  "won",
  "lost",
  "void",
  "half_won",
  "half_lost",
]);
export const ticketStatusEnum = pgEnum("ticket_status", [
  "pending_delay",
  "accepted",
  "rejected",
  "settled",
  "voided",
  "cashed_out",
]);
export const betTypeEnum = pgEnum("bet_type", [
  "single",
  "combo",
  "system",
  "tiple",
  "tippot",
  // 0031_betbuilder.sql — Oddin BetBuilder same-match combo. Carries
  // session_id + frozen session odds in tickets.bet_meta, like tiple /
  // tippot. Settlement does NOT multiply per-leg odds; payout is
  // stake × session_odds when all legs win, refund on any void leg, 0 on
  // any loss.
  "betbuilder",
]);
export const settlementTypeEnum = pgEnum("settlement_type", [
  "settle",
  "cancel",
  "rollback_settle",
  "rollback_cancel",
]);

export const oddsScopeEnum = pgEnum("odds_scope", ["global", "sport", "tournament", "market_type"]);
export const mappingStatusEnum = pgEnum("mapping_status", ["pending", "approved", "rejected"]);

export const cashoutStatusEnum = pgEnum("cashout_status", [
  "offered",
  "accepted",
  "declined",
  "expired",
  "errored",
  "unavailable",
]);

// 0042_community_analyses.sql — pre-match editorial posts.
// 'draft' is reserved for a future autosave flow; the API only writes
// 'published'. 'banned' = moderation outcome, 'voided' = match never
// started so the analysis lost its context.
export const analysisStatusEnum = pgEnum("analysis_status", [
  "draft",
  "published",
  "banned",
  "voided",
]);

// Outcome of an analysis = outcome of its attached ticket. Mirrors
// ticket settlement granularity rather than collapsing cashed_out
// into 'won' so reward logic can apply the cashout-voids-reward rule
// (Tipsport convention; see Notion: Publisher rewards philosophy).
export const analysisOutcomeEnum = pgEnum("analysis_outcome", [
  "won",
  "lost",
  "void",
  "cashed_out_void",
]);
