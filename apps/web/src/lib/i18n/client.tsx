"use client";

// Client-side i18n primitives.
//
// The provider gets `locale` + a single dictionary `messages` from the
// server layout (see `server.ts` for how those are picked up there).
// Hooks pull from React context — no global singleton — so multiple
// previews / portals on a page could in theory carry different locales,
// and there is no hidden coupling to any specific environment.
//
// `useTranslations(namespace)` returns a `t(key, values?)` function
// where `key` is a dot-separated path under the namespace. Missing keys
// fall back to the path itself, so the page renders something readable
// while translation work is in progress.

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_LOCALE, type Locale } from "./config";
import { formatMessage, type FormatValues } from "./format";
import type { Messages } from "./messages";

interface I18nContextValue {
  locale: Locale;
  messages: Messages;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ locale, messages }), [locale, messages]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function readContext(): I18nContextValue {
  const ctx = useContext(I18nContext);
  // If a client island ends up rendered without the provider (e.g. inside
  // a Storybook), don't crash — fall back to English defaults loaded
  // statically. The cost is one extra import in the client bundle, which
  // is dwarfed by the cost of the missing-provider runtime error.
  if (ctx) return ctx;
  return { locale: DEFAULT_LOCALE, messages: EN_FALLBACK as Messages };
}

export function useLocale(): Locale {
  return readContext().locale;
}

export function useMessages(): Messages {
  return readContext().messages;
}

type Namespace = keyof Messages;

/**
 * Hook: returns a `t(key, values)` function bound to one top-level
 * namespace of the dictionary. Keys are dot-separated paths within
 * that namespace — `t("legs", {count: 3})` from the `betSlip`
 * namespace resolves `messages.betSlip.legs` and runs the ICU plural.
 */
export function useTranslations<N extends Namespace>(namespace: N) {
  const { locale, messages } = readContext();
  const ns = messages[namespace] as unknown as Record<string, string | Record<string, string>>;
  return useCallback(
    (key: string, values?: FormatValues): string => {
      const template = resolveKey(ns, key);
      if (template == null) return `${String(namespace)}.${key}`;
      return formatMessage(template, values, locale);
    },
    [locale, ns, namespace],
  );
}

function resolveKey(
  ns: Record<string, string | Record<string, string>>,
  key: string,
): string | null {
  if (!ns) return null;
  // Fast path for flat keys.
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

// Hardcoded English fallback used only when the provider is missing.
// Kept minimal — pulling the full en.json dictionary in this client
// fallback would double the bundle. Real client islands always render
// inside <I18nProvider>.
const EN_FALLBACK = {} as const;
