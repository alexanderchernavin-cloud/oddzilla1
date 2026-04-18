"use client";

import type { CSSProperties, ReactNode, MouseEvent } from "react";

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
  locked = false,
  style,
}: {
  price?: number | null;
  label?: ReactNode;
  trend?: OddTrend;
  selected?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  size?: OddSize;
  locked?: boolean;
  style?: CSSProperties;
}) {
  const H = { sm: 36, md: 44, lg: 52 }[size];
  const arrow = trend === "up" ? "↑" : trend === "down" ? "↓" : null;
  const arrowColor =
    trend === "up" ? "var(--positive)" : trend === "down" ? "var(--negative)" : "var(--fg-dim)";
  return (
    <button
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
        background: selected ? "var(--accent)" : "var(--surface-2)",
        color: selected ? "var(--accent-fg)" : "var(--fg)",
        border: "1px solid",
        borderColor: selected ? "var(--accent)" : "var(--border)",
        borderRadius: 8,
        cursor: locked ? "not-allowed" : "pointer",
        fontFamily: "inherit",
        fontSize: 13,
        transition: "all 140ms var(--ease)",
        opacity: locked ? 0.5 : 1,
        textAlign: "left",
        position: "relative",
        ...style,
      }}
    >
      {label && (
        <span
          style={{
            fontSize: 11,
            color: selected
              ? "color-mix(in oklab, var(--accent-fg) 70%, transparent)"
              : "var(--fg-muted)",
            lineHeight: 1,
            marginBottom: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
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
        <span
          className="mono tnum"
          style={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em" }}
        >
          {locked || price == null ? "—" : price.toFixed(2)}
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
export function TeamMark({
  tag,
  color,
  size = 24,
}: {
  tag: string;
  color?: string;
  size?: number;
}) {
  const letters = tag.slice(0, 4).toUpperCase();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: 6,
        background: "var(--surface-2)",
        border: "1px solid var(--hairline)",
        fontFamily: "var(--font-mono)",
        fontSize: Math.max(9, size * 0.36),
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: "var(--fg)",
        position: "relative",
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
          }}
        />
      ) : null}
      {letters}
    </span>
  );
}
