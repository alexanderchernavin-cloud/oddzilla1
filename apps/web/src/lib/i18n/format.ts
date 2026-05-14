// Tiny ICU-subset interpolator. Supports:
//   "Hello {name}"          → simple replacement
//   "{count, plural, one {# leg} other {# legs}}"  → CLDR plural
//
// The plural rule arm is selected via Intl.PluralRules for the active
// locale, with `#` substituted with the numeric value. Anything outside
// these two shapes is rendered as-is — we deliberately don't reach for
// a full ICU MessageFormat engine; the few strings that need plurals
// can be expressed in this grammar, and keeping the runtime small
// matters more than supporting every edge case.

export type FormatValues = Record<string, string | number>;

interface PluralBlock {
  variable: string;
  arms: Record<string, string>;
}

function parsePluralBlock(body: string): PluralBlock | null {
  // body is the inside of the outer braces, e.g.
  //   "count, plural, one {# leg} other {# legs}"
  const head = body.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*plural\s*,\s*([\s\S]*)$/);
  if (!head) return null;
  const variable = head[1]!;
  const rest = head[2]!;
  // Walk the arms manually so we handle nested braces around `#` correctly.
  const arms: Record<string, string> = {};
  let i = 0;
  while (i < rest.length) {
    // Skip whitespace.
    while (i < rest.length && /\s/.test(rest[i] ?? "")) i++;
    if (i >= rest.length) break;
    // Read the arm key (e.g. "one", "few", "=0", "other").
    const keyStart = i;
    while (i < rest.length && !/\s|\{/.test(rest[i] ?? "")) i++;
    const key = rest.slice(keyStart, i).trim();
    if (!key) break;
    while (i < rest.length && /\s/.test(rest[i] ?? "")) i++;
    if (rest[i] !== "{") break;
    // Read balanced brace content.
    i++; // consume `{`
    let depth = 1;
    const armStart = i;
    while (i < rest.length && depth > 0) {
      const ch = rest[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    const arm = rest.slice(armStart, i);
    arms[key] = arm;
    if (rest[i] === "}") i++;
  }
  return { variable, arms };
}

function renderArm(arm: string, value: number): string {
  return arm.replace(/#/g, String(value));
}

/**
 * Resolve a template string against the provided values for the given
 * locale. Missing values are rendered as the literal placeholder so
 * mistakes don't crash the page during translation work.
 */
export function formatMessage(
  template: string,
  values: FormatValues | undefined,
  locale: string,
): string {
  if (!template.includes("{")) return template;
  let pluralRules: Intl.PluralRules | null = null;
  function rules(): Intl.PluralRules {
    if (!pluralRules) pluralRules = new Intl.PluralRules(locale);
    return pluralRules;
  }

  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== "{") {
      out += ch;
      i++;
      continue;
    }
    // Find matching close, respecting nesting.
    let depth = 1;
    let j = i + 1;
    while (j < template.length && depth > 0) {
      const c = template[j];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
      j++;
    }
    const body = template.slice(i + 1, j);
    i = j + 1;

    // Plural block has at least one comma inside the body — bail out
    // to the simple replacement path for everything else.
    const plural = body.includes(",") ? parsePluralBlock(body) : null;
    if (plural) {
      const raw = values?.[plural.variable];
      const num = typeof raw === "number" ? raw : Number(raw ?? 0);
      const exact = `=${num}`;
      const arm =
        plural.arms[exact] ??
        plural.arms[rules().select(num)] ??
        plural.arms["other"] ??
        "";
      out += renderArm(arm, num);
      continue;
    }

    // Simple {name} substitution. Trim whitespace so "{ name }" still works.
    const key = body.trim();
    const raw = values?.[key];
    out += raw === undefined || raw === null ? `{${key}}` : String(raw);
  }
  return out;
}
