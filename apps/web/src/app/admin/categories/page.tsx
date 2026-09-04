// /admin/categories — control which categories appear in the match lists.
//
// Server component: parses ?sportId, ?q, ?hidden from the URL, fetches the
// category list and the sport-filter options in parallel, hands both to the
// client editor. Pagination is server-side via ?offset. Mirrors
// /admin/tournaments row-for-row.

import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import {
  CategoriesEditor,
  type CategoryRow,
  type SportOption,
} from "./categories-editor";

interface CategoryListResponse {
  total: number;
  hiddenCount: number;
  limit: number;
  offset: number;
  categories: CategoryRow[];
}

interface SportsResponse {
  sports: SportOption[];
}

export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{
    sportId?: string;
    q?: string;
    hidden?: string;
    offset?: string;
  }>;
}) {
  const sp = await searchParams;
  const sportId = sp.sportId && /^\d+$/.test(sp.sportId) ? sp.sportId : "";
  const q = sp.q?.trim() ?? "";
  const hidden = sp.hidden === "1" || sp.hidden === "true";
  const offset = sp.offset && /^\d+$/.test(sp.offset) ? Math.max(0, Number(sp.offset)) : 0;
  const limit = 100;

  const params = new URLSearchParams();
  if (sportId) params.set("sportId", sportId);
  if (q) params.set("q", q);
  if (hidden) params.set("hidden", "1");
  params.set("limit", String(limit));
  params.set("offset", String(offset));

  const [listRes, sportsRes] = await Promise.all([
    serverApi<CategoryListResponse>(`/admin/categories?${params.toString()}`),
    serverApi<SportsResponse>("/admin/categories/sports"),
  ]);

  const list = listRes ?? { total: 0, hiddenCount: 0, limit, offset, categories: [] };
  const sports = sportsRes?.sports ?? [];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Category visibility
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-[var(--color-fg-muted)]">
            A category marked <strong>hidden from lists</strong> is dropped from
            the lobby, Live, Pre-match, the sport page&apos;s default view and
            the sport&apos;s live badge. It stays in the storefront sidebar
            tree, and clicking it there (or picking one of its tournaments)
            shows every match under it as normal.
          </p>
          <p className="mt-2 max-w-3xl text-sm text-[var(--color-fg-muted)]">
            This is a merchandising control, not a kill switch — hidden matches
            are still bettable and still settle. Use it for feed categories that
            would otherwise crowd out the real offer: Fonbet files EA FC
            simulations under Football, NBA 2K under Basketball, NHL under Ice
            Hockey.
          </p>
        </div>
        <Link
          href="/admin"
          className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          ← Admin
        </Link>
      </div>

      <CategoriesEditor
        initialList={list}
        sports={sports}
        currentFilters={{ sportId, q, hidden, offset, limit }}
      />
    </div>
  );
}
