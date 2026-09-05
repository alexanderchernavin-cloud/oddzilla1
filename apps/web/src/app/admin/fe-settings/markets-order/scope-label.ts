import {
  PLAYERS_SCOPE,
  mapScopeNumber,
} from "@oddzilla/types/market-scope";

export interface ScopeTab {
  scope: string;
  /**
   * Set for tabs whose title comes from the feed (Fonbet sub-events) or from
   * the operator (custom groups). Null for the tabs named below, which the
   * backoffice labels itself.
   */
  label: string | null;
  custom: boolean;
}

/** Tab title, matching what the storefront's scopeLabel() renders. */
export function tabLabel(tab: { scope: string; label: string | null }): string {
  if (tab.label) return tab.label;
  if (tab.scope === "match") return "Match";
  if (tab.scope === "top") return "Top";
  const n = mapScopeNumber(tab.scope);
  if (n != null) return `Map ${n}`;
  if (tab.scope === PLAYERS_SCOPE) return "Players";
  return tab.scope;
}
