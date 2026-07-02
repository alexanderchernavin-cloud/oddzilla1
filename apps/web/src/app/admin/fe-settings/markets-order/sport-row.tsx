"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";

export interface SportSummary {
  id: number;
  slug: string;
  name: string;
  maxMapNumber: number;
  // Keyed by scope value (match | top | map_<N> | custom_<key>).
  // Missing keys = 0.
  configured: Record<string, number>;
  // Admin-created curated groups, in tab order.
  customGroups: Array<{ scope: string; label: string | null }>;
}

interface ScopeChip {
  scope: string;
  label: string;
}

function scopeChips(sport: SportSummary): ScopeChip[] {
  const chips: ScopeChip[] = [{ scope: "match", label: "Match" }];
  for (let n = 1; n <= sport.maxMapNumber; n++) {
    chips.push({ scope: `map_${n}`, label: `Map ${n}` });
  }
  chips.push({ scope: "top", label: "Top" });
  for (const g of sport.customGroups) {
    chips.push({ scope: g.scope, label: g.label ?? g.scope });
  }
  return chips;
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
          {scopeChips(sport).map((chip) => {
            const count = sport.configured[chip.scope] ?? 0;
            return (
              <Link
                key={chip.scope}
                href={`/admin/fe-settings/markets-order/${sport.id}/${chip.scope}`}
                className={
                  "inline-flex items-center gap-2 rounded border px-2 py-1 text-xs " +
                  (count > 0
                    ? "border-[var(--color-accent)] text-[var(--color-fg)] hover:bg-[var(--color-bg-elevated)]"
                    : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
                }
              >
                <span className="uppercase tracking-[0.12em]">{chip.label}</span>
                <span className="font-mono text-[var(--color-fg-subtle)]">
                  {count > 0 ? count : "—"}
                </span>
              </Link>
            );
          })}
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
