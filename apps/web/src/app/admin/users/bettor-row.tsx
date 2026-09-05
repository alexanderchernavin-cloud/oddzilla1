"use client";

// Whole-row link for the bettor list. A server-rendered <tr> cannot be
// an anchor, and wrapping every cell in <Link> repeats the markup seven
// times — so the row navigates on click and stays keyboard-reachable
// through the explicit "Open" link in the last cell. Clicks that start
// on a nested link fall through to that link.

import { useRouter } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";

export function BettorRow({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();

  function onClick(e: MouseEvent<HTMLTableRowElement>) {
    if ((e.target as HTMLElement).closest("a, button, input, select")) return;
    if (e.metaKey || e.ctrlKey) {
      window.open(href, "_blank", "noopener");
      return;
    }
    router.push(href);
  }

  return (
    <tr
      onClick={onClick}
      onMouseEnter={() => router.prefetch(href)}
      className="cursor-pointer border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-bg-subtle)]"
    >
      {children}
    </tr>
  );
}
