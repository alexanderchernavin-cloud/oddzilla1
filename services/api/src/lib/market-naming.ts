// Shared rendering of market + outcome names for both the storefront
// (/catalog/matches/:id) and the admin feed-logs panel.
//
// Templates come from market_descriptions / outcome_descriptions which
// feed-ingester refreshes from Oddin's /v1/descriptions/{lang}/markets
// endpoint. {placeholder} tokens are substituted from the market's own
// specifiers_json. URN-style outcome ids (od:competitor:N, od:player:N)
// resolve via the cached profile maps the caller passes in.

// teams is the optional pair of team-name resolvers used to translate
// Oddin's "{side}" specifier. Without them the template falls back to
// the literal word — "Team away total goals 2.5" — which is what the
// API returned before this argument existed; storefront callers should
// always pass them so the market reads as "Team Astralis total goals
// 2.5" instead. Admin / debug callers that have no match context can
// keep the no-arg form.
export interface TeamNamePair {
  homeTeam: string;
  awayTeam: string;
}

// URN-name lookup for Oddin's URN-shaped outcome ids and specifier
// values. Two flavours: competitor (team) URNs like `od:competitor:42`
// and player URNs like `od:player:1670`. Both resolve via the cached
// profile tables `competitor_profiles` and `player_profiles`.
//
// Caller responsibility: pre-fetch the URNs you'll touch (scan
// `specifiers` values and the outcomeId/template, collect URN-prefixed
// strings, batch-load the profile rows) and pass the resulting maps
// in. Helpers below resolve at substitution time when a `{key}`
// expands to a URN value, AND when the bare template IS a URN
// (player-prop markets where outcome_descriptions has nothing and
// outcomeId falls through as the label).
export interface OutcomeProfiles {
  competitors?: Map<string, string>;
  players?: Map<string, string>;
}

const COMPETITOR_URN_PREFIX = "od:competitor:";
const PLAYER_URN_PREFIX = "od:player:";

// Oddin's `{sport_side}` specifier carries in-game side names that are
// NOT localised by their /descriptions endpoint — the wire value is the
// same `counter_terrorist`/`terrorist`/`attacker`/`defender` enum
// regardless of language. Without humanisation the market title leaks
// the raw snake_case enum (e.g. "counter_terrorist Total rounds 12.5
// (Excl. Overtime) - map 1"). Note: these are *sides within a map*,
// not teams — CS2 / Valorant teams swap sides at half-time, so mapping
// side → team would misrepresent the market's meaning. Keep the side
// label.
const SPORT_SIDE_LABELS_EN: Record<string, string> = {
  counter_terrorist: "Counter-Terrorist",
  terrorist: "Terrorist",
  attacker: "Attacker",
  defender: "Defender",
};
const SPORT_SIDE_LABELS_BY_LOCALE: Record<string, Record<string, string>> = {
  ru: {
    counter_terrorist: "Контр-Террористы",
    terrorist: "Террористы",
    attacker: "Атакующие",
    defender: "Защитники",
  },
  cs: {
    counter_terrorist: "Counter-Terrorist",
    terrorist: "Terrorist",
    attacker: "Útočníci",
    defender: "Obránci",
  },
  pt: {
    counter_terrorist: "Counter-Terrorist",
    terrorist: "Terrorist",
    attacker: "Atacantes",
    defender: "Defensores",
  },
  es: {
    counter_terrorist: "Counter-Terrorist",
    terrorist: "Terrorist",
    attacker: "Atacantes",
    defender: "Defensores",
  },
};

