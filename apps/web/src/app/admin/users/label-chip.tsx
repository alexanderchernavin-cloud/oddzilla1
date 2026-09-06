// Label chip shared by the bettor list, the bettor card and the alert
// center. Server-safe (no hooks) so server components can render it;
// the labels editor wraps it in a <button> for toggling.

import type { ReactNode } from "react";
import type { BettorLabel } from "@oddzilla/types/bettor-labels";
import { I } from "@/components/ui/icons";

interface LabelStyle {
  color: string;
  Icon: (p: { size?: number }) => ReactNode;
}

// One hue and one glyph per label so the desk reads a row at a glance:
// green = the account the book wants (vip), blue = edge (sharp), grey =
// baseline (regular), red / orange / amber = integrity concerns in
// descending certainty (fraud / shady / suspicious), teal / violet =
// placement style (prematch / live). Fixed hex rather than theme tokens
// so a "fraud" chip reads the same in light and dark.
const LABEL_STYLES: Record<BettorLabel, LabelStyle> = {
  vip: { color: "#16a34a", Icon: I.Star },
  sharp: { color: "#2563eb", Icon: I.TrendUp },
  regular: { color: "#6b7280", Icon: I.User },
  fraud: { color: "#dc2626", Icon: I.Fire },
  shady: { color: "#ea580c", Icon: I.EyeOff },
  suspicious: { color: "#d97706", Icon: I.Eye },
  prematch: { color: "#0f766e", Icon: I.Clock },
  live: { color: "#7c3aed", Icon: I.Live },
};

export function labelColor(label: BettorLabel): string {
  return LABEL_STYLES[label].color;
}

export function LabelChip({
  label,
  active = true,
  size = "sm",
}: {
  label: BettorLabel;
  active?: boolean;
  size?: "sm" | "md";
}) {
  const { color, Icon } = LABEL_STYLES[label];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border font-mono uppercase tracking-[0.12em]"
      style={{
        fontSize: size === "sm" ? 10 : 11,
        padding: size === "sm" ? "2px 8px 2px 6px" : "4px 10px 4px 8px",
        lineHeight: 1.4,
        borderColor: active ? color : "var(--color-border-strong)",
        color: active ? color : "var(--color-fg-subtle)",
        background: active
          ? `color-mix(in oklab, ${color} 12%, transparent)`
          : "transparent",
      }}
    >
      <Icon size={size === "sm" ? 11 : 13} />
      {label}
    </span>
  );
}
