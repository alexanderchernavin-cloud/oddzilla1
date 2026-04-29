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
export const depositStatusEnum = pgEnum("deposit_status", ["seen", "confirming", "credited", "orphaned"]);
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
export const betTypeEnum = pgEnum("bet_type", ["single", "combo", "system", "tiple", "tippot"]);
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
