"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { I } from "@/components/ui/icons";
import { Logo, Wordmark } from "@/components/ui/monogram";
import { LogoutButton } from "@/components/logout-button";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { clientApi, ApiFetchError } from "@/lib/api-client";

const STORAGE_KEY = "oz:admin-sidebar-collapsed";
const W_OPEN = 240;
const W_COLLAPSED = 56;

interface Item {
  href: string;
  label: string;
  Icon: (p: { size?: number }) => ReactNode;
  // Optional href prefix override for "active" matching. Defaults to
  // exact match on the canonical href; leaves nested admin routes
  // (e.g. /admin/users/:id) able to highlight their parent entry.
  matchPrefix?: string;
  // Key identifying a runtime badge count source. The sidebar polls
  // the matching count and renders a numeric pill on the link.
  // Currently only "deposits-alerts" is wired.
  badgeKey?: "deposits-alerts";
}

interface Section {
  label: string;
  items: Item[];
}

const SECTIONS: Section[] = [
  {
    label: "Overview",
    items: [
      { href: "/admin", label: "Dashboard", Icon: I.Grid },
    ],
  },
  {
    label: "People",
    items: [
      { href: "/admin/users", label: "Bettors", Icon: I.User, matchPrefix: "/admin/users" },
      { href: "/admin/admins", label: "Admins", Icon: I.User, matchPrefix: "/admin/admins" },
    ],
  },
  {
    label: "Catalog",
    items: [
      { href: "/admin/mapping", label: "Mapping", Icon: I.Grid, matchPrefix: "/admin/mapping" },
      { href: "/admin/sports", label: "Sports", Icon: I.Live, matchPrefix: "/admin/sports" },
      { href: "/admin/competitors", label: "Teams", Icon: I.Trophy, matchPrefix: "/admin/competitors" },
      { href: "/admin/tournaments", label: "Tournaments", Icon: I.Star, matchPrefix: "/admin/tournaments" },
    ],
  },
  {
    label: "Risk & limits",
    items: [
      { href: "/admin/riskzilla", label: "RiskZilla", Icon: I.Live, matchPrefix: "/admin/riskzilla" },
      { href: "/admin/margins", label: "Margins", Icon: I.Filter, matchPrefix: "/admin/margins" },
      { href: "/admin/cashout", label: "Cashout", Icon: I.Wallet, matchPrefix: "/admin/cashout" },
      { href: "/admin/bet-products", label: "Products", Icon: I.Ticket, matchPrefix: "/admin/bet-products" },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        href: "/admin/deposits",
        label: "Deposits",
        Icon: I.Wallet,
        matchPrefix: "/admin/deposits",
        badgeKey: "deposits-alerts",
      },
      { href: "/admin/withdrawals", label: "Withdrawals", Icon: I.Wallet, matchPrefix: "/admin/withdrawals" },
      { href: "/admin/audit", label: "Audit", Icon: I.Clock, matchPrefix: "/admin/audit" },
      { href: "/admin/feed", label: "Feed", Icon: I.Live, matchPrefix: "/admin/feed" },
      {
        href: "/admin/wedged-matches",
        label: "Wedged matches",
        Icon: I.Clock,
        matchPrefix: "/admin/wedged-matches",
      },
      { href: "/admin/logs", label: "Logs", Icon: I.Bell, matchPrefix: "/admin/logs" },
      { href: "/admin/monitoring", label: "Performance", Icon: I.Activity, matchPrefix: "/admin/monitoring" },
    ],
  },
  {
    label: "Storefront",
    items: [
      {
        href: "/admin/fe-settings/markets-order",
        label: "FE Settings",
        Icon: I.Gear,
        matchPrefix: "/admin/fe-settings",
      },
      {
        href: "/admin/combi-boost",
        label: "Combi Boost",
        Icon: I.Star,
        matchPrefix: "/admin/combi-boost",
      },
      {
        href: "/admin/avatars",
        label: "Avatars",
        Icon: I.User,
        matchPrefix: "/admin/avatars",
      },
    ],
  },
  {
    label: "Community",
    items: [
      {
        href: "/admin/competitions",
        label: "Competitions",
        Icon: I.Trophy,
        matchPrefix: "/admin/competitions",
      },
    ],
  },
];

function readCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function isActive(pathname: string, item: Item): boolean {
  if (pathname === item.href) return true;
  if (item.matchPrefix && pathname.startsWith(item.matchPrefix + "/")) return true;
  // Edge case: dashboard ("/admin") shouldn't activate for any nested
  // admin path. Other items with no matchPrefix just rely on exact match.
  return false;
}

export function AdminSidebar() {
  const pathname = usePathname() ?? "";
  const [collapsed, setCollapsed] = useState(false);
  // Track whether we've read storage yet so the very first paint doesn't
  // flash the wrong state — null means "unknown, render based on initial
  // useState false but with no transition so the snap is invisible".
  const [hydrated, setHydrated] = useState(false);

  // Runtime badge counts. Poll every 60s while the admin shell is
  // mounted so a new wrong-token / unattributed alert shows up without
  // a manual refresh. One key today; the map shape leaves room for a
  // future mapping / withdrawals badge without another fetch loop.
  const [badges, setBadges] = useState<Record<string, number>>({});

  useEffect(() => {
    setCollapsed(readCollapsed());
    setHydrated(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const data = await clientApi<{ total: number }>(
          "/admin/deposits/alert-counts",
        );
        if (!cancelled) {
          setBadges((prev) => ({ ...prev, "deposits-alerts": data.total }));
        }
      } catch (e) {
        // 401/403 (not yet authed) is normal on first paint; anything
        // else is a transient failure — silently retry on the next tick.
        if (e instanceof ApiFetchError && e.status === 401) return;
      }
    }
    refresh();
    const t = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // storage disabled — collapse state just won't persist
      }
      return next;
    });
  };

  const width = collapsed ? W_COLLAPSED : W_OPEN;
  const containerStyle: CSSProperties = {
    width,
    minWidth: width,
    borderRight: "1px solid var(--color-border, var(--border))",
    background: "var(--color-bg, var(--bg))",
    display: "flex",
    flexDirection: "column",
    position: "sticky",
    top: 0,
    alignSelf: "flex-start",
    height: "100dvh",
    transition: hydrated ? "width 160ms var(--ease, ease)" : "none",
    overflow: "hidden",
  };

  return (
    <aside style={containerStyle} aria-label="Admin navigation">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: collapsed ? "16px 12px" : "16px 18px",
          borderBottom: "1px solid var(--color-border, var(--border))",
          minHeight: 64,
        }}
      >
        <BrandMark collapsed={collapsed} />
      </div>

      <nav
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "10px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {SECTIONS.map((section) => (
          <SidebarSection
            key={section.label}
            section={section}
            collapsed={collapsed}
            pathname={pathname}
            badges={badges}
          />
        ))}
      </nav>

      <div
        style={{
          borderTop: "1px solid var(--color-border, var(--border))",
          padding: "10px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <SidebarLink
          href="/account"
          label="Exit admin"
          Icon={I.Arrow}
          collapsed={collapsed}
          active={false}
        />
        <BottomActions collapsed={collapsed} />
        <CollapseToggle collapsed={collapsed} onClick={toggle} />
      </div>
    </aside>
  );
}

function BrandMark({ collapsed }: { collapsed: boolean }) {
  // Collapsed: just the round mark (the sidebar is too narrow for the
  // wordmark). Expanded: the landscape wordmark (which already carries
  // the "Oddzilla" word in brand typography) plus a small ADMIN tag
  // anchoring the backoffice context.
  if (collapsed) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          minWidth: 0,
        }}
      >
        <Logo size={32} priority />
      </div>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        minWidth: 0,
      }}
    >
      <Wordmark size={28} priority />
      <span
        className="mono"
        style={{
          fontSize: 10.5,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--color-fg-subtle, var(--fg-dim))",
          padding: "2px 6px",
          border: "1px solid var(--color-border, var(--border))",
          borderRadius: 4,
        }}
      >
        Admin
      </span>
    </div>
  );
}

