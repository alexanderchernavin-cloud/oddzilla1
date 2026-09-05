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
import {
  deriveMarketScope,
  type MarketScope,
} from "@oddzilla/types/market-scope";

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

// Feed catalogues name a per-team market by NUMBER, not by team: Fonbet
// ships "Team 1 totals {threshold}" / "Инд. тоталы-1 {threshold}" for the
// home side and the -2 twin for the away side, "1 to win" / "Победа 1",
// and a handful of captions where its own `%1` / `%2` team placeholder
// leaked into the market name instead of an outcome label. Rendered
// verbatim that reads "Team 1 totals 2.5" on a page showing Swansea vs
// Wrexham: the market is about exactly one of them and does not say
// which — and the same string is what the bet slip stores as the leg
// label, so the bettor cannot tell afterwards either.
//
// Number 1 is always the home side and 2 the away side, the same
// convention Fonbet's own factor ids use (`1` home / `2` away / `3` draw)
// and the one `{side}` and the bare "home" / "away" outcome templates
// already follow.
//
// Every pattern is anchored over the whole label so nothing else in the
// catalogue can be caught by accident. Measured against the full live
// catalogue (2026-09-05, 6 282 description rows in en + ru): these six
// shapes cover every team-numbered label, and the near misses stay
// untouched — "1x2", "Score after 2 goals scored", "Score after 2 maps",
// "Score after 2 sets", "score in the series after 2 matches". Anything
// that matches nothing is returned unchanged, so a caption Fonbet adds
// later degrades to today's wording rather than to a wrong team.
const TEAM_NUMBER_RULES: Array<{
  re: RegExp;
  build: (team: string, rest: string) => string;
}> = [
  // en: "Team 1 totals {threshold}"
  { re: /^Team ([12])\s+(.+)$/i, build: (team, rest) => `${team} ${rest}` },
  // en: "Team Totals-1 {threshold}" — same market, different table.
  {
    re: /^Team Totals-([12])\b\s*(.*)$/i,
    build: (team, rest) => `${team} totals ${rest}`,
  },
  // en: "1 to win"
  { re: /^([12]) to win$/i, build: (team) => `${team} to win` },
  // ru: "Инд. тоталы-1 {threshold}"
  {
    re: /^Инд\.\s*тотал[а-я]*-([12])\b\s*(.*)$/i,
    build: (team, rest) => `Инд. тотал ${team} ${rest}`,
  },
  // ru: "Победа 1"
  { re: /^Победа ([12])$/i, build: (team) => `Победа ${team}` },
  // Either language: "%1 Total round in 1st half {threshold}".
  { re: /^%([12])\s+(.+)$/, build: (team, rest) => `${team} ${rest}` },
];

// Swaps a team-numbered label for the team's actual name. Runs on the
// rendered string (placeholders already substituted) so a team name can
// never be re-read as a placeholder, and on the part after any sub-event
// prefix so "1st half: Team 1 totals 2.5" keeps its tab label.
export function applyTeamNumberLabel(
  label: string,
  teams: TeamNamePair,
): string {
  const sep = label.indexOf(": ");
  const prefix = sep > 0 ? label.slice(0, sep + 2) : "";
  const base = sep > 0 ? label.slice(sep + 2) : label;
  for (const rule of TEAM_NUMBER_RULES) {
    const m = rule.re.exec(base);
    if (!m) continue;
    const team = m[1] === "1" ? teams.homeTeam : teams.awayTeam;
    if (!team) return label;
    return (prefix + rule.build(team, (m[2] ?? "").trim())).trim();
  }
  return label;
}

// Placeholder substitution alone. Used directly for OUTCOME labels,
// which must not pick up the team-number rewrite below: an outcome sits
// under a market header that already names the team, and Fonbet writes
// some of them mid-sentence ("Фрейм %P: инд. тотал-2 ударов Больше"),
// where swapping the number for a team name reads as broken grammar
// rather than as a clarification.
function substituteCore(
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

// Renders a MARKET name. On top of placeholder substitution it swaps a
// team-numbered caption for the team it means, so a caller holding the
// match gets "Swansea totals 2.5" where the catalogue said "Team 1
// totals 2.5". Callers without teams — the admin feed log, the
// backoffice market pickers — keep the generic caption, which is the
// right label there: no fixture is in hand to name.
export function substituteTemplate(
  template: string,
  specs: Record<string, string>,
  teams?: TeamNamePair,
  profiles?: OutcomeProfiles,
  locale?: string,
): string {
  const rendered = substituteCore(template, specs, teams, profiles, locale);
  return teams ? applyTeamNumberLabel(rendered, teams) : rendered;
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
  // substituteCore, not substituteTemplate: the team-number rewrite is a
  // market-name rule (see the comment on substituteCore).
  const sub = substituteCore(template, specs, { homeTeam, awayTeam }, profiles, locale);
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
// The grammar, the full derivation (Fonbet sub-events included) and the
// tab-ordering defaults live in `@oddzilla/types/market-scope`, shared
// with the web admin and mirrored by the DB CHECK constraints.
export type { MarketScope };
export { deriveMarketScope };

// Specifier-only scope: Match or Map N. A Fonbet sub-event tab also needs
// the market's name template — that is where the label lives — so callers
// holding one (the match-detail endpoint, the admin scope discovery) call
// `deriveMarketScope` instead. This narrower form stays for callers that
// only ever see Oddin markets (admin feed logs, ZillaBuild), where a
// `variant` never opens a tab.

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
