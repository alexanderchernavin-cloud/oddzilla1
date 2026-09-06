// Wikidata lookup for tournament logos.
//
// WHY THIS IS GUARDED THE WAY IT IS
//
// Measured against real production names before any of this was written:
// taking Wikidata's top search hit is wrong often enough to matter, and
// wrong in a way that is invisible to a type checker and embarrassing on
// the storefront.
//
//   "Eredivisie"          -> the Dutch ICE HOCKEY league, not football
//   "EuroLeague"          -> EuroLeagueWomen.png, not the men's competition
//   "Liiga" (ice hockey)  -> "Naisten Liiga logo.png"  (naisten = women's)
//
// The last two are the dangerous shape: the MEN'S entity frequently
// carries no P154 logo claim at all, so a search that merely filters by
// sport happily falls through to the women's competition, which does.
// Putting the women's EuroLeague crest on the men's league is worse than
// leaving it blank.
//
// So a candidate is accepted only when THREE things hold, all checked in
// code rather than hoped for:
//
//   1. it has a logo (P154), and
//   2. its sport (P641) matches the tournament's sport, or it claims no
//      sport at all, and
//   3. its LABEL matches the canonical name we searched for, compared on
//      a normalised form. This is the guard that catches the women's
//      case: "EuroLeague Women" does not equal "EuroLeague".
//
// Rule 3 is deliberately strict rather than fuzzy. A near-miss here is a
// different competition, not a spelling variant.

/** Wikidata QIDs for the sports we carry, keyed by our slug. */
const SPORT_QIDS: Readonly<Record<string, readonly string[]>> = {
  football: ["Q2736"],
  basketball: ["Q5372"],
  "basketball-3x3": ["Q5372"],
  baseball: ["Q5369"],
  "ice-hockey": ["Q41466"],
  handball: ["Q8418"],
  tennis: ["Q847"],
  "table-tennis": ["Q3930"],
  volleyball: ["Q1734"],
  "beach-volleyball": ["Q4543"],
  cricket: ["Q5375"],
  rugby: ["Q5378", "Q10962"],
  futsal: ["Q17299"],
  "american-football": ["Q41323"],
  "aussie-rules": ["Q170645"],
  mma: ["Q114466"],
  boxing: ["Q32112"],
  cycling: ["Q53121"],
  darts: ["Q159821"],
  snooker: ["Q13230"],
  billiards: ["Q13230"],
  badminton: ["Q7291"],
  floorball: ["Q184832"],
  bandy: ["Q184901"],
  "water-polo": ["Q1734", "Q1509"],
  "beach-soccer": ["Q2736"],
  chess: ["Q718"],
  lacrosse: ["Q185851"],
  motorsport: ["Q5386"],
};

export function sportQids(slug: string): readonly string[] {
  return SPORT_QIDS[slug.trim().toLowerCase().replace(/-fb-\d+$/u, "")] ?? [];
}

/** Wikidata's "esports" (Q300920). */
const ESPORTS_QID = "Q300920";

/**
 * Our esports slugs. They are handled separately because the sport
 * taxonomy does not fit them: Wikidata tags some esports competitions
 * with `sport = esports` and others with the GAME (League of Legends,
 * Q223341), so a fixed QID list per slug rejects half of them.
 */
const ESPORTS_SLUGS: ReadonlySet<string> = new Set([
  "cs2", "cs2-duels", "dota2", "dota2-duels", "lol", "valorant", "r6",
  "overwatch", "sc2", "cod", "pubg", "pubg-mobile", "rocketleague", "w3",
  "aoe", "aov", "ml", "crossfire", "apex-legends", "geoguessr", "halo",
  "efootball", "ebasketball", "ecricket", "etouchdown", "efootballbots",
  "ebasketballbots",
]);

/** P31 values that mean "this is an esports competition". */
const ESPORTS_TYPE_QIDS: ReadonlySet<string> = new Set([
  "Q63349452", // esports league
  "Q48004378", // esport competition
]);

/**
 * P31 values that mean "this is a competition at all".
 *
 * This is the check that was missing, and its absence put the logo of
 * **Tcl, the scripting language**, on a Turkish League of Legends
 * tournament: "TCL" matched the label exactly, Tcl carries a logo, and
 * with no sport claim on either side nothing else objected. An entity
 * has to BE a competition before its logo can represent one.
 */
const COMPETITION_TYPE_QIDS: ReadonlySet<string> = new Set([
  "Q623109", // sports league
  "Q18608583", // recurring sporting event
  "Q13406554", // sports competition
  "Q27020041", // sports season
  "Q15275719", // recurring event
  "Q500834", // tournament
  "Q16510064", // sporting event
  "Q4438121", // sports organization
  ...ESPORTS_TYPE_QIDS,
]);

export function isEsportsSlug(slug: string): boolean {
  return ESPORTS_SLUGS.has(slug.trim().toLowerCase());
}

/**
 * Normalise a name for comparison: lowercase, strip accents, drop
 * punctuation and collapse whitespace. Used for the label guard, so it
 * must be forgiving about typography and unforgiving about words.
 */
