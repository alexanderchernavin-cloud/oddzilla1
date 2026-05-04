// /admin/competitors — manage team logos and branding.
//
// Server component: parses ?sportId, ?q, ?missingLogo from the URL, fetches
// the team list and the sport-filter options in parallel, hands both to the
// client editor. Pagination is server-side via ?offset; the editor links
// the prev/next buttons by re-navigating with the new offset.

import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import { CompetitorsEditor, type CompetitorRow, type SportOption } from "./competitors-editor";

interface CompetitorListResponse {
  total: number;
  limit: number;
  offset: number;
  competitors: CompetitorRow[];
}

interface SportsResponse {
  sports: SportOption[];
}

export default async function CompetitorsPage({
  searchParams,
}: {
  searchParams: Promise<{
    sportId?: string;
    q?: string;
    missingLogo?: string;
    offset?: string;
  }>;
}) {
  const sp = await searchParams;
  const sportId = sp.sportId && /^\d+$/.test(sp.sportId) ? sp.sportId : "";
  const q = sp.q?.trim() ?? "";
  const missingLogo = sp.missingLogo === "1" || sp.missingLogo === "true";
  const offset = sp.offset && /^\d+$/.test(sp.offset) ? Math.max(0, Number(sp.offset)) : 0;
  const limit = 50;

  const params = new URLSearchParams();
  if (sportId) params.set("sportId", sportId);
  if (q) params.set("q", q);
  if (missingLogo) params.set("missingLogo", "1");
  params.set("limit", String(limit));
  params.set("offset", String(offset));

  const [listRes, sportsRes] = await Promise.all([
    serverApi<CompetitorListResponse>(`/admin/competitors?${params.toString()}`),
    serverApi<SportsResponse>("/admin/competitors/sports"),
  ]);

  const list = listRes ?? { total: 0, limit, offset, competitors: [] };
  const sports = sportsRes?.sports ?? [];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Team logos</h1>
          <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
            Edit each team&apos;s logo URL and accent color. Changes show up
            instantly on storefront match cards and the match-detail header.
            Use the sport filter and the &quot;missing logo&quot; toggle to
            sweep teams that still need branding.
          </p>
        </div>
        <Link
          href="/admin"
          className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          ← Admin
        </Link>
      </div>

      <CompetitorsEditor
        initialList={list}
        sports={sports}
        currentFilters={{
          sportId,
          q,
          missingLogo,
          offset,
          limit,
        }}
      />
    </div>
  );
}
