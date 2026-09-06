"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { tabLabel, type ScopeTab } from "./scope-label";

export interface SportSummary {
  id: number;
  slug: string;
  name: string;
  /**
   * The tabs this sport's own offer produces, in storefront order —
   * Match / Map 1..5 for an esport, Match / 1st half / Corners / Players
   * for football — plus Top and any custom groups. `configured` is how
   * many markets the operator has explicitly ordered on that tab.
   */
  tabs: Array<ScopeTab & { configured: number }>;
}

// One sport row. The whole row navigates to the sport's Match tab; the
// per-tab chips and the Groups chip are nested links that win over the
// row-level click (the handler ignores clicks that land inside an <a>).
export function SportRow({ sport }: { sport: SportSummary }) {
  const router = useRouter();

  function onRowClick(e: MouseEvent<HTMLTableRowElement>) {
    if ((e.target as HTMLElement).closest("a")) return;
    router.push(`/admin/fe-settings/markets-order/${sport.id}/match`);
  }

  return (
    <tr
      onClick={onRowClick}
      className="cursor-pointer hover:bg-[var(--color-bg-elevated)]"
    >
      <td className="px-5 py-3 align-top">{sport.name}</td>
      <td className="px-5 py-3 align-top font-mono text-[var(--color-fg-muted)]">
        {sport.slug}
      </td>
      <td className="px-5 py-3">
        <div className="flex flex-wrap gap-1.5">
          {sport.tabs.map((tab) => (
            <Link
              key={tab.scope}
              href={`/admin/fe-settings/markets-order/${sport.id}/${tab.scope}`}
              title={tab.scope}
              className={
                "inline-flex items-center gap-2 rounded border px-2 py-1 text-xs " +
                (tab.configured > 0
                  ? "border-[var(--color-accent)] text-[var(--color-fg)] hover:bg-[var(--color-bg-elevated)]"
                  : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
              }
            >
              <span className="uppercase tracking-[0.12em]">
                {tabLabel(tab)}
              </span>
              <span className="font-mono text-[var(--color-fg-subtle)]">
                {tab.configured > 0 ? tab.configured : "—"}
              </span>
            </Link>
          ))}
          <Link
            href={`/admin/fe-settings/markets-order/${sport.id}/groups`}
            className="inline-flex items-center rounded border border-dashed border-[var(--color-border)] px-2 py-1 text-xs uppercase tracking-[0.12em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          >
            Groups
          </Link>
        </div>
      </td>
    </tr>
  );
}
