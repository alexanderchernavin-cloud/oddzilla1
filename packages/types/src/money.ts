// Money is always stored and transported as micro-units (1 unit = 1e6
// micro). Matches ERC20 USDC on-chain decimals (6). The legacy `MicroUsdt`
// type name is retained so call-sites don't churn — the math is currency-
// agnostic; OZ uses the same precision.

const MICRO_PER_UNIT = 1_000_000n;
const MICRO_PER_UNIT_NUM = 1_000_000;

declare const MicroUnitBrand: unique symbol;
export type MicroUsdt = bigint & { readonly [MicroUnitBrand]: true };

export function toMicro(decimal: string | number): MicroUsdt {
  const asString = typeof decimal === "number" ? decimal.toString() : decimal;
  if (!/^-?\d+(\.\d+)?$/.test(asString)) {
    throw new Error(`invalid decimal: ${asString}`);
  }
  const negative = asString.startsWith("-");
  const unsigned = negative ? asString.slice(1) : asString;
  const [whole = "0", frac = ""] = unsigned.split(".");
  const paddedFrac = (frac + "000000").slice(0, 6);
  const combined = BigInt(whole) * MICRO_PER_UNIT + BigInt(paddedFrac);
  return (negative ? -combined : combined) as MicroUsdt;
}

export function fromMicro(m: MicroUsdt | bigint): string {
  const value = typeof m === "bigint" ? m : (m as bigint);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / MICRO_PER_UNIT;
  const frac = abs % MICRO_PER_UNIT;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  const body = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${body}` : body;
}

export function formatMicro(m: MicroUsdt | bigint, options: { sign?: boolean } = {}): string {
  const str = fromMicro(m);
  return options.sign && !str.startsWith("-") ? `+${str}` : str;
}

// Money-style 2-decimal renderer. `fromMicro` returns the full 6-decimal
// precision because some call-sites (settlement audit, ledger) need it;
// the admin tables and per-bettor dashboards just want a readable
// money figure. Pro-rated combo stakes (a 10 OZ 3-sport combo splits
// to 3.333333 OZ per sport) read terribly without this — hence the
// existence of this helper rather than a `.toFixed(2)` on every call
// site. Uses ROUND-HALF-AWAY-FROM-ZERO so 0.005 displays as "0.01".
export function fromMicroMoney(
  m: MicroUsdt | bigint,
  options: { sign?: boolean; decimals?: number } = {},
): string {
  const decimals = Math.max(0, Math.min(6, options.decimals ?? 2));
  const value = typeof m === "bigint" ? m : (m as bigint);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  // Round to `decimals` places: e.g. for 2 decimals we want 4-decimal
  // micro precision dropped. Shift micros by (6 - decimals), round
  // half-away-from-zero, then format.
  const dropPow = 6 - decimals;
  const divisor = 10n ** BigInt(dropPow);
  const half = divisor / 2n;
  const rounded = dropPow === 0 ? abs : (abs + half) / divisor;
  const scale = 10n ** BigInt(decimals);
  const whole = rounded / scale;
  const frac = rounded % scale;
  const body =
    decimals === 0
      ? whole.toString()
      : `${whole}.${frac.toString().padStart(decimals, "0")}`;
  if (negative) return `-${body}`;
  return options.sign ? `+${body}` : body;
}

export const MicroUsdt = {
  zero: 0n as MicroUsdt,
  one: MICRO_PER_UNIT as MicroUsdt,
  decimals: 6,
  perUnit: MICRO_PER_UNIT,
  perUnitNumber: MICRO_PER_UNIT_NUM,
};

/**
 * Multiply a micro-amount by a decimal odds/multiplier value, returning
 * `floor(amount × odds)` in micro. Pure bigint math — avoids the 2^53
 * precision cliff that hits `BigInt(Math.floor(Number(stake) * odds))`
 * for high-stake combos (a 20-leg combo at 5.0/leg has product 9.5e13;
 * `Number(1e10 micro) * 9.5e13 = 9.5e23`, far above `Number.MAX_SAFE_INTEGER`).
 *
 * Odds are quantized to 4 decimals (`ODDS_FIXED_SCALE = 10_000`) before
 * multiplication, matching the publishing precision (`NUMERIC(10,4)`)
 * for outcome rows. Returns floor — we never want to over-credit.
 */
const ODDS_FIXED_SCALE = 10_000n;

export function multiplyMicroByOdds(
  amountMicro: bigint,
  odds: number | string,
): bigint {
  const oddsNum = typeof odds === "number" ? odds : Number(odds);
  if (!Number.isFinite(oddsNum) || oddsNum < 0) {
    throw new Error(`invalid odds: ${odds}`);
  }
  const scaled = BigInt(Math.round(oddsNum * 10_000));
  const product = amountMicro * scaled;
  // bigint integer division floors toward zero; amounts are non-negative
  // in every payout site we use this from, so floor(/ 10000) is correct.
  return product / ODDS_FIXED_SCALE;
}