function humaniseSnakeCase(v: string): string {
  return v
    .split("_")
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function isCompetitorUrn(value: string): boolean {
  return value.startsWith(COMPETITOR_URN_PREFIX);
}

export function isPlayerUrn(value: string): boolean {
  return value.startsWith(PLAYER_URN_PREFIX);
}

// Resolve a single URN-style value via the provided profile maps.
// Returns the original string when the value isn't a URN, when no
// profile map is provided, or when the URN isn't in the map (the
// profile table can lag the feed for fresh competitors / players).
function resolveUrn(value: string, profiles?: OutcomeProfiles): string {
  if (!profiles) return value;
  if (profiles.competitors && isCompetitorUrn(value)) {
    return profiles.competitors.get(value) ?? value;
  }
  if (profiles.players && isPlayerUrn(value)) {
    return profiles.players.get(value) ?? value;
  }
  return value;
}

export function substituteTemplate(
  template: string,
  specs: Record<string, string>,
  teams?: TeamNamePair,
  profiles?: OutcomeProfiles,
  locale?: string,
): string {
  const out = template.replace(/\{([a-z0-9_]+)\}/gi, (_, key: string) => {
    let v = specs[key];
    if (v == null) return `{${key}}`;
    // Special-case the "side" specifier: when the caller has the
    // match's team names, render the actual team instead of the
    // literal "home" / "away" word. Markets like "Team {side} total
    // goals {threshold}" then read "Team Astralis total goals 2.5".
    if (key === "side" && teams) {
      if (v === "home") return teams.homeTeam;
      if (v === "away") return teams.awayTeam;
    }
    // Oddin's localized templates contain {way} but the value stays
    // literal English ("two"/"three"). Surrounding nouns ARE
    // translated, so the raw render reads "Победитель матча - three
    // исхода" or "Vencedor da partida - threeopções". Substituting a
    // digit for non-EN locales makes the line scan as "3 исхода" /
    // "3 opções" which is readable. EN keeps the words because that
    // is Oddin's intended reading (Match winner - threeway).
    if (key === "way" && locale && locale !== "en") {
      if (v === "two") v = "2";
      else if (v === "three") v = "3";
    }
    // `{sport_side}` flows in as a raw enum (`counter_terrorist`,
    // `terrorist`, `attacker`, `defender`). Map to a per-locale label;
    // fall through to title-cased snake_case for any future value
    // Oddin adds (so a hypothetical `blue` renders as `Blue`).
    if (key === "sport_side") {
      const localised =
        (locale && SPORT_SIDE_LABELS_BY_LOCALE[locale]?.[v]) ||
        SPORT_SIDE_LABELS_EN[v];
      if (localised) return localised;
      return humaniseSnakeCase(v);
    }
    // URN substitution. `{player}` -> `od:player:1670` -> "Niko".
    // `{competitor1}` etc work the same. Falls back to the URN
    // verbatim when the profile map has nothing — better than
    // dropping the value silently.
    return resolveUrn(v, profiles);
  });
  let cleaned = out.replace(/\s{2,}/g, " ").replace(/\s-\s$/, "").trim();
  // Per-locale Oddin catalogue oddities. Czech templates leave the
  // literal English "way" suffix after {way} ("Vítěz zápasu – 3way");
  // strip it so we read "...– 3". Portuguese sometimes jams the digit
  // against the noun ("3opções") or uses "forma" with no space; insert
  // a space so the digit isn't fused to the next word.
  if (locale === "cs") {
    cleaned = cleaned.replace(/(\d+)way\b/g, "$1");
  } else if (locale === "pt") {
    cleaned = cleaned.replace(/(\d+)(opç|opc|forma)/gi, "$1 $2");
  }
  return cleaned.replace(/\s{2,}/g, " ").trim();
}

export function renderOutcomeLabel(
  template: string,
  specs: Record<string, string>,
  homeTeam: string,
  awayTeam: string,
  profiles?: OutcomeProfiles,
  locale?: string,
): string {
  // When `template` itself is a URN — happens when the caller
  // fell back to outcomeId because outcome_descriptions had no row
  // — resolve via the profile map directly. Don't pre-empt the
  // existing template path on non-URN templates; just short-circuit
  // the URN-as-template case.
  if (profiles && (isCompetitorUrn(template) || isPlayerUrn(template))) {
    const resolved = resolveUrn(template, profiles);
    if (resolved !== template) return resolved;
  }
  const sub = substituteTemplate(template, specs, { homeTeam, awayTeam }, profiles, locale);
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
