"use client";

// RiskZilla tab strip. Lives in a client component so it can preserve
// the currency selection (`?cur=…`) and any other already-set search
// params as the user clicks between tabs. Tabs use `<Link>` so prefetch
// and back/forward continue to work.

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { RZ_CURRENCY_PARAM, normalizeRzCurrency } from "./currency-switch";

const TABS = [
  { href: "/admin/riskzilla", label: "Dashboard" },
  { href: "/admin/riskzilla/settings", label: "Settings" },
  { href: "/admin/riskzilla/market-factors", label: "Market factors" },
  { href: "/admin/riskzilla/bank", label: "Bank" },
  { href: "/admin/riskzilla/betticker", label: "Betticker" },
  { href: "/admin/riskzilla/bets", label: "Bets" },
  { href: "/admin/riskzilla/bettors", label: "Bettors" },
];

export function RiskzillaTabs() {
  const pathname = usePathname();
  const sp = useSearchParams();
  // We carry only the currency param across tabs — page-specific
  // filters (status, riskTier, date range, stake range, etc.) reset
  // when you switch tabs, which matches the existing behaviour.
  const cur = normalizeRzCurrency(sp?.get(RZ_CURRENCY_PARAM));
  const suffix = cur === "USDC" ? "" : `?${RZ_CURRENCY_PARAM}=${cur}`;

  return (
    <nav
      style={{
        display: "flex",
        gap: 4,
        flexWrap: "wrap",
        borderBottom: "1px solid var(--color-border, var(--border))",
        marginBottom: 24,
        paddingBottom: 6,
      }}
    >
      {TABS.map((t) => {
        const active =
          pathname === t.href ||
          (t.href !== "/admin/riskzilla" && pathname?.startsWith(t.href));
        return (
          <Link
            key={t.href}
            href={`${t.href}${suffix}`}
            style={{
              fontSize: 13,
              padding: "6px 10px",
              borderRadius: 6,
              color: active ? "var(--color-fg)" : "var(--color-fg-muted)",
              background: active ? "var(--color-bg-subtle)" : "transparent",
              fontWeight: active ? 600 : 400,
              textDecoration: "none",
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
