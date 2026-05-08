// Competition rule catalog. Source of truth for rule IDs, categories,
// default values, and bettor-facing display strings.
//
// Why TS-side and not in the database:
//   • The catalog is product-tuned copy. Iterating on copy via a
//     migration is an order of magnitude slower than a code change,
//     and copy drift across operators isn't a feature we want.
//   • Every consumer (admin wizard, bettor renderer, settlement
//     scoring) needs the same view of the catalog. Shipping it via
//     a TS module guarantees that.
//   • The BE only stores the rule_id + value pair (text columns), so
//     adding a rule to the catalog never requires a migration. New
//     rules ship with a code deploy.
//
// Aligned with the Notion PRD's "23-condition rule catalog". V1 ships
// a representative subset across every category; new rules land
// behind a simple append-and-deploy.
//
// ──────────────────────────────────────────────────────────────────
// Wire format reminder: persisted as
// `competition_rules(competition_id, rule_id, value, sort_order)`.
// `value` is opaque text — the catalog tells consumers how to parse.

import type {
  CompetitionRuleAssignment,
  CompetitionRuleCategory,
  CompetitionType,
} from "./community.js";

export interface CompetitionRuleDefinition {
  id: string;
  category: CompetitionRuleCategory;
  // Operator-facing label shown in the admin wizard's rules step.
  label: string;
  // Operator-facing helper text below the label.
  description: string;
  // When true, the bettor surface shows this rule even when the
  // operator hasn't toggled it on (e.g. entry-free is implicit).
  // V1 uses this for the entry-free required flag.
  locked?: boolean;
  // When true, the operator can edit the `value` payload (point
  // amount, integer cap). When false, the rule is a simple toggle.
  configurable?: boolean;
  // Default value when the operator first enables this rule.
  defaultValue?: string;
  // Operator-facing label for the value input.
  valueLabel?: string;
  // When set, the rule only applies to these competition types
  // (admin wizard hides it on others). NULL = applicable to all
  // types.
  applicableTo?: CompetitionType[];
  // Renders the rule into a bettor-facing string. The BE calls this
  // before serving CompetitionDetail.rules; the FE never has to ship
  // the catalog itself for the bettor surface.
  render: (assignment: CompetitionRuleAssignment) => string;
}

