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
 * A plain dot rather than a ball glyph on purpose: at this size the
 * seam of a tennis ball is a smudge, and the mark has to work for
 * volleyball and table tennis too. It is the accent colour, never
 * `--live` — a red dot is this design's "live" signal (LiveDot) and a
 * second red dot on the same row would read as a second state.
 */
export function ServeMark({ size = 7 }: { size?: number }) {
  const t = useTranslations("match");
  const label = t("serving");
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: 999,
        background: "var(--accent)",
        flexShrink: 0,
      }}
    />
  );
}
