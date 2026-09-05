// Market scopes — the tab a market lands in on the match-detail page, and
// the string that identifies that tab in `fe_market_display_order.scope` /
// `fe_market_groups.scope`.
//
// Four families:
//   match        — the base event. Everything with no map and no sub-event.
//   map_<N>      — esports maps (`map=N` specifier). One tab per map.
//   fb_<kinds>   — Fonbet sub-events, which ride the `variant` specifier:
//                  `fb:100201` (1st half) → `fb_100201`, and a nested
//                  sub-event `fb:400100/10100201` (corners of the 1st half)
//                  → `fb_400100_10100201`. `fb_players` collects every
//                  per-player variant (`fb:<kinds>:<playerId>`) into one tab,
//                  since one tab per footballer is not a tab strip.
//   custom_<key> — an operator-created curated tab (migration 0084). Content
//                  is exactly the admin's list; no implicit market pool.
// Plus the curated built-in `top`.
//
// This module is the ONE place the grammar and the derivation live. Three
// consumers have to agree byte-for-byte or the backoffice configures a tab
// the storefront never renders:
//   * `@oddzilla/db` re-exports the predicates, and its DB CHECK constraints
//     mirror the regexes below (migrations 0084, 0106).
//   * the api derives the scope per market on /catalog/matches/:id AND
//     re-derives it over the current offer to build the admin's tab list.
//   * the web admin validates the scope in the URL and labels the tabs.
//
// The sub-event LABEL is not in the id: Fonbet ships it as a prefix on the
// market-name template ("1st half: Total {threshold}"), so deriving a scope
// needs the template as well as the specifiers.

export type FeBaseScope = "match" | "top";
export type FeMapScope = `map_${number}`;
export type FeCustomScope = `custom_${string}`;
export type FeSubEventScope = `fb_${string}`;
export type FeMarketScope =
  | FeBaseScope
  | FeMapScope
  | FeCustomScope
  | FeSubEventScope;

export const FE_BASE_SCOPES = ["match", "top"] as const;

const MAP_SCOPE_RE = /^map_([1-9][0-9]*)$/;
// Keys are API-generated random hex; the CHECK (and this regex) accept any
// [a-z0-9]{4,32} suffix for forward flexibility.
const CUSTOM_SCOPE_RE = /^custom_([a-z0-9]{4,32})$/;
// `fb_players`, or one-or-more numeric Fonbet event kinds joined by `_`.
const SUB_EVENT_SCOPE_RE = /^fb_(players|[0-9]+(?:_[0-9]+)*)$/;

// The `variant` specifier fonbet-ingester writes: `fb:<kind>[/<kind>…]`
// with an optional `:<playerId>` tail for per-player sub-events.
const FB_VARIANT_RE = /^fb:([\d/]+)(?::(\d+))?$/;

/** The one tab every sport has: markets with no map and no sub-event. */
export const MATCH_SCOPE = "match";
/** Every per-player Fonbet sub-event collapses into this single tab. */
export const PLAYERS_SCOPE = "fb_players";

export function isMapScope(s: string): s is FeMapScope {
  return MAP_SCOPE_RE.test(s);
}

export function mapScopeNumber(s: string): number | null {
  const m = MAP_SCOPE_RE.exec(s);
  return m ? Number(m[1]) : null;
}

export function mapScope(n: number): FeMapScope {
  return `map_${n}`;
}

export function isCustomScope(s: string): s is FeCustomScope {
  return CUSTOM_SCOPE_RE.test(s);
}

export function isSubEventScope(s: string): s is FeSubEventScope {
  return SUB_EVENT_SCOPE_RE.test(s);
}

// Curated scopes have no implicit market pool — content is exactly the
// admin-ordered list, and the storefront renders one representative market
// per provider_market_id. Sub-event scopes are NOT curated: like `match`
// and `map_<N>` they collect whatever the feed puts in them.
export function isCuratedScope(s: string): boolean {
  return s === "top" || isCustomScope(s);
}

