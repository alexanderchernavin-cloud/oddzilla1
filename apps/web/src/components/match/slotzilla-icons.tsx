"use client";

// Event icons for the SlotZilla timeline strip.
//
// Drawn as inline SVG rather than an image set: they render at 12px
// inside an 18px badge, where a raster would be soft on every display
// that is not exactly 1x, and they have to take their colour from the
// theme (a mark tints by symbol, and the whole strip inverts in dark
// mode) which an <img> cannot do. Inline also means no request and no
// flash of missing icon on a strip that redraws every second.
//
// `currentColor` throughout, so the badge sets the tint once and the
// glyph follows.

export type SlotzillaIconKind =
  | "P3"
  | "P2"
  | "FT"
  | "MISS"
  | "FOUL"
  | "rebound"
  | "timeout"
  | "period"
  | "other";

function Ball({ lines }: { lines: boolean }) {
  return (
    <>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      {lines ? (
        <>
          <path d="M3.5 12h17" stroke="currentColor" strokeWidth="1.3" fill="none" />
          <path d="M12 3.5v17" stroke="currentColor" strokeWidth="1.3" fill="none" />
          <path d="M6 6c3.5 3 3.5 9 0 12" stroke="currentColor" strokeWidth="1.1" fill="none" />
          <path d="M18 6c-3.5 3-3.5 9 0 12" stroke="currentColor" strokeWidth="1.1" fill="none" />
        </>
      ) : null}
    </>
  );
}

/**
 * One event glyph. The three scoring kinds are a basketball carrying
 * their value, because the value is the thing a bettor reads off the
 * reel; the rest are drawn as what they are.
 */
export function SlotzillaEventIcon({
  kind,
  size = 12,
}: {
  kind: SlotzillaIconKind;
  size?: number;
}) {
  let body: React.ReactNode;
  switch (kind) {
    case "P3":
    case "P2":
    case "FT": {
      // A ball with the points on it. The seams are dropped on the
      // scoring marks so the digit stays readable at 12px — a seamed
      // ball plus a numeral inside 12 square is mud.
      const value = kind === "P3" ? "3" : kind === "P2" ? "2" : "1";
      body = (
        <>
          <Ball lines={false} />
          <text
            x="12"
            y="16.2"
            textAnchor="middle"
            fontSize="11"
            fontWeight="700"
            fill="currentColor"
            stroke="none"
          >
            {value}
          </text>
        </>
      );
      break;
    }
    case "MISS":
      // Ball with a strike through it.
      body = (
        <>
          <Ball lines={false} />
          <path d="M6.5 17.5 17.5 6.5" stroke="currentColor" strokeWidth="2" fill="none" />
        </>
      );
      break;
    case "FOUL":
      // A whistle: the referee's call, not a letter.
      body = (
        <>
          <path
            d="M4 9.5h9.5a5 5 0 1 1-3.6 8.5L4 12.5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <circle cx="13.4" cy="14" r="1.7" fill="currentColor" stroke="none" />
          <path d="M14 6.5h5" stroke="currentColor" strokeWidth="1.7" fill="none" />
        </>
      );
      break;
    case "rebound":
      // Ball bouncing off the rim: two arcs and the ball.
      body = (
        <>
          <circle cx="15" cy="8.5" r="4" fill="none" stroke="currentColor" strokeWidth="1.7" />
          <path
            d="M4 18c2.5-4 5.5-6 9-6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path d="M4 13.5V18h4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </>
      );
      break;
    case "timeout":
      body = (
        <>
          <rect x="7" y="6" width="3.4" height="12" rx="1" fill="currentColor" stroke="none" />
          <rect x="13.6" y="6" width="3.4" height="12" rx="1" fill="currentColor" stroke="none" />
        </>
      );
      break;
    case "period":
      body = (
        <>
          <path d="M7 6v12" stroke="currentColor" strokeWidth="2" fill="none" />
          <path d="M17 6v12" stroke="currentColor" strokeWidth="2" fill="none" />
          <path d="M10 12h4" stroke="currentColor" strokeWidth="1.6" fill="none" />
        </>
      );
      break;
    default:
      body = <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      focusable="false"
      style={{ display: "block" }}
    >
      {body}
    </svg>
  );
}