function SidebarSection({
  section,
  collapsed,
  pathname,
  badges,
}: {
  section: Section;
  collapsed: boolean;
  pathname: string;
  badges: Record<string, number>;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {!collapsed && (
        <div
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--color-fg-subtle, var(--fg-dim))",
            padding: "4px 10px 6px",
          }}
        >
          {section.label}
        </div>
      )}
      {section.items.map((item) => (
        <SidebarLink
          key={item.href}
          href={item.href}
          label={item.label}
          Icon={item.Icon}
          collapsed={collapsed}
          active={isActive(pathname, item)}
          badge={item.badgeKey ? badges[item.badgeKey] : undefined}
        />
      ))}
    </div>
  );
}

function SidebarLink({
  href,
  label,
  Icon,
  collapsed,
  active,
  badge,
}: {
  href: string;
  label: string;
  Icon: (p: { size?: number }) => ReactNode;
  collapsed: boolean;
  active: boolean;
  badge?: number;
}) {
  const baseStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: collapsed ? "10px 0" : "8px 10px",
    justifyContent: collapsed ? "center" : "flex-start",
    borderRadius: 8,
    color: active
      ? "var(--color-fg, var(--fg))"
      : "var(--color-fg-muted, var(--fg-muted))",
    background: active
      ? "var(--color-bg-subtle, var(--surface-2))"
      : "transparent",
    fontSize: 13,
    fontWeight: active ? 600 : 500,
    textDecoration: "none",
    transition: "background 140ms var(--ease, ease), color 140ms var(--ease, ease)",
    whiteSpace: "nowrap",
    overflow: "hidden",
  };

  const hasBadge = typeof badge === "number" && badge > 0;
  const badgeStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 18,
    height: 18,
    padding: "0 5px",
    borderRadius: 9,
    background: "var(--color-negative, #c1342f)",
    color: "white",
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1,
  };

  return (
    <Link
      href={href}
      style={baseStyle}
      title={
        collapsed
          ? hasBadge
            ? `${label} (${badge})`
            : label
          : undefined
      }
      aria-current={active ? "page" : undefined}
    >
      <span
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={16} />
        {hasBadge && collapsed ? (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: -4,
              right: -6,
              width: 8,
              height: 8,
              borderRadius: 4,
              background: "var(--color-negative, #c1342f)",
              border: "2px solid var(--color-bg, var(--bg))",
            }}
          />
        ) : null}
      </span>
      {!collapsed && (
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            flex: 1,
          }}
        >
          {label}
        </span>
      )}
      {!collapsed && hasBadge ? <span style={badgeStyle}>{badge}</span> : null}
    </Link>
  );
}

function BottomActions({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        justifyContent: collapsed ? "center" : "flex-start",
        flexWrap: "wrap",
      }}
    >
      <ThemeToggle />
      <LogoutButton />
    </div>
  );
}

function CollapseToggle({
  collapsed,
  onClick,
}: {
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!collapsed}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        marginTop: 4,
        padding: collapsed ? "8px 0" : "8px 10px",
        background: "transparent",
        border: "1px solid var(--color-border, var(--border))",
        borderRadius: 8,
        color: "var(--color-fg-muted, var(--fg-muted))",
        fontFamily: "inherit",
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          transform: collapsed ? "none" : "rotate(180deg)",
          transition: "transform 160ms var(--ease, ease)",
        }}
      >
        <I.Chev size={14} />
      </span>
      {!collapsed && <span>Collapse</span>}
    </button>
  );
}