// V1 catalog — 14 rules covering the six categories. Extend by
// appending; never reorder (rule_id is the persisted key).
export const COMPETITION_RULE_CATALOG: ReadonlyArray<CompetitionRuleDefinition> = [
  // ─── Scoring ──────────────────────────────────────────────────
  {
    id: "scoring-correct-result",
    category: "scoring",
    label: "Correct result",
    description: "Award points for correctly predicting the winning side (1X2).",
    configurable: true,
    defaultValue: "3",
    valueLabel: "Points",
    render: (a) => `Correct result: ${a.value ?? "3"} points`,
  },
  {
    id: "scoring-exact-score",
    category: "scoring",
    label: "Exact score",
    description: "Bonus points when the predicted score matches exactly.",
    configurable: true,
    defaultValue: "5",
    valueLabel: "Points",
    applicableTo: ["prediction"],
    render: (a) => `Exact score: ${a.value ?? "5"} points`,
  },
  {
    id: "scoring-goal-difference",
    category: "scoring",
    label: "Correct goal difference",
    description: "Award points when the predicted goal difference is right.",
    configurable: true,
    defaultValue: "2",
    valueLabel: "Points",
    applicableTo: ["prediction"],
    render: (a) => `Correct goal difference: ${a.value ?? "2"} points`,
  },
  {
    id: "scoring-tip-point",
    category: "scoring",
    label: "Tip point",
    description: "One point per correct 1X2 tip.",
    configurable: true,
    defaultValue: "1",
    valueLabel: "Points",
    applicableTo: ["tipping"],
    render: (a) => `Tip point: ${a.value ?? "1"} per correct tip`,
  },
  // ─── Entry ────────────────────────────────────────────────────
  {
    id: "entry-free",
    category: "entry",
    label: "Free entry",
    description: "No fee to join. Required in V1.",
    locked: true,
    render: () => "Free to enter",
  },
  // ─── Tiebreaker ───────────────────────────────────────────────
  {
    id: "tiebreaker-earliest",
    category: "tiebreaker",
    label: "Earliest entry wins",
    description: "When points tie, the participant who joined earliest ranks higher.",
    render: () => "Tiebreaker: earliest entry wins",
  },
  {
    id: "tiebreaker-correct-score",
    category: "tiebreaker",
    label: "Most exact scores",
    description: "When points tie, the participant with more exact-score predictions ranks higher.",
    applicableTo: ["prediction"],
    render: () => "Tiebreaker: most exact scores",
  },
  // ─── Timing ───────────────────────────────────────────────────
  {
    id: "timing-lock-kickoff",
    category: "timing",
    label: "Lock predictions at kickoff",
    description: "Predictions cannot be edited or added after the match starts.",
    locked: true,
    render: () => "Predictions lock at kickoff",
  },
  {
    id: "timing-grace-period",
    category: "timing",
    label: "Grace period",
    description: "Allow predictions for N minutes after kickoff.",
    configurable: true,
    defaultValue: "0",
    valueLabel: "Minutes",
    render: (a) => `Predictions accepted ${a.value ?? "0"} minutes after kickoff`,
  },
  // ─── Eligibility ──────────────────────────────────────────────
  {
    id: "eligibility-open",
    category: "eligibility",
    label: "Open to everyone",
    description: "Any registered bettor can join.",
    render: () => "Open to all bettors",
  },
  {
    id: "eligibility-min-bet-count",
    category: "eligibility",
    label: "Minimum bet count",
    description: "Only bettors with at least N settled tickets can join.",
    configurable: true,
    defaultValue: "5",
    valueLabel: "Settled bets",
    render: (a) => `Requires ${a.value ?? "5"}+ settled bets`,
  },
  {
    id: "eligibility-max-participants",
    category: "eligibility",
    label: "Maximum participants",
    description: "Cap the number of joiners.",
    configurable: true,
    defaultValue: "1000",
    valueLabel: "Cap",
    render: (a) => `Limited to ${a.value ?? "1000"} participants`,
  },
  // ─── Prize ────────────────────────────────────────────────────
  {
    id: "prize-winner-takes-all",
    category: "prize",
    label: "Winner takes all (XP)",
    description: "Top participant earns the full XP pool.",
    configurable: true,
    defaultValue: "1000",
    valueLabel: "XP",
    render: (a) => `Winner takes all: ${a.value ?? "1000"} XP`,
  },
  {
    id: "prize-top-n",
    category: "prize",
    label: "Top N split (XP)",
    description: "XP pool split across the top N participants.",
    configurable: true,
    defaultValue: "3",
    valueLabel: "Top N",
    render: (a) => `Top ${a.value ?? "3"} split the XP pool`,
  },
];

// O(1) lookup — built once at module load.
const CATALOG_BY_ID = new Map<string, CompetitionRuleDefinition>(
  COMPETITION_RULE_CATALOG.map((r) => [r.id, r]),
);

export function getRuleDefinition(
  ruleId: string,
): CompetitionRuleDefinition | null {
  return CATALOG_BY_ID.get(ruleId) ?? null;
}

// Renders a rule assignment into bettor-facing copy. Unknown rule ids
// (operators inserting via direct SQL) render as their raw id so the
// missing-catalog-entry case is surfaced rather than silently dropped.
export function renderRule(
  assignment: CompetitionRuleAssignment,
): string {
  const def = CATALOG_BY_ID.get(assignment.ruleId);
  if (!def) return assignment.ruleId;
  return def.render(assignment);
}

export function renderRules(
  assignments: ReadonlyArray<CompetitionRuleAssignment>,
): string[] {
  return assignments.map(renderRule);
}

// Returns the `entry-free` + `timing-lock-kickoff` + `eligibility-open`
// trio that V1 enforces as default-on. Used by the admin wizard's
// "Start from Scratch" template; bettor surface doesn't need this.
export function defaultRuleSet(): CompetitionRuleAssignment[] {
  return COMPETITION_RULE_CATALOG.filter((r) => r.locked).map((r) => ({
    ruleId: r.id,
    value: r.defaultValue,
  }));
}
