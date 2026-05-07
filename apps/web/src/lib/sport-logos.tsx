"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

// Map of sport slug → admin-uploaded logo URL. Seeded once per request
// from the (main) layout's serverApi("/catalog/sports") call. <SportGlyph>
// reads this to override the bundled /public/sports/<slug>.svg when an
// admin has pasted a custom URL on /admin/sports.

export type SportLogoMap = ReadonlyMap<string, string>;

const Ctx = createContext<SportLogoMap>(new Map());

export function SportLogosProvider({
  entries,
  children,
}: {
  // Plain array so it serialises across the server→client boundary.
  entries: Array<{ slug: string; logoUrl: string | null }>;
  children: ReactNode;
}) {
  const map = useMemo<SportLogoMap>(() => {
    const m = new Map<string, string>();
    for (const e of entries) {
      if (e.logoUrl && e.logoUrl.length > 0) {
        m.set(e.slug.toLowerCase(), e.logoUrl);
      }
    }
    return m;
  }, [entries]);
  return <Ctx.Provider value={map}>{children}</Ctx.Provider>;
}

export function useSportLogo(slug: string): string | null {
  const m = useContext(Ctx);
  return m.get(slug.toLowerCase()) ?? null;
}
