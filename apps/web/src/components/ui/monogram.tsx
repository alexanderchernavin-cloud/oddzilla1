import type { CSSProperties } from "react";

const LOGO_LIGHT_SRC = "/brand/oddzilla-light.png";
const LOGO_DARK_SRC = "/brand/oddzilla-dark.png";
// The transparent wordmark works on both themes — no theme-aware swap
// needed for it. The two-file 2:1 variant is kept around for footers
// or splash surfaces where the framed look is preferable.
const WORDMARK_TRANSPARENT_SRC = "/brand/wordmark-transparent.png";
const ALT = "Oddzilla";

// 1263×334 transparent source ≈ 3.78:1. Used to derive the rendered
// width from the requested height when callers pass `size`.
const WORDMARK_ASPECT = 1263 / 334;

// The brand kit ships two finishes per asset: a transparent/white-bg PNG
// sized for light surfaces, and a navy-tinted PNG that reads cleanly on
// dark surfaces. We render BOTH images, stacked, and let CSS hide the
// wrong one via [data-theme]. Doing it in CSS avoids a hydration
// round-trip and prevents a flash of the wrong art when the pre-hydration
// theme-boot script in app/layout.tsx flips the attribute before paint.

// Square 1:1 icon — favicon-area, sidebars, anywhere a tight box.
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
  return (
    <ThemedImage
      lightSrc={LOGO_LIGHT_SRC}
      darkSrc={LOGO_DARK_SRC}
      width={size}
      height={size}
      priority={priority}
      style={style}
      className={className}
    />
  );
}

// Landscape ~3.78:1 transparent wordmark — top-bar header, anywhere a
// horizontal layout reads better than a square icon. `size` is the
// rendered HEIGHT in pixels; width is derived from the source aspect.
// Single transparent asset, so no theme-aware swap is needed.
export function Wordmark({
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
  const height = size;
  const width = Math.round(size * WORDMARK_ASPECT);
  const wrapperStyle: CSSProperties = {
    display: "inline-block",
    width,
    height,
    flexShrink: 0,
    position: "relative",
    ...style,
  };
  return (
    <span
      style={wrapperStyle}
      className={className}
      aria-label={ALT}
      role="img"
    >
      <img
        src={WORDMARK_TRANSPARENT_SRC}
        alt=""
        width={width}
        height={height}
        decoding="async"
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : undefined}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
    </span>
  );
}

// Back-compat: the old Monogram exposed a square icon — keep it pointing
// at the square <Logo>.
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

function ThemedImage({
  lightSrc,
  darkSrc,
  width,
  height,
  priority,
  style,
  className,
}: {
  lightSrc: string;
  darkSrc: string;
  width: number;
  height: number;
  priority: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  const wrapperStyle: CSSProperties = {
    display: "inline-block",
    width,
    height,
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
    <span style={wrapperStyle} className={className} aria-label={ALT} role="img">
      <img
        src={lightSrc}
        alt=""
        width={width}
        height={height}
        decoding="async"
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : undefined}
        className="oz-logo-light"
        style={imgStyle}
      />
      <img
        src={darkSrc}
        alt=""
        width={width}
        height={height}
        decoding="async"
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : undefined}
        className="oz-logo-dark"
        style={imgStyle}
      />
    </span>
  );
}
