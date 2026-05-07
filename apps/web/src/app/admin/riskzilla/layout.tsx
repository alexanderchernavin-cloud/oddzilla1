import Link from "next/link";
import type { ReactNode } from "react";

const TABS = [
  { href: "/admin/riskzilla", label: "Dashboard" },
  { href: "/admin/riskzilla/settings", label: "Settings" },
  { href: "/admin/riskzilla/market-factors", label: "Market factors" },
  { href: "/admin/riskzilla/bank", label: "Bank" },
  { href: "/admin/riskzilla/betticker", label: "Betticker" },
  { href: "/admin/riskzilla/bets", label: "Bets" },
  { href: "/admin/riskzilla/bettors", label: "Bettors" },
];

// Visual hierarchy: top header sets the "RiskZilla" brand, then a tab
// strip switches between the seven sub-pages. Tab matching is left to
// the rendered page (active state would require usePathname which
// makes the layout client-side; prefer keeping it server-side and let
// each page render its own active style if it wants to).
export default function RiskzillaLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
        <h1 className="text-2xl font-semibold tracking-tight">RiskZilla</h1>
        <span
          className="mono"
          style={{
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--color-fg-subtle, var(--fg-dim))",
          }}
        >
          Internal risk management
        </span>
      </header>
      <p
        style={{
          fontSize: 13,
          color: "var(--color-fg-muted)",
          marginBottom: 16,
        }}
      >
        Per-tier liability caps, per-market factors, the operator
        bankroll, and a live decision feed for every bet placed against
        the storefront.
      </p>
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
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            style={{
              fontSize: 13,
              padding: "6px 10px",
              borderRadius: 6,
              color: "var(--color-fg)",
              textDecoration: "none",
            }}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div>{children}</div>
    </div>
  );
}