export function normaliseLabel(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export interface WikidataCandidate {
  qid: string;
  label: string;
  description: string;
  logoFile: string | null;
  sportQids: string[];
  /** P31 "instance of" — what the entity actually IS. */
  instanceOf: string[];
  /**
   * The entity's other names. Wikidata files a league under one label
   * and lists the rest here — "Belgian First Division A" with "Belgian
   * Pro League" among its aliases — and matching only the label threw
   * away most of the traditional-sport coverage: measured on 30 real
   * leagues, ZillaAGI named them all correctly and 20 were then dropped
   * for having the right name in the wrong field.
   */
  aliases: string[];
}

/**
 * Is this entity the right KIND of thing, in the right domain?
 *
 * Split out because it is where both production mis-matches came from,
 * and neither was a near-miss on the name:
 *
 *   "TCL"        -> Tcl, the scripting language        (no sport, no competition type)
 *   "EMEA Masters" -> European Masters, a SNOOKER event (sport claim we never checked)
 *
 * Esports are judged separately: Wikidata tags some esports competitions
 * `sport = esports` and others with the game itself, so a per-slug QID
 * list rejects half of them. An esports competition type, or an explicit
 * esports sport claim, is the evidence we accept.
 */
export function domainMatches(c: WikidataCandidate, sportSlug: string): boolean {
  if (isEsportsSlug(sportSlug)) {
    if (c.instanceOf.some((q) => ESPORTS_TYPE_QIDS.has(q))) return true;
    return c.sportQids.includes(ESPORTS_QID);
  }

  const wanted = sportQids(sportSlug);
  // A sport claim we can evaluate is the strongest signal either way.
  if (wanted.length > 0 && c.sportQids.length > 0) {
    return c.sportQids.some((q) => wanted.includes(q));
  }
  // Otherwise it must at least be a competition. Plenty of real league
  // items omit P641; nothing that omits BOTH deserves the benefit of the
  // doubt.
  return c.instanceOf.some((q) => COMPETITION_TYPE_QIDS.has(q));
}

export interface LogoMatch {
  qid: string;
  label: string;
  description: string;
  logoFile: string;
  fileUrl: string;
  entityUrl: string;
}

/**
 * Pick the one acceptable candidate, or null.
 *
 * Pure, so the guard that actually protects the storefront is unit
 * tested rather than only exercised against a live API.
 */
export function pickCandidate(
  candidates: readonly WikidataCandidate[],
  opts: { canonicalName: string; sportSlug: string },
): LogoMatch | null {
  const wanted = sportQids(opts.sportSlug);
  const target = normaliseLabel(opts.canonicalName);
  if (!target) return null;

  for (const c of candidates) {
    if (!c.logoFile) continue;
    // Name check first — cheapest, and it still catches the women's /
    // youth / reserve variants, since "EuroLeague Women" is neither the
    // label nor an alias of "EuroLeague". Aliases count because a league
    // is routinely filed under one of its several names.
    const names = [c.label, ...c.aliases].map(normaliseLabel);
    if (!names.includes(target)) continue;
    // Then: is it the right kind of thing, in the right domain? An exact
    // label match is not evidence on its own — "TCL" matched a scripting
    // language and "EMEA Masters" matched a snooker event.
    if (!domainMatches(c, opts.sportSlug)) continue;
    return {
      qid: c.qid,
      label: c.label,
      description: c.description,
      logoFile: c.logoFile,
      fileUrl: commonsFileUrl(c.logoFile),
      entityUrl: `https://www.wikidata.org/wiki/${c.qid}`,
    };
  }
  return null;
}

export function commonsFileUrl(file: string): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}`;
}

const API = "https://www.wikidata.org/w/api.php";

/**
 * Contact details in the User-Agent are what Wikimedia's API etiquette
 * asks for, and the thing that keeps us from being blocked as an
 * anonymous scraper.
 */
const USER_AGENT =
  "Oddzilla/1.0 (https://oddzilla.cc; alexander.chernavin@oddin.gg) tournament-logo-resolver";

export interface WikidataClient {
  candidates(term: string): Promise<WikidataCandidate[]>;
}

export function createWikidataClient(opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): WikidataClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  async function call(params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(API);
    url.searchParams.set("format", "json");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url.toString(), {
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
      });
      if (!res.ok) throw new Error(`wikidata HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async candidates(term) {
      const search = (await call({
        action: "wbsearchentities",
        search: term,
        language: "en",
        uselang: "en",
        limit: "5",
        type: "item",
      })) as { search?: Array<{ id?: string; label?: string; description?: string }> };

      const hits = (search.search ?? []).filter((h) => typeof h.id === "string");
      if (hits.length === 0) return [];

      const entities = (await call({
        action: "wbgetentities",
        ids: hits.map((h) => h.id).join("|"),
        props: "claims|labels|aliases",
        languages: "en",
      })) as {
        entities?: Record<
          string,
          {
            labels?: { en?: { value?: string } };
            aliases?: { en?: Array<{ value?: string }> };
            claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: unknown } } }>>;
          }
        >;
      };

      return hits.map((h) => {
        const ent = entities.entities?.[h.id!];
        const claims = ent?.claims ?? {};
        const logo = claims.P154?.[0]?.mainsnak?.datavalue?.value;
        const idsOf = (prop: string): string[] =>
          (claims[prop] ?? [])
            .map((c) => {
              const v = c.mainsnak?.datavalue?.value as { id?: string } | undefined;
              return typeof v?.id === "string" ? v.id : null;
            })
            .filter((v): v is string => v !== null);
        return {
          qid: h.id!,
          label: ent?.labels?.en?.value ?? h.label ?? "",
          description: h.description ?? "",
          logoFile: typeof logo === "string" ? logo : null,
          sportQids: idsOf("P641"),
          instanceOf: idsOf("P31"),
          aliases: (ent?.aliases?.en ?? [])
            .map((a) => a.value)
            .filter((v): v is string => typeof v === "string"),
        };
      });
    },
  };
}
