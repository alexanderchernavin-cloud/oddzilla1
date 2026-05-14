// Barrel for the i18n module. Server code imports `getServerLocale`
// and `getServerMessages` from here, client code imports `useTranslations`
// and `useLocale`. The cookie name + locale list + Accept-Language
// negotiator live in `config.ts` so they're safe to import from both
// sides (no JSON loader, no React).

export {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_LABELS,
  LOCALES,
  isLocale,
  negotiateLocale,
  type Locale,
} from "./config";
export { I18nProvider, useLocale, useMessages, useTranslations } from "./client";
export { setLocaleAction } from "./actions";
export type { Messages } from "./messages";
