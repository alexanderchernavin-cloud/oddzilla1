// Currency constants + pure helpers for the RiskZilla admin pages.
//
// Lives in its own (non-"use client") module so server components can
// import `readRzCurrencyFromSearchParams` to forward the active
// currency to API calls. The React-only pieces — the visible toggle,
// the `useRiskzillaCurrency` hook, the tab strip — live in
// currency-switch.tsx + tabs.tsx and re-export the constants from
// here when convenient.

export const RZ_CURRENCY_PARAM = "cur";
export const RZ_CURRENCY_STORAGE = "oz:riskzilla:cur";
export const RZ_CURRENCIES = ["USDC", "OZ"] as const;
export type RzCurrency = (typeof RZ_CURRENCIES)[number];
export const RZ_DEFAULT_CURRENCY: RzCurrency = "USDC";

export function normalizeRzCurrency(raw: string | null | undefined): RzCurrency {
  if (!raw) return RZ_DEFAULT_CURRENCY;
  const up = raw.toUpperCase();
  return (RZ_CURRENCIES as readonly string[]).includes(up)
    ? (up as RzCurrency)
    : RZ_DEFAULT_CURRENCY;
}

// Server-side: read the `?cur=` param from Next's `searchParams` prop
// without instantiating a client component.
export function readRzCurrencyFromSearchParams(
  searchParams:
    | Record<string, string | string[] | undefined>
    | URLSearchParams
    | undefined,
): RzCurrency {
  if (!searchParams) return RZ_DEFAULT_CURRENCY;
  if (searchParams instanceof URLSearchParams) {
    return normalizeRzCurrency(searchParams.get(RZ_CURRENCY_PARAM));
  }
  const raw = searchParams[RZ_CURRENCY_PARAM];
  if (Array.isArray(raw)) return normalizeRzCurrency(raw[0]);
  return normalizeRzCurrency(raw);
}

// Tiny helper for assembling outbound query strings.
export function rzCurrencyQueryFragment(cur: RzCurrency): string {
  return `currency=${cur}`;
}
