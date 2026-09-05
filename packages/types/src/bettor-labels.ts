// Operator labels a bettor can carry (migration 0104, users.labels).
//
// Closed vocabulary: the DB CHECK `users_labels_allowed` lists the same
// eight values, so adding one means editing both places. Descriptive
// only — the placement engine never reads labels; the levers that do
// affect acceptance are risk_score / global_limit_micro /
// bet_delay_seconds, edited on the same admin card.

export const BETTOR_LABELS = [
  "vip",
  "sharp",
  "regular",
  "fraud",
  "shady",
  "suspicious",
  "prematch",
  "live",
] as const;

export type BettorLabel = (typeof BETTOR_LABELS)[number];

export const BETTOR_LABEL_MAX = BETTOR_LABELS.length;

export function isBettorLabel(value: unknown): value is BettorLabel {
  return (
    typeof value === "string" &&
    (BETTOR_LABELS as readonly string[]).includes(value)
  );
}

// Per-bettor risk factor (users.risk_score). Multiplier on the bettor's
// slice of match liability: 1 = 100% of the standard allowance, 0.1 =
// 10%, 10 = 1000%. The admin card edits it in 0.1 steps inside this
// range; the DB CHECK still allows down to 0.01 for legacy rows.
export const RISK_FACTOR_MIN = 0.1;
export const RISK_FACTOR_MAX = 10;
export const RISK_FACTOR_STEP = 0.1;
export const RISK_FACTOR_DEFAULT = 1;

export function riskFactorToPercent(factor: number): number {
  return Math.round(factor * 1000) / 10;
}
