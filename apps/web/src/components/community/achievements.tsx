"use client";

import type { CommunityAchievement } from "@oddzilla/types";
import { I } from "@/components/ui/icons";
import { useLocale, useMessages, useTranslations } from "@/lib/i18n";

// Badges grid for the public profile. Catalog metadata (title /
// description / icon) lands inline in CommunityProfile.achievements —
// but those strings are DB rows seeded in English, so the display
// layer translates them per achievement id via
// `messages.achievementCatalog`, falling back to the DB text for ids
// without an entry (a future achievement-definitions row still renders,
// in English, instead of breaking).
//
// Icons map onto the existing storefront icon set
// (apps/web/src/components/ui/icons.tsx). Unknown slugs fall back to
// Trophy so a future achievement-definitions row referencing an icon
// we haven't shipped doesn't render as a blank square.

type IconKey = keyof typeof I;

function isIconKey(slug: string): slug is IconKey {
  return slug in I;
}

function iconFor(slug: string): IconKey {
  return isIconKey(slug) ? slug : "Trophy";
}

interface AchievementCatalogEntry {
  title?: string;
  description?: string;
}

export function CommunityAchievementsSection({
  achievements,
}: {
  achievements: CommunityAchievement[];
}) {
  const t = useTranslations("profilePage");
  const locale = useLocale();
  const messages = useMessages();
  const catalog = (messages.achievementCatalog ?? {}) as Record<
    string,
    AchievementCatalogEntry | undefined
  >;
  return (
    <section className="mt-8">
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {t("achievements")}
      </h2>
      {achievements.length === 0 ? (
        <div className="card mt-3 p-6 text-sm text-[var(--color-fg-muted)]">
          {t("noBadges")}
        </div>
      ) : (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {achievements.map((a) => {
            const Icon = I[iconFor(a.icon)];
            const entry = catalog[a.id];
            const unlocked = new Date(a.unlockedAt).toLocaleDateString(
              locale,
              { month: "short", day: "numeric", year: "numeric" },
            );
            return (
              <li key={a.id} className="card flex items-start gap-3 p-4">
                <span
                  className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)]"
                  aria-hidden
                >
                  <Icon size={18} />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{entry?.title ?? a.title}</p>
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    {entry?.description ?? a.description}
                  </p>
                  <p className="mt-1 text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                    {t("unlocked", { date: unlocked })}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
