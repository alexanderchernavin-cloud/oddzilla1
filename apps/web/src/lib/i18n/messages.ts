// Server-only message loader. Importing JSON files this way bakes the
// dictionaries into the standalone build output so we don't have to
// ship them as static assets and round-trip an HTTP fetch at request
// time. Each locale is its own module so Next's bundler can tree-shake
// the unused ones from individual server routes that load a single
// locale — though in practice we load whatever the cookie asks for.

import en from "../../../messages/en.json";
import cs from "../../../messages/cs.json";
import pt from "../../../messages/pt.json";
import ru from "../../../messages/ru.json";
import es from "../../../messages/es.json";
import { DEFAULT_LOCALE, type Locale } from "./config";

// Strongly type Messages as the shape of the English dictionary — the
// other locales have to satisfy this shape (TS will catch a missing
// key the first time we add it on en.json and forget on cs.json).
export type Messages = typeof en;

const DICTS: Record<Locale, Messages> = {
  en,
  cs: cs as Messages,
  pt: pt as Messages,
  ru: ru as Messages,
  es: es as Messages,
};

export function getMessages(locale: Locale): Messages {
  return DICTS[locale] ?? DICTS[DEFAULT_LOCALE];
}
