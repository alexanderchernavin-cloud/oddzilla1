import type { ReactNode } from "react";

export function SectionHeader({
  kicker,
  title,
  count,
  action,
}: {
  kicker: string;
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 14 }}>
      <span
        className="mono"
        style={{
          fontSize: 10.5,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--fg-dim)",
          fontWeight: 600,
        }}
      >
        {kicker}
      </span>
      <h2
        className="display"
        style={{ margin: 0, fontSize: 20, fontWeight: 500, letterSpacing: "-0.015em" }}
      >
        {title}
      </h2>
      {count != null && (
        <span className="mono tnum" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          {count}
        </span>
      )}
      <div style={{ flex: 1 }} />
      {action}
    </div>
  );
}
