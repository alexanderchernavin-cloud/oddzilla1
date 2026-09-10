"use client";

import type { CSSProperties, ReactNode } from "react";
import type { SlotSymbol } from "@oddzilla/types/slotzilla";

// Shared pieces of the SlotZilla backoffice, in the ComboZilla editor's
// idiom: plain tables, module-local style constants on the
// `var(--color-x, var(--x))` tokens the admin shell bridges.

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "16px 18px",
        background: "var(--color-bg-subtle, var(--surface-2))",
        border: "1px solid var(--color-border, var(--border))",
        borderRadius: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2
          className="mono"
          style={{
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--color-fg-subtle, var(--fg-dim))",
            margin: 0,
            flex: 1,
          }}
        >
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        fontSize: 12.5,
        color: "var(--negative, #dc2626)",
        background: "color-mix(in oklab, var(--negative, #dc2626) 8%, transparent)",
        padding: "8px 12px",
        borderRadius: 8,
      }}
    >
      {children}
    </div>
  );
}

export function NoticeBanner({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12.5,
        color: "var(--color-fg, var(--fg))",
        background: "color-mix(in oklab, var(--accent, #16a34a) 10%, transparent)",
        padding: "8px 12px",
        borderRadius: 8,
      }}
    >
      {children}
    </div>
  );
}

/** "Couldn't load" paragraph with a retry, for a tab whose SSR fetch came back null. */
export function LoadFailed({ what, onRetry, pending }: { what: string; onRetry: () => void; pending?: boolean }) {
  return (
    <p style={{ ...hintStyle, display: "flex", alignItems: "center", gap: 10 }}>
      <span>Couldn&apos;t load {what}. The API may be down or the SlotZilla routes not deployed yet.</span>
      <button type="button" onClick={onRetry} disabled={pending} style={smallButtonStyle}>
        {pending ? "Loading…" : "Retry"}
      </button>
    </p>
  );
}

export function Field({
  label,
  hint,
  children,
  error,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  error?: string | null;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5 }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      {children}
      {error ? (
        <span style={{ fontSize: 11.5, color: "var(--negative, #dc2626)" }}>{error}</span>
      ) : hint ? (
        <span style={{ fontSize: 11.5, color: "var(--color-fg-muted, var(--fg-muted))" }}>{hint}</span>
      ) : null}
    </label>
  );
}

export type ChipTone = "neutral" | "accent" | "negative" | "warning" | "muted";

const CHIP_TONE: Record<ChipTone, { fg: string; bg: string }> = {
  neutral: { fg: "var(--color-fg, var(--fg))", bg: "transparent" },
  accent: { fg: "var(--accent, #16a34a)", bg: "color-mix(in oklab, var(--accent, #16a34a) 12%, transparent)" },
  negative: { fg: "var(--negative, #dc2626)", bg: "color-mix(in oklab, var(--negative, #dc2626) 12%, transparent)" },
  warning: { fg: "var(--color-warning, var(--live))", bg: "color-mix(in oklab, var(--color-warning, var(--live)) 14%, transparent)" },
  muted: { fg: "var(--color-fg-muted, var(--fg-muted))", bg: "transparent" },
};

