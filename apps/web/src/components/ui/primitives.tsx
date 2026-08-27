"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, MouseEvent } from "react";

import { useOddsFlash } from "@/lib/use-odds-flash";
// Value import via the subpath, never the barrel — see the note in
// packages/types/src/odds.ts.
import { formatOddsDisplay, isBettableOdds } from "@oddzilla/types/odds";

// ── Button ──────────────────────────────────────────────────────────────
type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  children?: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  style?: CSSProperties;
  className?: string;
  title?: string;
  "aria-label"?: string;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  children,
  onClick,
  type = "button",
  disabled,
  style,
  className,
  title,
  ...rest
}: ButtonProps) {
  const H = { sm: 30, md: 36, lg: 44 }[size];
  const P = { sm: "0 12px", md: "0 16px", lg: "0 22px" }[size];
  const FS = { sm: 12.5, md: 13.5, lg: 15 }[size];
  const variants: Record<ButtonVariant, CSSProperties> = {
    primary: { background: "var(--accent)", color: "var(--accent-fg)" },
    secondary: { background: "var(--surface-2)", color: "var(--fg)", border: "1px solid var(--border)" },
    ghost: { background: "transparent", color: "var(--fg)" },
    outline: { background: "transparent", color: "var(--fg)", border: "1px solid var(--border)" },
    danger: { background: "transparent", color: "var(--negative)", border: "1px solid var(--border)" },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={className}
      {...rest}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        height: H,
        padding: P,
        fontSize: FS,
        fontWeight: 500,
        lineHeight: 1,
        borderRadius: 999,
        cursor: disabled ? "not-allowed" : "pointer",
        border: "1px solid transparent",
        transition:
          "background 160ms var(--ease), border-color 160ms var(--ease), color 160ms var(--ease), transform 80ms var(--ease)",
        fontFamily: "inherit",
        letterSpacing: "-0.005em",
        opacity: disabled ? 0.5 : 1,
        userSelect: "none",
        whiteSpace: "nowrap",
        ...variants[variant],
        ...style,
      }}
    >
      {icon}
      {children}
      {iconRight}
    </button>
  );
}

// ── Pill ────────────────────────────────────────────────────────────────
type PillTone = "live" | "positive" | "neutral";

export function Pill({
  children,
  tone = "neutral",
  style,
}: {
  children: ReactNode;
  tone?: PillTone;
  style?: CSSProperties;
}) {
  const tones: Record<PillTone, CSSProperties> = {
    live: {
      color: "var(--live)",
      border: "1px solid color-mix(in oklab, var(--live) 40%, transparent)",
      background: "color-mix(in oklab, var(--live) 8%, transparent)",
    },
    positive: { color: "var(--positive)" },
    neutral: { color: "var(--fg-muted)", border: "1px solid var(--border)" },
  };
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        ...tones[tone],
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// ── LiveDot ─────────────────────────────────────────────────────────────
export function LiveDot({ size = 8 }: { size?: number }) {
  return (
    <span style={{ position: "relative", display: "inline-block", width: size, height: size }}>
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 999,
          background: "var(--live)",
          animation: "oz-pulse 1.6s var(--ease-out) infinite",
        }}
      />
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 999,
          background: "var(--live)",
        }}
      />
    </span>
  );
}

// ── Divider ─────────────────────────────────────────────────────────────
export function Divider({ v = false, style }: { v?: boolean; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: "var(--hairline)",
        ...(v ? { width: 1, alignSelf: "stretch" } : { height: 1, width: "100%" }),
        ...style,
      }}
    />
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────
export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
  count?: number;
}

