import type { CommunityAchievement } from "@oddzilla/types";
import { I } from "@/components/ui/icons";

// Badges grid for the public profile. Catalog metadata (title /
// description / icon) lands inline in CommunityProfile.achievements
// so this component is purely presentational — no client-side fetch,
// no provider wiring.
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

export function CommunityAchievementsSection({
  achievements,
}: {
  achievements: CommunityAchievement[];
}) {
  return (
    <section className="mt-8">
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Achievements
      </h2>
      {achievements.length === 0 ? (
        <div className="card mt-3 p-6 text-sm text-[var(--color-fg-muted)]">
          No badges yet.
        </div>
      ) : (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {achievements.map((a) => {
            const Icon = I[iconFor(a.icon)];
            const unlocked = new Date(a.unlockedAt).toLocaleDateString(
              "en-US",
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
                  <p className="text-sm font-medium">{a.title}</p>
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    {a.description}
                  </p>
                  <p className="mt-1 text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                    Unlocked {unlocked}
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