export function Chip({ tone = "neutral", children, title }: { tone?: ChipTone; children: ReactNode; title?: string }) {
  const t = CHIP_TONE[tone];
  return (
    <span
      className="mono"
      title={title}
      style={{
        display: "inline-block",
        fontSize: 11,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        padding: "1px 7px",
        borderRadius: 999,
        border: `1px solid ${tone === "neutral" || tone === "muted" ? "var(--color-border, var(--border))" : "transparent"}`,
        color: t.fg,
        background: t.bg,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function GameStatusChip({ status }: { status: string | null | undefined }) {
  const tone: ChipTone =
    status === "live" ? "accent" : status === "paused" ? "warning" : status === "voided" ? "negative" : status === "ended" ? "muted" : "neutral";
  return <Chip tone={tone}>{status ?? "?"}</Chip>;
}

export function SpinStatusChip({ status }: { status: string | null | undefined }) {
  const tone: ChipTone =
    status === "won" ? "accent" : status === "lost" ? "muted" : status === "void" ? "negative" : status === "open" ? "warning" : "neutral";
  return <Chip tone={tone}>{status ?? "?"}</Chip>;
}

/** The six reel symbols, tinted so a spin log reads at a glance. */
const SYMBOL_TINT: Record<SlotSymbol, string> = {
  P3: "var(--accent, #16a34a)",
  P2: "color-mix(in oklab, var(--accent, #16a34a) 70%, var(--color-fg, var(--fg)))",
  FT: "color-mix(in oklab, var(--accent, #16a34a) 45%, var(--color-fg-muted, var(--fg-muted)))",
  MISS: "var(--negative, #dc2626)",
  FOUL: "var(--color-warning, var(--live))",
  NONE: "var(--color-fg-muted, var(--fg-muted))",
};

export function ReelCell({ symbol, team }: { symbol: SlotSymbol | null | undefined; team?: string | null }) {
  const tint = symbol ? SYMBOL_TINT[symbol] : "var(--color-fg-subtle, var(--fg-dim))";
  return (
    <span
      className="mono"
      title={team ? `${symbol ?? "?"} (${team})` : symbol ?? "not yet derived"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 40,
        height: 24,
        padding: "0 6px",
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.04em",
        color: tint,
        background: `color-mix(in oklab, ${tint} 14%, transparent)`,
        border: `1px solid color-mix(in oklab, ${tint} 40%, transparent)`,
      }}
    >
      {symbol ?? "·"}
    </span>
  );
}

export function OnlineDot({ online }: { online: boolean }) {
  const c = online ? "var(--accent, #16a34a)" : "var(--negative, #dc2626)";
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 9,
        height: 9,
        borderRadius: 999,
        background: c,
        boxShadow: `0 0 0 3px color-mix(in oklab, ${c} 22%, transparent)`,
      }}
    />
  );
}

export const hintStyle: CSSProperties = {
  fontSize: 12.5,
  color: "var(--color-fg-muted, var(--fg-muted))",
  margin: 0,
  lineHeight: 1.45,
};

export const inputStyle: CSSProperties = {
  height: 36,
  padding: "0 10px",
  background: "var(--color-bg, var(--bg))",
  border: "1px solid var(--color-border, var(--border))",
  borderRadius: 8,
  color: "var(--color-fg, var(--fg))",
  fontFamily: "inherit",
  fontSize: 13.5,
};

export const cellInputStyle: CSSProperties = {
  ...inputStyle,
  height: 32,
  width: 96,
  textAlign: "right",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
};

export const buttonStyle: CSSProperties = {
  height: 36,
  padding: "0 16px",
  borderRadius: 8,
  border: "1px solid transparent",
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
};

export const smallButtonStyle: CSSProperties = {
  height: 28,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--color-border, var(--border))",
  background: "transparent",
  color: "var(--color-fg, var(--fg))",
  fontFamily: "inherit",
  fontSize: 12,
  cursor: "pointer",
};

export const dangerSmallButtonStyle: CSSProperties = {
  ...smallButtonStyle,
  color: "var(--negative, #dc2626)",
  borderColor: "color-mix(in oklab, var(--negative, #dc2626) 45%, transparent)",
};

export function primaryButtonStyle(enabled: boolean, pending = false): CSSProperties {
  return {
    ...buttonStyle,
    background: enabled ? "var(--accent, #16a34a)" : "var(--color-bg-subtle, var(--surface-2))",
    color: enabled ? "var(--accent-fg, #fff)" : "var(--color-fg-muted, var(--fg-muted))",
    cursor: enabled && !pending ? "pointer" : "default",
    opacity: pending ? 0.7 : 1,
  };
}

export function ghostButtonStyle(enabled: boolean): CSSProperties {
  return {
    ...buttonStyle,
    background: "transparent",
    border: "1px solid var(--color-border, var(--border))",
    color: "var(--color-fg, var(--fg))",
    cursor: enabled ? "pointer" : "default",
    opacity: enabled ? 1 : 0.5,
  };
}

export const thStyle: CSSProperties = {
  textAlign: "left",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--color-fg-muted, var(--fg-muted))",
  padding: "4px 8px",
  fontWeight: 500,
  whiteSpace: "nowrap",
};

export const tdStyle: CSSProperties = {
  padding: "8px 8px",
  verticalAlign: "middle",
};

export const rowStyle: CSSProperties = {
  borderTop: "1px solid var(--color-border, var(--border))",
};

export const monoMuted: CSSProperties = {
  fontSize: 12,
  color: "var(--color-fg-muted, var(--fg-muted))",
};

export const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};
