import type { CSSProperties } from "react";

const LOGO_LIGHT_SRC = "/brand/oddzilla-light.png";
const LOGO_DARK_SRC = "/brand/oddzilla-dark.png";
const LOGO_ALT = "Oddzilla";

// The brand kit ships two finishes: a transparent/white-bg PNG sized
// for light surfaces, and a navy-tinted PNG that reads cleanly on dark
// surfaces. We render BOTH images, stacked, and let CSS hide the wrong
// one via [data-theme]. Doing it in CSS avoids a hydration round-trip
// and prevents a flash of the wrong logo when the pre-hydration script
// in app/layout.tsx flips the theme attribute before paint.
export function Logo({
  size = 40,
  style,
  className,
  priority = false,
}: {
  size?: number;
  style?: CSSProperties;
  className?: string;
  priority?: boolean;
}) {
  const wrapperStyle: CSSProperties = {
    display: "inline-block",
    width: size,
    height: size,
    flexShrink: 0,
    position: "relative",
    ...style,
  };
  const imgStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    display: "block",
  };
  return (
    <span style={wrapperStyle} className={className} aria-label={LOGO_ALT} role="img">
      <img
        src={LOGO_LIGHT_SRC}
        alt=""
        width={size}
        height={size}
        decoding="async"
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : undefined}
        className="oz-logo-light"
        style={imgStyle}
      />
      <img
        src={LOGO_DARK_SRC}
        alt=""
        width={size}
        height={size}
        decoding="async"
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : undefined}
        className="oz-logo-dark"
        style={imgStyle}
      />
    </span>
  );
}

// Back-compat: the old Monogram exposed a square icon. The new logo is
// image-based and already contains the "Oddzilla" wordmark; we render
// at the requested pixel size unchanged.
export function Monogram({
  size = 40,
  style,
  className,
}: {
  size?: number;
  style?: CSSProperties;
  className?: string;
}) {
  return <Logo size={size} style={style} className={className} priority />;
}

// Back-compat: the old Wordmark was [icon + separate text]. The new
// logo image already contains the wordmark, so we just render the
// image — no duplicate text label. The `size` prop here used to mean
// font-size of the text; now it's interpreted as the logo height.
export function Wordmark({ size = 40, className }: { size?: number; className?: string }) {
  return <Logo size={size} className={className} priority />;
}
