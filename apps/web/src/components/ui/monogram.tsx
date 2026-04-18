import type { CSSProperties } from "react";

export function Monogram({ size = 28, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      style={style}
      aria-label="Oddzilla"
      role="img"
    >
      <circle cx="16" cy="16" r="15" fill="currentColor" />
      <g fill="none" stroke="var(--bg)" strokeWidth="2.2" strokeLinecap="round">
        <circle cx="12" cy="13" r="3.6" />
        <path d="M 11 20 L 21 20 L 13 26 L 23 26" />
      </g>
    </svg>
  );
}

export function Wordmark({ size = 16 }: { size?: number }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        fontFamily: "var(--font-display)",
        fontWeight: 500,
        fontSize: size,
        letterSpacing: "-0.015em",
        color: "var(--fg)",
      }}
    >
      <Monogram size={size + 8} />
      <span>Oddzilla</span>
    </span>
  );
}
