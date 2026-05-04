import type { CSSProperties } from "react";

// Oddin tags every tournament with a `risk_tier` (1..N) which doubles as
// a prestige signal. Tier 1 + Tier 2 are the majors / S-tier events the
// user wants surfaced; we render a small gold "Top" star next to the
// tournament name for both. Anything else returns null so non-prestige
// tournaments stay visually quiet.
export function TierMark({
  tier,
  size = 12,
  style,
}: {
  tier: number | null | undefined;
  size?: number;
  style?: CSSProperties;
}) {
  if (!isFeaturedTier(tier)) return null;
  return (
    <span
      title="Top tournament"
      aria-label="Top tournament"
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
        color: "var(--tier-gold, #f5a524)",
        ...style,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="m12 3 2.6 5.8 6.4.6-4.8 4.3 1.4 6.3L12 17l-5.6 3 1.4-6.3L3 9.4l6.4-.6z" />
      </svg>
    </span>
  );
}

// isFeaturedTier returns true for tournaments the user wants visually
// promoted across the storefront. Single source of truth so card accent
// rules and badge rendering can't drift.
export function isFeaturedTier(tier: number | null | undefined): boolean {
  return tier === 1 || tier === 2;
}
