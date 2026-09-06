// English Wikipedia lookup for tournament logos.
//
// The last resort, and the one with the most coverage for traditional
// sport. Wikidata carries a logo for roughly a fifth of the leagues we
// carry — not because the matching is weak (ZillaAGI named 30 of 30 real
// leagues correctly and the adjudicator rejected nothing that was right)
// but because the entities have no logo claim at all:
//
//   Q216022  no logo  Belgian Pro League
//   Q175762  no logo  Handball-Bundesliga
//   Q456107  no logo  Liiga
//
// Those marks are trademarked, so they cannot be hosted on Commons,
// which is what Wikidata points at. They live on Wikipedia as NON-FREE
// files used under fair use. Re-hosting them is an operator decision
// that was taken explicitly; every row records logo_source='wikipedia'
// so the whole set is revertible in one statement.
//
// TWO THINGS SHAPE THE IMPLEMENTATION.
//
// 1. The INFOBOX field, not the page's lead image. `pageimages` returns
//    whatever picture the article leads with, which for a league is
//    often a trophy photo, a stadium or a map. `|logo=` / `|image=` in
//    the infobox is the mark itself. A page with neither returns null
//    rather than something merely pictorial.
//
// 2. Titles are looked up directly with redirects followed, never
//    searched. Searching is what matched a TEAM page for a tournament on
//    Liquipedia, and the same trap exists here. The resolved title is
//    then handed to the ZAGI adjudicator like any other candidate.

const API = "https://en.wikipedia.org/w/api.php";

/**
 * Wikimedia asks for a descriptive User-Agent with contact details, and
 * enforces it — anonymous library-default agents get 403s.
 */
const USER_AGENT =
  "Oddzilla/1.0 (https://oddzilla.cc; alexander.chernavin@oddin.gg) tournament-logo-resolver";

/** Politeness pacing. Wikipedia is tolerant; we are still a bulk reader. */
const MIN_INTERVAL_MS = 250;

export interface WikipediaLogo {
  title: string;
  description: string;
  file: string;
  fileUrl: string;
  pageUrl: string;
}

export interface WikipediaClient {
  lookup(title: string): Promise<WikipediaLogo | null>;
}

/**
 * Pull the logo filename out of an infobox.
 *
 * Sports-league infoboxes use `logo`, `image` or `badge`; `logo` wins
 * when several are present because that is the mark rather than a
 * photograph. Values arrive as a bare filename, sometimes wrapped in
 * [[File:...]], and sometimes as a template call — which is rejected
 * rather than guessed at.
 */
export function extractInfoboxLogo(wikitext: string): string | null {
  // `logo` and `badge` name a mark by definition. `image` does not — on
  // "Test cricket" it is a match photograph, which the first cut happily
  // took and would have put on a cricket series. So a value from `image`
  // has to look like a mark before it is believed.
  for (const field of ["logo", "badge", "image"] as const) {
    const re = new RegExp(`\\|\\s*${field}\\s*=\\s*([^\\n|}]+)`, "iu");
    const raw = wikitext.match(re)?.[1]?.trim();
    if (!raw) continue;
    // [[File:X.svg|200px]] -> X.svg
    const bracketed = raw.match(/\[\[\s*(?:File|Image)\s*:\s*([^|\]]+)/iu)?.[1]?.trim();
    const file = (bracketed ?? raw).replace(/^(?:File|Image)\s*:\s*/iu, "").trim();
    if (!file || file.startsWith("{{") || file.length > 200) continue;
    // A JPEG is a photograph essentially every time; marks are vector or
    // lossless. Cheapest discriminator available and it costs nothing
    // real, since a league logo is not published as a JPEG.
    if (!/\.(svg|png|webp)$/iu.test(file)) continue;
    if (field === "image" && !/logo|badge|crest|wordmark|emblem/iu.test(file)) continue;
    return file;
  }
  return null;
}

export function createWikipediaClient(
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; minIntervalMs?: number } = {},
): WikipediaClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const minInterval = opts.minIntervalMs ?? MIN_INTERVAL_MS;
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

  async function call(params: Record<string, string>): Promise<Record<string, any>> {
    return schedule(async () => {
      const url = new URL(API);
      url.searchParams.set("format", "json");
      url.searchParams.set("formatversion", "2");
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(url.toString(), {
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
        });
        if (!res.ok) throw new Error(`wikipedia HTTP ${res.status}`);
        return (await res.json()) as Record<string, any>;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  return {
    async lookup(title) {
      const page = (
        await call({
          action: "query",
          prop: "revisions|extracts",
          rvprop: "content",
          rvslots: "main",
          exintro: "1",
          explaintext: "1",
          exsentences: "1",
          redirects: "1",
          titles: title,
        })
      ).query?.pages?.[0] as
        | {
            title?: string;
            missing?: boolean;
            extract?: string;
            revisions?: Array<{ slots?: { main?: { content?: string } } }>;
          }
        | undefined;

      if (!page || page.missing) return null;
      const wikitext = page.revisions?.[0]?.slots?.main?.content ?? "";
      // A disambiguation page is never the competition itself.
      if (/\{\{\s*disambiguation/iu.test(wikitext)) return null;

      const file = extractInfoboxLogo(wikitext);
      if (!file) return null;

      const info = (
        await call({
          action: "query",
          prop: "imageinfo",
          iiprop: "url",
          titles: `File:${file}`,
        })
      ).query?.pages?.[0] as { imageinfo?: Array<{ url?: string }> } | undefined;

      const fileUrl = info?.imageinfo?.[0]?.url;
      if (typeof fileUrl !== "string" || !fileUrl.startsWith("https://")) return null;

      const resolved = page.title ?? title;
      return {
        title: resolved,
        description: (page.extract ?? "").slice(0, 300),
        file,
        fileUrl,
        pageUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(resolved.replace(/ /gu, "_"))}`,
      };
    },
  };
}
