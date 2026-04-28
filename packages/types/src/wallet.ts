// Wallet API contract types. Money is bigint-as-string.

import type { Currency } from "./currencies.js";

export type ChainNetwork = "TRC20" | "ERC20";

export interface WalletSnapshot {
  currency: Currency;
  balanceMicro: string;
  lockedMicro: string;
  availableMicro: string;
}

export interface WalletListResponse {
  wallets: WalletSnapshot[];
}

export interface WalletLedgerEntryDto {
  id: string;
  currency: Currency;
  deltaMicro: string;
  type: string;
  refType: string | null;
  refId: string | null;
  txHash: string | null;
  memo: string | null;
  createdAt: string;
}

export interface WalletLedgerResponse {
  entries: WalletLedgerEntryDto[];
}

export type DepositStatus = "seen" | "confirming" | "credited" | "orphaned";
export type WithdrawalStatus =
  | "requested"
  | "approved"
  | "submitted"
  | "confirmed"
  | "failed"
  | "cancelled";

export interface DepositAddress {
  network: ChainNetwork;
  address: string;
}

export interface DepositAddressesResponse {
  addresses: DepositAddress[];
}

export interface DepositSummary {
  id: string;
  network: ChainNetwork;
  txHash: string;
  logIndex: number;
  toAddress: string;
  amountMicro: string;
  confirmations: number;
  confirmationsRequired: number;
  status: DepositStatus;
  blockNumber: string | null;
  seenAt: string;
  creditedAt: string | null;
}

export interface DepositListResponse {
  deposits: DepositSummary[];
}

export interface WithdrawalRequest {
  network: ChainNetwork;
  toAddress: string;
  amountMicro: string;
}

export interface WithdrawalSummary {
  id: string;
  network: ChainNetwork;
  toAddress: string;
  amountMicro: string;
  feeMicro: string;
  status: WithdrawalStatus;
  txHash: string | null;
  requestedAt: string;
  approvedAt: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  failureReason: string | null;
}

export interface WithdrawalListResponse {
  withdrawals: WithdrawalSummary[];
}

// Minimum Tron/Ethereum confirmation counts the client can use for UI
// progress bars. These must match wallet-watcher's config for the numbers
// to line up with on-chain events.
export const CONFIRMATIONS_REQUIRED: Record<ChainNetwork, number> = {
  TRC20: 19,
  ERC20: 12,
};
