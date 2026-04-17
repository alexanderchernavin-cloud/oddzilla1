// Money is always stored and transported as micro-USDT (1 USDT = 1e6 micro).
// Matches TRC20/ERC20 USDT on-chain decimals (6). Never use number for money.

const MICRO_PER_USDT = 1_000_000n;
const MICRO_PER_USDT_NUM = 1_000_000;

declare const MicroUsdtBrand: unique symbol;
export type MicroUsdt = bigint & { readonly [MicroUsdtBrand]: true };

export function toMicro(decimal: string | number): MicroUsdt {
  const asString = typeof decimal === "number" ? decimal.toString() : decimal;
  if (!/^-?\d+(\.\d+)?$/.test(asString)) {
    throw new Error(`invalid decimal: ${asString}`);
  }
  const negative = asString.startsWith("-");
  const unsigned = negative ? asString.slice(1) : asString;
  const [whole = "0", frac = ""] = unsigned.split(".");
  const paddedFrac = (frac + "000000").slice(0, 6);
  const combined = BigInt(whole) * MICRO_PER_USDT + BigInt(paddedFrac);
  return (negative ? -combined : combined) as MicroUsdt;
}

export function fromMicro(m: MicroUsdt | bigint): string {
  const value = typeof m === "bigint" ? m : (m as bigint);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / MICRO_PER_USDT;
  const frac = abs % MICRO_PER_USDT;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  const body = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${body}` : body;
}

export function formatMicro(m: MicroUsdt | bigint, options: { sign?: boolean } = {}): string {
  const str = fromMicro(m);
  return options.sign && !str.startsWith("-") ? `+${str}` : str;
}

export const MicroUsdt = {
  zero: 0n as MicroUsdt,
  one: MICRO_PER_USDT as MicroUsdt,
  decimals: 6,
  perUnit: MICRO_PER_USDT,
  perUnitNumber: MICRO_PER_USDT_NUM,
};
