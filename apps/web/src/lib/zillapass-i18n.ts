"use client";

// ZillaPass task titles / descriptions / CTA labels live in the
// `zillapass_tasks` DB catalog (admin-curated, seeded in English by the
// migrations). Display-level translations are keyed by the task's stable
// slug under `messages.zillapass.taskCatalog`; a task without an entry
// (e.g. one an admin created after launch) falls back to the DB-provided
// text so it still renders — in English — instead of breaking.
//
// Caveat this implies: when an operator edits a seeded task's wording in
// the admin, the storefront keeps showing the translated catalog entry
// for that slug. Mirror intentional copy changes into messages/*.json.

import { useMessages } from "@/lib/i18n";

interface TaskTextSource {
  slug: string;
  title: string;
  description: string | null;
  ctaLabel: string | null;
}

interface TaskCatalogEntry {
  title?: string;
  description?: string;
  cta?: string;
}

export function useZillapassTaskText() {
  const messages = useMessages();
  const catalog = (messages.zillapass?.taskCatalog ?? {}) as Record<
    string,
    TaskCatalogEntry | undefined
  >;
  return function taskText(task: TaskTextSource): {
    title: string;
    description: string | null;
    ctaLabel: string | null;
  } {
    const entry = catalog[task.slug];
    return {
      title: entry?.title ?? task.title,
      description: entry?.description ?? task.description,
      ctaLabel: entry?.cta ?? task.ctaLabel,
    };
  };
}