export function Tabs({
  items,
  value,
  onChange,
  size = "md",
}: {
  items: TabItem[];
  value: string;
  onChange?: (v: string) => void;
  size?: "sm" | "md" | "lg";
}) {
  const H = { sm: 28, md: 32, lg: 40 }[size];
  const FS = { sm: 12, md: 13, lg: 14 }[size];
  return (
    <div
      style={{
        display: "inline-flex",
        gap: 2,
        padding: 3,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 999,
      }}
    >
      {items.map((it) => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            onClick={() => onChange?.(it.id)}
            type="button"
            style={{
              height: H,
              padding: `0 ${size === "sm" ? 10 : 14}px`,
              fontSize: FS,
              fontWeight: 500,
              background: active ? "var(--surface)" : "transparent",
              color: active ? "var(--fg)" : "var(--fg-muted)",
              border: "1px solid",
              borderColor: active ? "var(--border)" : "transparent",
              borderRadius: 999,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "all 140ms var(--ease)",
              boxShadow: active ? "var(--shadow-sm)" : "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {it.icon}
            {it.label}
            {it.count != null && (
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>
                {it.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── OddButton ───────────────────────────────────────────────────────────
type OddSize = "sm" | "md" | "lg";
type OddTrend = "up" | "down" | "flat";

export function OddButton({
  price,
  label,
  trend,
  selected,
  onClick,
  size = "md",
  locked: lockedProp = false,
  // When true the button paints as a ZillaFlash boosted outcome:
  // green border, soft green tint background, positive-coloured
  // price. The match page sets this for any outcome with a current
  // boost so the whole cell signals "great option" at a glance
  // instead of relying on the small BOOST chip alone.
  boosted = false,
  // Pre-boost price for boosted outcomes (ZillaFlash / ZillaBoost).
  // Rendered as a small struck-through value before the boosted price
  // so the bettor sees what the boost is worth — same presentation the
  // ZillaFlash lobby card uses. Hidden when it equals the shown price
  // (a sub-cent boost floors to the same 2dp figure).
  originalPrice = null,
  // Set when the parent floats an overlay chip over this button's
  // top-RIGHT corner (today: the ZillaTips ROI badge). Reserves room on
  // the label row so the two can't collide. Needed because `boosted`
  // right-aligns the label to sit over the active price — which is
  // exactly where that badge is anchored, so a boosted cell WITH a tip
  // rendered the badge on top of its own outcome label.
  //
  // Pass the overlay's width in px — the caller owns that number, since
  // only it knows what it's floating (ZILLATIPS_SM_BADGE_WIDTH_PX for
  // the tips chip). `true` falls back to a conservative default.
  badgeOverlay = false,
  style,
}: {
  price?: number | null;
  label?: ReactNode;
  trend?: OddTrend;
  selected?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  size?: OddSize;
  locked?: boolean;
  boosted?: boolean;
  originalPrice?: number | null;
  badgeOverlay?: boolean | number;
  style?: CSSProperties;
}) {
  // Width to keep the label row clear of. 60 is the ZillaTips compact
  // badge's bound — the only overlay in use today — so a bare `true`
  // still clears it.
  const badgeReservePx =
    badgeOverlay === false
      ? 0
      : badgeOverlay === true
        ? 60
        : badgeOverlay;
  // A price at or below 1.00 can't return a profit, so the cell is shown
  // but not offered — greyed with an em dash, exactly like a suspended
  // outcome. Sub-1.01 prices above 1.00 (1.003 and friends) are
  // bettable and unaffected. Mirrors the `authNum <= 1` reject in
  // POST /bets so the UI never offers what placement would refuse.
  const locked = lockedProp || (price != null && !isBettableOdds(price));
  const H = { sm: 36, md: 44, lg: 52 }[size];
  const arrow = trend === "up" ? "↑" : trend === "down" ? "↓" : null;
  const arrowColor =
    trend === "up" ? "var(--positive)" : trend === "down" ? "var(--negative)" : "var(--fg-dim)";
  // Background flash on every actual price change. The hook diffs the
  // price prop and runs a Web Animations API tween on the button — a
  // soft green tint for an increase, red for a decrease, ~1s hold then
  // fade over the remaining 9s. Skipped while the button is locked or
  // selected: an inactive→active transition would flash on resume, and
  // a flash on a selected button paints over the accent background so
  // the "this is in your slip" state stops being visible.
  const flashRef = useRef<HTMLButtonElement | null>(null);
  useOddsFlash(locked || selected ? null : price ?? null, flashRef);

  // Cancel any in-flight flash the moment the button becomes selected,
  // so the accent (dark) background shows through cleanly instead of
  // being repainted by the remaining seconds of the fade.
  useEffect(() => {
    if (!selected) return;
    const el = flashRef.current;
    if (!el || typeof el.getAnimations !== "function") return;
    for (const a of el.getAnimations()) {
      if ((a as Animation & { id?: string }).id === "oz-value-flash") {
        a.cancel();
      }
    }
  }, [selected]);
  // Boost styling only applies when the outcome is bettable AND not
  // already in the slip — a selected boost still wears the accent
  // background so the "in your slip" affordance reads, and a locked
  // boost stays greyed out so a suspended outcome isn't masquerading
  // as a great option.
  const showBoost = boosted && !selected && !locked;
  // Struck-through pre-boost price visibility — also drives the label
  // alignment below: with the boosted price right-aligned (space-
  // between against the struck original), the line label ("-9.5")
  // moves right too so the specifier sits OVER the active price
  // instead of over the crossed-out one.
  // Compared at DISPLAY precision, not a fixed 2dp: a boost that moves
  // 1.003 -> 1.004 is visible now that both render at 4dp, so hiding
  // the struck original there would drop a real price change.
  const showStrike =
    showBoost &&
    price != null &&
    originalPrice != null &&
    formatOddsDisplay(originalPrice) !== formatOddsDisplay(price);
  return (
    <button
      ref={flashRef}
      type="button"
      onClick={onClick}
      disabled={locked}
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "stretch",
        gap: 2,
        height: H,
        padding: "0 12px",
        background: selected
          ? "var(--accent)"
          : showBoost
            ? "color-mix(in oklab, var(--positive, #16a34a) 12%, var(--surface-2))"
            : "var(--surface-2)",
        color: selected ? "var(--accent-fg)" : "var(--fg)",
        border: "1px solid",
        borderColor: selected
          ? "var(--accent)"
          : showBoost
            ? "var(--positive, #16a34a)"
            : "var(--border)",
        borderRadius: 8,
        // Soft green ring on boosted outcomes — same shade as the
        // border, but blurred out. Lifts the cell off the page without
        // a heavy shadow.
        boxShadow: showBoost
          ? "0 0 0 1px color-mix(in oklab, var(--positive, #16a34a) 35%, transparent), 0 2px 10px color-mix(in oklab, var(--positive, #16a34a) 18%, transparent)"
          : "none",
        cursor: locked ? "not-allowed" : "pointer",
        fontFamily: "inherit",
        fontSize: 13,
        transition: "all 140ms var(--ease)",
        // Locked-state opacity. Bumped from 0.5 → 0.65 so the digits
        // stay legible while the rest of the cell still reads as
        // "can't bet right now". 0.5 dropped the dark text to a near-
        // washed-out gray on the light theme; 0.65 keeps it grey but
        // still strong enough to scan.
        opacity: locked ? 0.65 : 1,
        textAlign: "left",
        position: "relative",
        ...style,
      }}
    >
      {label && (
        <span
          style={{
            fontSize: 11,
            textAlign: showBoost ? "right" : "left",
            // Clear the overlay badge's footprint. Only the label row
            // needs it — the chip is 17px tall and the price row sits
            // below it. Applies at any alignment, so it holds for both
            // the left-aligned (unboosted) and right-aligned (boosted)
            // label.
            paddingRight: badgeReservePx || undefined,
            // Locked labels stay readable too — fg-muted is grey
            // enough that 0.65 opacity above doesn't push them into
            // unreadable territory.
            color: selected
              ? "color-mix(in oklab, var(--accent-fg) 75%, transparent)"
              : "var(--fg-muted)",
            lineHeight: 1,
            marginBottom: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            // `min-width: 0` is required for the ellipsis to actually
            // trigger. The button is `display: flex` (column), and a
            // flex item's default `min-width: auto` resolves to its
            // content's min-content — which for a nowrap text run is
            // the full text width. Without this, the span refuses to
            // shrink below its full label width and the OddButton
            // visibly widens to fit (overflowing its grid track on
            // long player-prop names / team names).
            minWidth: 0,
          }}
        >
          {label}
        </span>
      )}
      <span
        style={{
          display: "inline-flex",
          alignItems: "baseline",
          gap: 6,
          justifyContent: "space-between",
        }}
      >
        {showStrike && (
          <span
            className="mono tnum"
            style={{
              fontSize: 11,
              color: "var(--fg-muted)",
              textDecoration: "line-through",
              letterSpacing: "-0.01em",
            }}
          >
            {formatOddsDisplay(originalPrice!)}
          </span>
        )}
        <span
          className="mono tnum"
          style={{
            fontSize: 14,
            // Boosted cells right-align the price even when the struck
            // original is hidden (floored price unchanged) — sibling
            // ladder cells show [struck | boosted-right], so a lone
            // left price breaks the column line.
            ...(showBoost && !showStrike ? { marginLeft: "auto" } : null),
            // Always 700 so the digits stay punchy through every
            // state transition — selection accent flip, boost
            // green tint, odds-change flash, and locked dim all
            // keep the price legible at a glance.
            fontWeight: 700,
            letterSpacing: "-0.01em",
            // Pin the colour explicitly per state so the inherited
            // `color` on the button (which is animated by the CSS
            // transition on selection swap) never blends through.
            color: showBoost
              ? "var(--positive, #16a34a)"
              : selected
                ? "var(--accent-fg)"
                : "var(--fg)",
          }}
        >
          {locked || price == null ? "—" : formatOddsDisplay(price)}
        </span>
        {arrow && (
          <span
            className="mono"
            style={{ fontSize: 11, color: selected ? "currentColor" : arrowColor }}
          >
            {arrow}
          </span>
        )}
      </span>
    </button>
  );
}

// ── TeamMark ────────────────────────────────────────────────────────────
// Renders the team's branded logo when `logoUrl` is supplied, falling back
// to a monogram (up to 4 initials) when it isn't or when the image fails
// to load. The fallback path matters: feeds add new teams faster than an
// admin can paste logos, and a broken <img> would replace the row's leading
// column with the alt-text default the browser picks (an icon, varies per
// platform). The component owns the error state so the consumer doesn't
// have to thread it through every call site.
export function TeamMark({
  tag,
  color,
  size = 24,
  logoUrl,
  name,
}: {
  tag: string;
  color?: string;
  size?: number;
  logoUrl?: string | null;
  // Optional human team name; used only as the <img> alt and falls back
  // to the tag when omitted. Empty alt is allowed when neither is set.
  name?: string;
}) {
  const letters = tag.slice(0, 4).toUpperCase();
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = !!logoUrl && !imgFailed;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: 6,
        background: showImage ? "var(--surface-1)" : "var(--surface-2)",
        border: "1px solid var(--hairline)",
        fontFamily: "var(--font-mono)",
        fontSize: Math.max(9, size * 0.36),
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: "var(--fg)",
        position: "relative",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {color ? (
        <span
          style={{
            position: "absolute",
            top: 3,
            right: 3,
            width: 5,
            height: 5,
            borderRadius: 999,
            background: color,
            zIndex: 2,
          }}
        />
      ) : null}
      {showImage ? (
        <img
          src={logoUrl}
          alt={name ?? letters}
          onError={() => setImgFailed(true)}
          loading="lazy"
          decoding="async"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            // Subtle inset so the logo doesn't touch the rounded edge.
            padding: Math.max(1, Math.round(size * 0.06)),
            background: "transparent",
          }}
        />
      ) : (
        letters
      )}
    </span>
  );
}
