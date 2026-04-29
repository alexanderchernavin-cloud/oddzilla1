// Cashout shared types. The actual algorithm lives in the api service
// (services/api/src/modules/cashout/algorithm.ts); these are just the
// wire-format contracts between the api, the frontend, and admin.

export type CashoutStatus =
  | "offered"
  | "accepted"
  | "declined"
  | "expired"
  | "errored"
  | "unavailable";

/**
 * One step of the deduction ladder from chapter 2.1.2 of Sportradar's
 * Cashout doc. `factor` is currentTicketValue/originalStake; `deduction`
 * is the divisor applied to the cashout offer (e.g. 1.05 = take 5% off).
 * Ladder is sorted ascending by `factor`; the lookup interpolates between
 * neighbouring rows.
 */
export interface CashoutLadderStep {
  factor: number;
  deduction: number;
}

export type CashoutScope = "global" | "sport" | "tournament" | "market_type";

export interface CashoutConfigEntry {
  id: number;
  scope: CashoutScope;
  scopeRefId: string | null;
  enabled: boolean;
  prematchFullPaybackSeconds: number;
  deductionLadderJson: CashoutLadderStep[] | null;
  minOfferMicro: string; // bigint as string
  minValueChangeBp: number;
  /**
   * Seconds the server holds an accepted cashout before commit. Mirrors
   * users.bet_delay_seconds for placement — a short window that lets
   * the bookmaker bail if the underlying odds drift beyond tolerance.
   * 0 = no delay.
   */
  acceptanceDelaySeconds: number;
  updatedAt: string; // ISO
  label?: string;
}

/** Reasons cashout might be unavailable (sent to client; do not surface
 *  raw values – the frontend localizes). */
export type CashoutUnavailableReason =
  | "not_open"
  | "feature_disabled"
  | "leg_inactive"
  | "leg_no_probability"
  | "leg_lost"
  | "below_minimum"
  | "below_change_threshold";

export interface CashoutQuote {
  available: boolean;
  reason?: CashoutUnavailableReason;
  // Server-issued quote id; required when accepting.
  quoteId?: string;
  offerMicro?: string; // bigint as string
  // Components used for display + transparency.
  ticketStakeMicro: string;
  ticketOdds?: string;            // product of leg odds (decimal)
  probability?: string;           // product of current leg probabilities (decimal)
  ticketValueFairMicro?: string;  // simple cashout = stake × odds × prob (no deduction)
  deductionFactor?: string;       // > 1 means lower offer; only set when ladder applied
  fullPayback?: boolean;          // true when offer = stake from prematch window
  expiresAt?: string;             // ISO; quote becomes invalid after this
  /**
   * Seconds the server will wait between accept-click and money-moves
   * (resolved cashout_config.acceptance_delay_seconds across legs).
   * Frontend uses this to render a countdown.
   */
  acceptanceDelaySeconds?: number;
}

export interface CashoutAcceptRequest {
  quoteId: string;
  expectedOfferMicro: string; // sanity: client confirms what it saw
}

export interface CashoutAcceptResponse {
  ticketId: string;
  payoutMicro: string;
  cashedOutAt: string; // ISO
}
