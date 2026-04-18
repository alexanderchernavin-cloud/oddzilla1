"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { I } from "@/components/ui/icons";

interface SportItem {
  slug: string;
  name: string;
  kind: string;
  active: boolean;
}

interface SidebarProps {
  sports: SportItem[];
  liveCounts: Record<string, number>;
  signedIn: boolean;
  isAdmin: boolean;
}

export function Sidebar({ sports, liveCounts, signedIn, isAdmin }: SidebarProps) {
  const pathname = usePathname() ?? "/";
  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  };
  const totalLive = Object.values(liveCounts).reduce((a, n) => a + n, 0);

  return (
    <aside
      className="oz-side"
      style={{
        gridArea: "side",
        padding: "20px 14px",
        borderRight: "1px solid var(--hairline)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        overflow: "auto",
      }}
    >
      <Item href="/" icon={<I.Grid size={15} />} active={isActive("/")} label="Lobby" />
      <Item
        href="/live"
        icon={<I.Live size={15} />}
        active={isActive("/live")}
        label="Live"
        tag={totalLive > 0 ? String(totalLive) : undefined}
      />
      <Item
        href="/upcoming"
        icon={<I.Clock size={15} />}
        active={isActive("/upcoming")}
        label="Upcoming"
      />

      <SectionLabel>Sports</SectionLabel>
      {orderSports(sports).map((s) => (
        <Item
          key={s.slug}
          href={`/sport/${s.slug}`}
          icon={<SportGlyph sport={s.slug} size={16} />}
          active={isActive(`/sport/${s.slug}`)}
          label={s.name}
          tag={liveCounts[s.slug] ? String(liveCounts[s.slug]) : undefined}
        />
      ))}

      <SectionLabel>Account</SectionLabel>
      {signedIn ? (
        <>
          <Item
            href="/bets"
            icon={<I.Ticket size={15} />}
            active={isActive("/bets")}
            label="My bets"
          />
          <Item
            href="/wallet"
            icon={<I.Wallet size={15} />}
            active={isActive("/wallet")}
            label="Wallet"
          />
          <Item
            href="/account"
            icon={<I.Gear size={15} />}
            active={isActive("/account")}
            label="Settings"
          />
          {isAdmin && (
            <Item
              href="/admin"
              icon={<I.Trophy size={15} />}
              active={isActive("/admin")}
              label="Admin"
            />
          )}
        </>
      ) : (
        <>
          <Item href="/login" icon={<I.User size={15} />} active={isActive("/login")} label="Log in" />
          <Item
            href="/signup"
            icon={<I.Plus size={15} />}
            active={isActive("/signup")}
            label="Sign up"
          />
        </>
      )}

      <div style={{ flex: 1 }} />
      <div
        style={{
          padding: 12,
          marginTop: 12,
          fontSize: 11,
          color: "var(--fg-dim)",
          lineHeight: 1.5,
        }}
      >
        Please bet responsibly.
        <br />
        18+ · BeGambleAware.org
      </div>
    </aside>
  );
}

// Explicit sport ordering: flagship esports on top, bot leagues on the bottom,
// everything else alphabetical in between.
const TOP = ["cs2", "dota2", "lol", "valorant"] as const;
const BOTTOM = ["efootballbots", "ebasketballbots"] as const;

function orderSports(sports: SportItem[]): SportItem[] {
  const bySlug = new Map(sports.map((s) => [s.slug, s]));
  const top = TOP.map((s) => bySlug.get(s)).filter(
    (s): s is SportItem => Boolean(s),
  );
  const bottom = BOTTOM.map((s) => bySlug.get(s)).filter(
    (s): s is SportItem => Boolean(s),
  );
  const pinned = new Set<string>([...TOP, ...BOTTOM]);
  const middle = sports
    .filter((s) => !pinned.has(s.slug))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...top, ...middle, ...bottom];
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        padding: "14px 10px 6px",
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--fg-dim)",
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

function Item({
  href,
  icon,
  label,
  active,
  tag,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  tag?: string;
}) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        justifyContent: "flex-start",
        width: "100%",
        padding: "8px 10px",
        background: active ? "var(--surface-2)" : "transparent",
        color: active ? "var(--fg)" : "var(--fg-muted)",
        borderRadius: 8,
        textDecoration: "none",
        fontFamily: "inherit",
        fontSize: 13,
        textAlign: "left",
        position: "relative",
        transition: "background 140ms var(--ease), color 140ms var(--ease)",
      }}
    >
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {tag != null && (
        <span
          className="mono tnum"
          style={{
            fontSize: 10.5,
            padding: "1px 6px",
            color: "var(--fg-dim)",
          }}
        >
          {tag}
        </span>
      )}
      {active && (
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 8,
            bottom: 8,
            width: 2,
            background: "var(--fg)",
            borderRadius: 2,
          }}
        />
      )}
    </Link>
  );
}
