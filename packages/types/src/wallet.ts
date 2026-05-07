// Wallet API contract types. Money is bigint-as-string.

import type { Currency } from "./currencies.js";

// USDC on Ethereum is the only supported on-chain network. The TRC20
// value is retained in the DB enum for historical rows but new code
// should not produce it.
export type ChainNetwork = "ERC20";

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

export type DepositIntentStatus =
  | "pending"
  | "confirming"
  | "credited"
  | "rejected";

export type WithdrawalStatus =
  | "requested"
  | "approved"
  | "submitted"
  | "confirmed"
  | "failed"
  | "cancelled";

// Single shared receive address served to every user. The actual
// address is configured server-side via DEPOSIT_RECEIVE_ADDRESS.
export interface DepositAddress {
  network: ChainNetwork;
  address: string;
  // Currency the user is expected to send. Surfaced so the UI can
  // render "Send USDC on ERC20" without hard-coding labels.
  currency: Currency;
}

export interface DepositAddressResponse {
  address: DepositAddress | null;
  // When the operator has not configured a receive address yet, the
  // API returns null so the UI can render a "Deposits temporarily
  // unavailable" notice instead of an empty card.
  available: boolean;
}

export interface DepositIntentSummary {
  id: string;
  network: ChainNetwork;
  txHash: string;
  fromAddress: string | null;
  toAddress: string | null;
  amountMicro: string | null;
  blockNumber: string | null;
  confirmations: number;
  confirmationsRequired: number;
  status: DepositIntentStatus;
  failureReason: string | null;
  submittedAt: string;
  creditedAt: string | null;
  rejectedAt: string | null;
}

export interface DepositIntentListResponse {
  deposits: DepositIntentSummary[];
}

export interface DepositIntentRequest {
  txHash: string;
}

export interface WithdrawalRequest {
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

// Confirmation count the client can use for UI progress bars. Must
// match wallet-watcher's config so the numbers line up with on-chain
// events.
export const CONFIRMATIONS_REQUIRED: Record<ChainNetwork, number> = {
  ERC20: 12,
};

// User-linked sending wallet (migration 0033). Deposits arriving from
// a registered address are auto-credited by the wallet-watcher; the
// tx-hash paste form remains a fallback for unregistered senders.
export interface LinkedWalletAddress {
  id: string;
  network: ChainNetwork;
  address: string;
  label: string | null;
  createdAt: string;
}

export interface LinkedWalletListResponse {
  addresses: LinkedWalletAddress[];
}

export interface LinkedWalletRequest {
  address: string;
  label?: string;
}
