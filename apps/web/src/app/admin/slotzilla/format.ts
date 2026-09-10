// Number <-> text helpers for the SlotZilla backoffice. Money and
// multipliers are parsed as STRINGS into integers (micro, basis points,
// hundredths) so a typed "0.1" never round-trips through a float on its
// way to a bigint column (invariant 1). Every parser returns null on
// input it will not vouch for; the caller turns that into a field error.

import type { LineKey, PaytableLines } from "@oddzilla/types/slotzilla";

const MICRO_PER_UNIT = 1_000_000n;

/** "12500000" → "12.5"; `minFrac` pads the fraction (2 for money displays). */
export function microToUnits(micro: string | number | null | undefined, minFrac = 0): string {
  if (micro === null || micro === undefined || micro === "") return "";
  let v: bigint;
  try {
    v = BigInt(micro);
  } catch {
    return String(micro);
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = (v / MICRO_PER_UNIT).toString();
  let frac = (v % MICRO_PER_UNIT).toString().padStart(6, "0").replace(/0+$/u, "");
  if (frac.length < minFrac) frac = frac.padEnd(minFrac, "0");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** "12.5" → "12500000"; null for anything but a non-negative decimal with at most 6 places. */
export function unitsToMicro(text: string): string | null {
  const t = text.trim();
  const m = /^(\d+)(?:\.(\d{0,6}))?$/u.exec(t);
  if (!m) return null;
  const whole = BigInt(m[1] ?? "0");
  const frac = BigInt((m[2] ?? "").padEnd(6, "0"));
  return (whole * MICRO_PER_UNIT + frac).toString();
}

/** "35" → 3500, "0.5" → 50, "" → null (absent line); null for more than two places or junk. */
export function multiplierToX100(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const m = /^(\d+)(?:\.(\d{0,2}))?$/u.exec(t);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** 9700 → "97"; 9725 → "97.25". */
export function bpToPercent(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return "";
  const whole = Math.trunc(bp / 100);
  const frac = Math.abs(bp % 100);
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/u, "")}`;
}

/** "97" → 9700; "97.25" → 9725; null for junk or more than two places. */
export function percentToBp(text: string): number | null {
  const t = text.trim();
  const m = /^(\d+)(?:\.(\d{0,2}))?$/u.exec(t);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** 9725 → "97.25%"; null → "—". */
export function formatBp(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return "—";
  return `${(bp / 100).toFixed(2).replace(/\.?0+$/u, "")}%`;
}

export function parseIntField(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/u.test(t)) return null;
  return Number(t);
}

/**
 * The corpus endpoints describe `byLine` as frequencies, but a raw count
 * per line is the other natural thing to return, and both are tolerated:
 * values summing past 1 are counts, divided by the round total (or by
 * their own sum when no total is known).
 */
export function normaliseLineFrequencies(
  byLine: Partial<Record<LineKey, number>> | null | undefined,
  rounds: number | null | undefined,
  keys: readonly LineKey[],
): Record<LineKey, number> {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<LineKey, number>;
  if (!byLine) return out;
  let sum = 0;
  for (const k of keys) {
    const v = byLine[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[k] = v;
      sum += v;
    }
  }
  if (sum > 1.0001) {
    const denom = rounds && rounds > 0 ? rounds : sum;
    for (const k of keys) out[k] = out[k] / denom;
  }
  return out;
}

/** The lines a saved paytable carries, dropping anything that is not a finite non-negative integer. */
export function cleanLines(lines: PaytableLines | null | undefined, keys: readonly LineKey[]): PaytableLines {
  const out: PaytableLines = {};
  if (!lines) return out;
  for (const k of keys) {
    const v = lines[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

export function formatRelativeSeconds(unixSeconds: number | null | undefined, nowMs: number): string {
  if (unixSeconds === null || unixSeconds === undefined) return "never";
  const ago = Math.max(0, Math.round(nowMs / 1000 - unixSeconds));
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86_400) return `${Math.floor(ago / 3600)}h ago`;
  return `${Math.floor(ago / 86_400)}d ago`;
}

export function formatIsoRelative(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return formatRelativeSeconds(t / 1000, nowMs);
}
