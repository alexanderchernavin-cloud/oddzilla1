"use client";

// Currency switch at the top of every RiskZilla page. USDC is the
// real-money operator view (default); OZ is the demo currency.
// Choice rides in the URL (`?cur=USDC|OZ`) so server pages can read
// it on render, and gets mirrored to localStorage on every change so
// a fresh visit to /admin/riskzilla without ?cur respects the last
// pick once the client hydrates.
//
// We also expose helper hooks (`useRiskzillaCurrency`) so the
// Bets/Betticker/Bettors client components can read the same value
// without prop-drilling.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";

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

export function useRiskzillaCurrency(): RzCurrency {
  const sp = useSearchParams();
  return normalizeRzCurrency(sp?.get(RZ_CURRENCY_PARAM));
}

export function RiskzillaCurrencySwitch() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const current = normalizeRzCurrency(sp?.get(RZ_CURRENCY_PARAM));

  // On first mount, if the URL has no `cur` but localStorage holds a
  // prior choice, push it onto the URL so server pages render the
  // intended view. We only do this when the param is missing entirely
  // — never override an explicit URL.
  useEffect(() => {
    if (sp?.get(RZ_CURRENCY_PARAM)) return;
    const stored =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(RZ_CURRENCY_STORAGE);
    if (stored && stored !== RZ_DEFAULT_CURRENCY) {
      const normalized = normalizeRzCurrency(stored);
      const next = new URLSearchParams(sp?.toString() ?? "");
      next.set(RZ_CURRENCY_PARAM, normalized);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    }
    // Intentionally run once per pathname change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const onPick = (cur: RzCurrency) => {
    if (cur === current) return;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(RZ_CURRENCY_STORAGE, cur);
    }
    const next = new URLSearchParams(sp?.toString() ?? "");
    if (cur === RZ_DEFAULT_CURRENCY) {
      next.delete(RZ_CURRENCY_PARAM);
    } else {
      next.set(RZ_CURRENCY_PARAM, cur);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <div
      role="tablist"
      aria-label="View currency"
      style={{
        display: "inline-flex",
        gap: 0,
        padding: 2,
        border: "1px solid var(--color-border)",
        background: "var(--color-bg)",
        borderRadius: 8,
      }}
    >
      {RZ_CURRENCIES.map((cur) => {
        const active = current === cur;
        const label =
          cur === "USDC" ? "USDC · real money" : "OZ · demo";
        return (
          <button
            key={cur}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onPick(cur)}
            style={{
              height: 28,
              padding: "0 12px",
              border: "none",
              borderRadius: 6,
              background: active ? "var(--color-fg)" : "transparent",
              color: active ? "var(--color-bg)" : "var(--color-fg-muted)",
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              cursor: active ? "default" : "pointer",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// Server-side equivalent — read the same param off Next's
// `searchParams` prop without instantiating a client component.
// Server pages call this to pass the value down to the API.
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

// Helper for client components — produce the `?cur=…` suffix to
// append to an outbound API URL. Returns `""` for the default so we
// keep URLs clean.
export function rzCurrencyQueryFragment(cur: RzCurrency): string {
  return `currency=${cur}`;
}

// Hook to read the chosen currency and produce a stable label
// (the bare-string variant is convenient when assembling URLs).
export function useRiskzillaCurrencyState(): {
  currency: RzCurrency;
  queryFragment: string;
} {
  const currency = useRiskzillaCurrency();
  return useMemo(
    () => ({ currency, queryFragment: rzCurrencyQueryFragment(currency) }),
    [currency],
  );
}
