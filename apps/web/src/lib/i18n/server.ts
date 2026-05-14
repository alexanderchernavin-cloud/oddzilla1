// Server-side i18n. Used in Server Components, Server Actions, and the
// root layout to:
//   1. Resolve the active locale (cookie > Accept-Language > default)
//   2. Load the matching message dictionary
//   3. Hand both to the client provider for hydration
//   4. Expose a `getTranslations` analogue for direct SSR use
//
// Keep this file `import "server-only"` so a client component doesn't
// accidentally pull in the synchronous JSON dictionary loader.

import "server-only";
import { cookies, headers } from "next/headers";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  isLocale,
  negotiateLocale,
  type Locale,
} from "./config";
import { formatMessage, type FormatValues } from "./format";
import { getMessages, type Messages } from "./messages";

/**
 * Resolve the locale for the current request. Order:
 *   1. `oz_locale` cookie (set by the language switcher server action)
 *   2. `Accept-Language` header (best match against shipped locales)
 *   3. DEFAULT_LOCALE
 */
export async function getServerLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(LOCALE_COOKIE)?.value ?? null;
  if (isLocale(cookieValue)) return cookieValue;
  const h = await headers();
  const negotiated = negotiateLocale(h.get("accept-language"));
  if (negotiated) return negotiated;
  return DEFAULT_LOCALE;
}

export async function getServerMessages(): Promise<{ locale: Locale; messages: Messages }> {
  const locale = await getServerLocale();
  return { locale, messages: getMessages(locale) };
}

/**
 * Server-side equivalent of `useTranslations(namespace)`. Useful in
 * Server Components and metadata exports — anywhere a hook can't run.
 */
export async function getTranslations<N extends keyof Messages>(namespace: N) {
  const { locale, messages } = await getServerMessages();
  const ns = messages[namespace] as unknown as Record<string, unknown>;
  return function t(key: string, values?: FormatValues): string {
    const template = resolveKey(ns, key);
    if (template == null) return `${String(namespace)}.${key}`;
    return formatMessage(template, values, locale);
  };
}

function resolveKey(ns: Record<string, unknown> | undefined, key: string): string | null {
  if (!ns) return null;
  const direct = ns[key];
  if (typeof direct === "string") return direct;
  if (!key.includes(".")) return null;
  let node: unknown = ns;
  for (const segment of key.split(".")) {
    if (!node || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "string" ? node : null;
}
