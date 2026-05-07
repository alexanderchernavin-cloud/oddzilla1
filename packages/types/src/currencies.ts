// Supported wallet currencies. Stored as CHAR(4) in Postgres.
//
// USDC — real money on ERC20 (migration 0032 renamed from USDT).
// OZ   — demo currency for testing bet calculation, the bet slip, and
//        settlement end-to-end without touching real funds. Every new
//        user signs up with 1000 OZ. Deposits and withdrawals are
//        USDC-only.

export const SUPPORTED_CURRENCIES = ["USDC", "OZ"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export const DEFAULT_CURRENCY: Currency = "USDC";

// Demo signup bonus — 1000 OZ in micro units.
export const SIGNUP_BONUS_OZ_MICRO = 1_000_000_000n; // 1000 * 1e6

export function isCurrency(v: unknown): v is Currency {
  return typeof v === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(v);
}
