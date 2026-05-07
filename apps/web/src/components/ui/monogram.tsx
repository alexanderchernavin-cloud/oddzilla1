import type { CSSProperties } from "react";

const LOGO_SRC = "/brand/oddzilla-logo.png";
const LOGO_ALT = "Oddzilla";

export function Logo({
  size = 40,
  style,
  priority = false,
}: {
  size?: number;
  style?: CSSProperties;
  priority?: boolean;
}) {
  return (
    <img
      src={LOGO_SRC}
      alt={LOGO_ALT}
      width={size}
      height={size}
      decoding="async"
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      style={{ display: "block", flexShrink: 0, ...style }}
    />
  );
}

// Back-compat: the old Monogram exposed a square icon. The new logo is
// image-based and already contains the "Oddzilla" wordmark; we render
// at the requested pixel size unchanged.
export function Monogram({ size = 40, style }: { size?: number; style?: CSSProperties }) {
  return <Logo size={size} style={style} priority />;
}

// Back-compat: the old Wordmark was [icon + separate text]. The new
// logo image already contains the wordmark, so we just render the
// image — no duplicate text label. The `size` prop here used to mean
// font-size of the text; now it's interpreted as the logo height.
export function Wordmark({ size = 40 }: { size?: number }) {
  return <Logo size={size} priority />;
}
