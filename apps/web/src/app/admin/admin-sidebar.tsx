"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { I } from "@/components/ui/icons";
import { Logo, Wordmark } from "@/components/ui/monogram";
import { LogoutButton } from "@/components/logout-button";
import { ThemeToggle } from "@/components/shell/theme-toggle";

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
      { href: "/admin/deposits", label: "Deposits", Icon: I.Wallet, matchPrefix: "/admin/deposits" },
      { href: "/admin/withdrawals", label: "Withdrawals", Icon: I.Wallet, matchPrefix: "/admin/withdrawals" },
      { href: "/admin/audit", label: "Audit", Icon: I.Clock, matchPrefix: "/admin/audit" },
      { href: "/admin/feed", label: "Feed", Icon: I.Live, matchPrefix: "/admin/feed" },
      { href: "/admin/logs", label: "Logs", Icon: I.Bell, matchPrefix: "/admin/logs" },
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

  useEffect(() => {
    setCollapsed(readCollapsed());
    setHydrated(true);
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
}: {
  section: Section;
  collapsed: boolean;
  pathname: string;
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
}: {
  href: string;
  label: string;
  Icon: (p: { size?: number }) => ReactNode;
  collapsed: boolean;
  active: boolean;
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

  return (
    <Link
      href={href}
      style={baseStyle}
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={16} />
      {!collapsed && (
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </span>
      )}
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