export function isMarketScope(s: string): s is FeMarketScope {
  return (
    s === "match" ||
    s === "top" ||
    isMapScope(s) ||
    isCustomScope(s) ||
    isSubEventScope(s)
  );
}

/** Group tag a market lands in. `order` is the default inter-tab sort key. */
export interface MarketScope {
  id: string;
  label: string;
  order: number;
}

export interface DerivedMarketScope {
  scope: MarketScope;
  /**
   * The base-name template with the sub-event prefix removed ("1st half:
   * Total {threshold}" → "Total {threshold}"). Equal to the supplied
   * baseTemplate for every non-sub-event market.
   */
  baseTemplate: string;
}

/** Splits "1st half: Total {threshold}" into its sub-event label and rest. */
export function splitSubEventLabel(
  template: string,
): { label: string; rest: string } | null {
  const sep = template.indexOf(": ");
  if (sep <= 0) return null;
  return { label: template.slice(0, sep), rest: template.slice(sep + 2) };
}

/**
 * The tab this market belongs to.
 *
 * `template` is the localised market-name template for the market's
 * (provider_market_id, variant) pair — it carries the Fonbet sub-event
 * label as a prefix and is the only source for that label. A sub-event
 * market whose template has no prefix (no description row yet, so the
 * caller passed a "Market #N" placeholder) stays on the Match tab rather
 * than opening an unlabelled tab.
 */
export function deriveMarketScope(input: {
  specifiers: Record<string, string>;
  template: string;
  /** Template with the line placeholder stripped. Defaults to `template`. */
  baseTemplate?: string;
  /** Label for the collapsed per-player tab. Defaults to "Players". */
  playersLabel?: string;
}): DerivedMarketScope {
  const { specifiers, template } = input;
  const baseTemplate = input.baseTemplate ?? template;

  let scope: MarketScope = { id: MATCH_SCOPE, label: "Match", order: 0 };
  const mapSpec = specifiers.map;
  if (mapSpec) {
    const n = Number.parseInt(mapSpec, 10);
    if (Number.isFinite(n) && n > 0) {
      scope = { id: mapScope(n), label: `Map ${n}`, order: n };
    }
  }

  const variant = specifiers.variant ?? "";
  const fb = FB_VARIANT_RE.exec(variant);
  if (!fb) return { scope, baseTemplate };

  // Per-player sub-events: one tab for all of them, no template needed.
  if (fb[2]) {
    return {
      scope: {
        id: PLAYERS_SCOPE,
        label: input.playersLabel ?? "Players",
        order: 90,
      },
      baseTemplate,
    };
  }

  const split = splitSubEventLabel(template);
  if (!split) return { scope, baseTemplate };

  const kinds = (fb[1] ?? "").split("/");
  const id = `fb_${kinds.join("_")}`;
  // Defensive: a variant shaped `fb:100201/` would produce an id the DB
  // CHECK rejects, which would make the tab configurable in the admin and
  // then fail to save. Fall back to the base tab instead.
  if (!isSubEventScope(id)) return { scope, baseTemplate };

  return {
    scope: {
      id,
      label: split.label,
      // Sub-events sort after Match (0) and every Map N. Within them, by
      // the outermost Fonbet kind, then by nesting depth so "1st half
      // corners" follows "Corners".
      order: 10 + Number(kinds[0] ?? 0) / 1e8 + kinds.length / 1e3,
    },
    baseTemplate: baseTemplate.startsWith(split.label + ": ")
      ? baseTemplate.slice(split.label.length + 2)
      : baseTemplate,
  };
}

/** Default sort key for a tab with no operator-set position. */
export function defaultScopeOrder(scope: string): number {
  if (scope === "top") return -1;
  if (scope === MATCH_SCOPE) return 0;
  const n = mapScopeNumber(scope);
  if (n != null) return n;
  if (scope === PLAYERS_SCOPE) return 90;
  if (isSubEventScope(scope)) {
    const kinds = scope.slice(3).split("_");
    return 10 + Number(kinds[0] ?? 0) / 1e8 + kinds.length / 1e3;
  }
  return Number.MAX_SAFE_INTEGER;
}
