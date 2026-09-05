// /admin/tournaments — manage tournament logos and branding.
//
// Server component: parses ?sportId, ?q, ?missingLogo from the URL,
// fetches the tournament list and the sport-filter options in parallel,
// hands both to the client editor. Pagination is server-side via
// ?offset; the editor links the prev/next buttons by re-navigating with
// the new offset. Mirrors /admin/competitors row-for-row.

import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
// SORT_KEYS is a runtime value, so it must come from a module WITHOUT
// "use client" — a client module's exports reach a server component as
// reference proxies, not as the values themselves. Types are erased and
// are safe to take from the editor.
import { SORT_KEYS, type SortKey } from "./sort";
import {
  TournamentsEditor,
  type CategoryOption,
  type TournamentRow,
  type SportOption,
} from "./tournaments-editor";

interface CategoriesResponse {
  categories: CategoryOption[];
}

interface TournamentListResponse {
  total: number;
  missingLogoCount: number;
  limit: number;
  offset: number;
  tournaments: TournamentRow[];
}

interface SportsResponse {
  sports: SportOption[];
}

export default async function TournamentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    sportId?: string;
    categoryId?: string;
    tier?: string;
    source?: string;
    sort?: string;
    dir?: string;
    q?: string;
    missingLogo?: string;
    offset?: string;
  }>;
}) {
  const sp = await searchParams;
  const sportId = sp.sportId && /^\d+$/.test(sp.sportId) ? sp.sportId : "";
  // A category belongs to exactly one sport, so it is only meaningful
  // alongside one — carrying it without a sport would silently filter the
  // list against a bucket the operator can no longer see selected.
  const categoryId =
    sportId && sp.categoryId && /^\d+$/.test(sp.categoryId) ? sp.categoryId : "";
  const tier =
    sp.tier === "unset" || (sp.tier && /^([1-9]|10)$/.test(sp.tier)) ? sp.tier : "";
  const source =
    sp.source === "auto" || sp.source === "zagi" || sp.source === "manual"
      ? sp.source
      : "";
  const sort = SORT_KEYS.includes(sp.sort as SortKey) ? (sp.sort as SortKey) : "default";
  const dir = sp.dir === "desc" ? "desc" : "asc";
  const q = sp.q?.trim() ?? "";
  const missingLogo = sp.missingLogo === "1" || sp.missingLogo === "true";
  const offset = sp.offset && /^\d+$/.test(sp.offset) ? Math.max(0, Number(sp.offset)) : 0;
  const limit = 50;

  const params = new URLSearchParams();
  if (sportId) params.set("sportId", sportId);
  if (categoryId) params.set("categoryId", categoryId);
  if (tier) params.set("tier", tier);
  if (source) params.set("source", source);
  if (sort !== "default") {
    params.set("sort", sort);
    params.set("dir", dir);
  }
  if (q) params.set("q", q);
  if (missingLogo) params.set("missingLogo", "1");
  params.set("limit", String(limit));
  params.set("offset", String(offset));

  const [listRes, sportsRes, categoriesRes] = await Promise.all([
    serverApi<TournamentListResponse>(`/admin/tournaments?${params.toString()}`),
    serverApi<SportsResponse>("/admin/tournaments/sports"),
    sportId
      ? serverApi<CategoriesResponse>(`/admin/tournaments/categories?sportId=${sportId}`)
      : Promise.resolve(null),
  ]);

  const list =
    listRes ?? { total: 0, missingLogoCount: 0, limit, offset, tournaments: [] };
  const sports = sportsRes?.sports ?? [];
  const categories = categoriesRes?.categories ?? [];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tournaments</h1>
          <p className="mt-2 max-w-3xl text-sm text-[var(--color-fg-muted)]">
            Edit each tournament&apos;s logo and accent colour. Either paste
            an HTTPS URL or upload a file (SVG, PNG, JPEG, WebP — max 1 MB).
            Use <strong>Remove</strong> to clear an upload or pasted URL.
            Storefront sidebar picks the logo up on the next page load.
          </p>
          <p className="mt-2 max-w-3xl text-sm text-[var(--color-fg-muted)]">
            <strong>Order in category</strong> pins a tournament to the top of
            its own country&apos;s bucket in the sidebar tree — the same
            control sports and categories have. Pinned tournaments lead in the
            order shown; everything unpinned keeps the default behind them
            (risk tier, then live matches, then name), which is how the whole
            tree behaved before.
          </p>
        </div>
        <Link
          href="/admin"
          className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          ← Admin
        </Link>
      </div>

      <TournamentsEditor
        initialList={list}
        sports={sports}
        categories={categories}
        currentFilters={{
          sportId,
          categoryId,
          tier,
          source,
          sort,
          dir,
          q,
          missingLogo,
          offset,
          limit,
        }}
      />
    </div>
  );
}
