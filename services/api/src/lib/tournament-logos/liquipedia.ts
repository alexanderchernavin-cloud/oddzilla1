// Liquipedia lookup for esports tournament logos.
//
// Wikidata is close to useless here — measured 9% on a real sample, and
// it has no entity at all for DreamLeague, BLAST Slam, PGL Wallachia,
// ESL Challenger League or CrossFire Pro League. Liquipedia has all of
// them, and it is where the esports world actually keeps this.
//
// TWO THINGS SHAPE THIS MODULE.
//
// 1. We look pages up BY TITLE, never by full-text search. Searching is
//    what produced the one dangerous result in the probe: "PGL Wallachia"
//    returned the page "Team Falcons", whose infobox image is a TEAM
//    crest. Putting a team's badge on a tournament is exactly the class
//    of silent error that is worse than a blank. A title lookup is exact
//    by construction, and `redirects=1` still forgives the ordinary
//    aliases. The title guard is re-asserted in code anyway.
//
// 2. We obey their API etiquette rather than hammering it: an
//    identifying User-Agent with contact details, and a minimum 2s
//    between calls, serialised through this client. Liquipedia is a
//    volunteer wiki and is explicit about both.
//
// LICENSING, STATED PLAINLY: Liquipedia text is CC-BY-SA but the logos
// are largely NON-FREE marks used there under fair use. Re-hosting them
// is a heavier act than linking, so every row records
// logo_source='liquipedia' and its source page — one query reverts the
// entire set if that call is ever revisited.

/** Our sport slug → Liquipedia wiki. Absent = no wiki worth asking. */
const WIKI_BY_SPORT: Readonly<Record<string, string>> = {
  cs2: "counterstrike",
  dota2: "dota2",
  lol: "leagueoflegends",
  valorant: "valorant",
  r6: "rainbowsix",
  overwatch: "overwatch",
  sc2: "starcraft2",
  cod: "callofduty",
  pubg: "pubg",
  "pubg-mobile": "pubgmobile",
  rocketleague: "rocketleague",
  w3: "warcraft",
  aoe: "ageofempires",
  aov: "arenaofvalor",
  ml: "mobilelegends",
  crossfire: "crossfire",
  "apex-legends": "apexlegends",
  halo: "halo",
  brawlstars: "brawlstars",
  freefire: "freefire",
  smash: "smash",
  // Deliberately absent: the *-duels products and Oddin's simulated
  // e-sports (efootball, ebasketball, ecricket, etouchdown). Those are
  // bot-played fixtures with no wiki presence, and asking costs a
  // request per tournament to learn nothing.
};

export function wikiForSport(slug: string): string | null {
  return WIKI_BY_SPORT[slug.trim().toLowerCase()] ?? null;
}

export function normaliseTitle(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[_\s]+/gu, " ")
    .replace(/[^a-z0-9 ]+/gu, "")
    .trim();
}

/**
 * Pull the infobox logo filename out of page wikitext.
 *
 * Liquipedia's league infoboxes carry `|image=` (and often
 * `|imagedark=`); we take the light one, which is what renders on our
 * light-default storefront. Returns null rather than guessing when the
 * page has no image field — a tier-listing page like "S-Tier
 * Tournaments" has none, and that is the correct answer for it.
 */
export function extractInfoboxImage(wikitext: string): string | null {
  const m =
    wikitext.match(/\|\s*image\s*=\s*([^\n|}]+)/iu) ??
    wikitext.match(/\|\s*imagelight\s*=\s*([^\n|}]+)/iu);
  const file = m?.[1]?.trim();
  if (!file) return null;
  // Guard against template noise and empty assignments.
  if (file.length < 3 || file.length > 200 || file.startsWith("{{")) return null;
  return file;
}

export interface LiquipediaLogo {
  title: string;
  file: string;
  fileUrl: string;
  pageUrl: string;
}

export interface LiquipediaClient {
  lookup(wiki: string, title: string): Promise<LiquipediaLogo | null>;
}

const USER_AGENT =
  "Oddzilla/1.0 (https://oddzilla.cc; alexander.chernavin@oddin.gg) tournament-logo-resolver";

/** Their documented floor is 2s between api.php calls. */
const MIN_INTERVAL_MS = 2100;

export function createLiquipediaClient(
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; minIntervalMs?: number } = {},
): LiquipediaClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const minInterval = opts.minIntervalMs ?? MIN_INTERVAL_MS;
  // Serialised: concurrent callers would defeat the rate limit.
  let chain: Promise<unknown> = Promise.resolve();
  let lastCall = 0;

  function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const wait = lastCall + minInterval - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        lastCall = Date.now();
      }
    });
    chain = run.catch(() => undefined);
    return run as Promise<T>;
  }

  async function call(wiki: string, params: Record<string, string>): Promise<Record<string, any>> {
    return schedule(async () => {
      const url = new URL(`https://liquipedia.net/${wiki}/api.php`);
      url.searchParams.set("format", "json");
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(url.toString(), {
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT, "accept-encoding": "gzip", accept: "application/json" },
        });
        if (!res.ok) throw new Error(`liquipedia HTTP ${res.status}`);
        return (await res.json()) as Record<string, any>;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  return {
    async lookup(wiki, title) {
      const rev = await call(wiki, {
        action: "query",
        prop: "revisions",
        rvprop: "content",
        rvslots: "main",
        redirects: "1",
        titles: title,
      });
      const pages = rev.query?.pages ?? {};
      const page = Object.values(pages)[0] as
        | { title?: string; missing?: string; revisions?: Array<{ slots?: { main?: { "*"?: string } } }> }
        | undefined;
      if (!page || page.missing !== undefined) return null;

      // Re-assert the title guard after redirect resolution: a redirect
      // to a broader page ("BLAST Rivals" -> "S-Tier Tournaments") is
      // not the thing we asked for.
      const resolved = page.title ?? "";
      if (normaliseTitle(resolved) !== normaliseTitle(title)) return null;

      const wikitext = page.revisions?.[0]?.slots?.main?.["*"] ?? "";
      const file = extractInfoboxImage(wikitext);
      if (!file) return null;

      const info = await call(wiki, {
        action: "query",
        prop: "imageinfo",
        iiprop: "url",
        titles: `File:${file}`,
      });
      const ipages = info.query?.pages ?? {};
      const ipage = Object.values(ipages)[0] as
        | { imageinfo?: Array<{ url?: string }> }
        | undefined;
      const fileUrl = ipage?.imageinfo?.[0]?.url;
      if (typeof fileUrl !== "string" || !fileUrl.startsWith("https://")) return null;

      return {
        title: resolved,
        file,
        fileUrl,
        pageUrl: `https://liquipedia.net/${wiki}/${encodeURIComponent(resolved.replace(/ /gu, "_"))}`,
      };
    },
  };
}
