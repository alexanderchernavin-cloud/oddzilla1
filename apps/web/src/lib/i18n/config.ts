// Locale list + the cookie name the runtime persists the choice in.
// Kept in a tiny module so server and client code can both import without
// pulling in the dictionary loader (which is server-only because it
// `import`s JSON files from the messages/ dir).
//
// Adding a new locale is two steps:
//   1. add the slug to LOCALES below
//   2. drop a `messages/<slug>.json` file with the same shape as en.json
//
// The cookie is set via a tiny server action in `actions.ts`; the
// middleware does NOT touch the locale cookie — locale is a soft user
// preference, not an auth signal.

export const LOCALES = ["en", "cs", "pt", "ru", "es"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

// The cookie name the storefront persists the locale choice in. Same
// cookie-domain rules as the auth cookies (set via `Domain=.oddzilla.cc`
// in actions.ts), so picking a language on the apex applies on the
// admin subdomain too.
export const LOCALE_COOKIE = "oz_locale";

// Human-readable labels for the language switcher. Each label is the
// language's endonym (how speakers of that language write it) so a
// French speaker recognises "Português" without having to know its
// English name. Synced with the `languages` block in each messages/*.json
// — duplicated here so the switcher can render before the dictionary
// for the target locale has been loaded.
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  cs: "Čeština",
  pt: "Português",
  ru: "Русский",
  es: "Español",
};

export function isLocale(value: string | null | undefined): value is Locale {
  if (!value) return false;
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * Best-effort parse of an Accept-Language header. Returns the highest
 * quality locale that we ship messages for, or null when nothing
 * matches. We do NOT care about region tags (en-US, pt-BR) for the
 * first pass — just the primary subtag.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale | null {
  if (!acceptLanguage) return null;
  // Split on commas, trim, peel off the optional `;q=N` quality.
  const parts = acceptLanguage.split(",").map((s) => s.trim());
  // Build [(primarySubtag, q)] sorted by q desc.
  const ranked: Array<{ tag: string; q: number }> = [];
  for (const part of parts) {
    if (!part) continue;
    const [rawTag, ...attrs] = part.split(";");
    if (!rawTag) continue;
    const tag = rawTag.trim().toLowerCase();
    if (!tag) continue;
    let q = 1;
    for (const a of attrs) {
      const m = a.trim().match(/^q=([0-9.]+)$/);
      if (m && m[1]) {
        const parsed = parseFloat(m[1]);
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    ranked.push({ tag, q });
  }
  ranked.sort((a, b) => b.q - a.q);
  for (const r of ranked) {
    // Try exact match first ("pt-br" → only matches if we ship pt-br),
    // then primary subtag.
    if (isLocale(r.tag)) return r.tag;
    const primary = r.tag.split("-")[0];
    if (primary && isLocale(primary)) return primary;
  }
  return null;
}
