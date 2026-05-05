// Shared rendering of market + outcome names for both the storefront
// (/catalog/matches/:id) and the admin feed-logs panel.
//
// Templates come from market_descriptions / outcome_descriptions which
// feed-ingester refreshes from Oddin's /v1/descriptions/{lang}/markets
// endpoint. {placeholder} tokens are substituted from the market's own
// specifiers_json. URN-style outcome ids (od:competitor:N, od:player:N)
// resolve via the cached profile maps the caller passes in.

export function substituteTemplate(
  template: string,
  specs: Record<string, string>,
): string {
  const out = template.replace(/\{([a-z0-9_]+)\}/gi, (_, key: string) => {
    const v = specs[key];
    return v == null ? `{${key}}` : v;
  });
  return out.replace(/\s{2,}/g, " ").replace(/\s-\s$/, "").trim();
}

export function renderOutcomeLabel(
  template: string,
  specs: Record<string, string>,
  homeTeam: string,
  awayTeam: string,
): string {
  const sub = substituteTemplate(template, specs);
  const lower = sub.trim().toLowerCase();
  if (lower === "home") return homeTeam;
  if (lower === "away") return awayTeam;
  if (lower === "draw") return "Draw";
  if (lower === "under") return "Under";
  if (lower === "over") return "Over";
  if (/^(home|away|draw)(\s*[/&,]\s*(home|away|draw))+$/i.test(lower)) {
    return lower
      .split(/\s*([/&,])\s*/)
      .map((t) =>
        t === "home" ? homeTeam : t === "away" ? awayTeam : t === "draw" ? "Draw" : t,
      )
      .join(" ");
  }
  return sub;
}

export function descKey(providerMarketId: number, variant: string): string {
  return `${providerMarketId}:${variant ?? ""}`;
}

export function outcomeDescKey(
  providerMarketId: number,
  variant: string,
  outcomeId: string,
): string {
  return `${providerMarketId}:${variant ?? ""}:${outcomeId}`;
}

// Group tag a market lands in on the storefront (Match / Map 1 / …).
// `order` is used as the inter-group sort key (lower = earlier).
export type MarketScope = { id: string; label: string; order: number };

export function deriveScope(specs: Record<string, string>): MarketScope {
  if (specs.map) {
    const n = Number.parseInt(specs.map, 10);
    if (Number.isFinite(n) && n > 0) {
      return { id: `map_${n}`, label: `Map ${n}`, order: n };
    }
  }
  return { id: "match", label: "Match", order: 0 };
}

// Outcome sort weight for Oddin's canonical numeric outcome_ids. Three-way
// markets render 1 / X / 2 (home / draw / away) — Oddin assigns "3" to the
// draw, so it gets a weight of 1.5 to slot between home and away. Returns
// null for non-numeric ids (URNs, "under"/"over", …) so callers can keep
// them in insertion order behind the numeric block.
export function outcomeSortWeight(id: string): number | null {
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n) || String(n) !== id) return null;
  if (n === 3) return 1.5;
  return n;
}
