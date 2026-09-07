"use client";

import { useTranslations } from "@/lib/i18n";

/**
 * "This side is serving" marker, rendered beside a player / team name
 * on live tennis, table tennis and volleyball rows.
 *
 * The signal comes from Fonbet's own live payload (`serve` on the
 * innermost score cell — see fonbet-ingester's buildScore), so it is
 * exactly what fon.bet shows with an asterisk in its score comment,
 * and it is absent for every sport that has no such thing.
 *
 * A ball, in the ball's own colour. It was `var(--accent)` for a day,
 * which resolves to near-black in the light theme and read as a stray
 * bullet point next to the player's name rather than as a serve.
 *
 * Optic yellow is the actual colour of the object, so it needs no
 * legend — but it is a light colour on a light page (`#f4f2ec`), so the
 * fill alone would wash out. The ring is what makes it legible, and it
 * doubles as the ball's outline; the single curved seam is drawn only
 * from `size >= 8`, because below that it is a smudge rather than a
 * seam. Deliberately NOT `--live`: red is this design's live signal
 * (LiveDot), and a second red dot on the same row would read as a
 * second state.
 *
 * Table tennis and volleyball use this mark too. Their balls are not
 * this colour, but the shape is the message and one recognisable ball
 * beats three near-identical pale circles.
 */
export function ServeMark({ size = 7 }: { size?: number }) {
  const t = useTranslations("match");
  const label = t("serving");
  const seam = size >= 8;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{ display: "inline-flex", flexShrink: 0, lineHeight: 0 }}
    >
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="7"
          fill="var(--serve-ball, #d8e64a)"
          stroke="var(--serve-ball-ring, rgba(0, 0, 0, 0.32))"
          strokeWidth="1.5"
        />
        {seam ? (
          <path
            d="M2.2 4.4A8.4 8.4 0 0 1 8 8a8.4 8.4 0 0 1-5.8 3.6"
            fill="none"
            stroke="var(--serve-ball-ring, rgba(0, 0, 0, 0.32))"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        ) : null}
      </svg>
    </span>
  );
}
