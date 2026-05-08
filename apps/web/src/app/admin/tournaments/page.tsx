// /admin/tournaments — manage tournament logos and branding.
//
// Server component: parses ?sportId, ?q, ?missingLogo from the URL,
// fetches the tournament list and the sport-filter options in parallel,
// hands both to the client editor. Pagination is server-side via
// ?offset; the editor links the prev/next buttons by re-navigating with
// the new offset. Mirrors /admin/competitors row-for-row.

import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import {
  TournamentsEditor,
  type TournamentRow,
  type SportOption,
} from "./tournaments-editor";

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
    serverApi<TournamentListResponse>(`/admin/tournaments?${params.toString()}`),
    serverApi<SportsResponse>("/admin/tournaments/sports"),
  ]);

  const list =
    listRes ?? { total: 0, missingLogoCount: 0, limit, offset, tournaments: [] };
  const sports = sportsRes?.sports ?? [];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tournament logos</h1>
          <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
            Edit each tournament&apos;s logo and accent colour. Either paste
            an HTTPS URL or upload a file (SVG, PNG, JPEG, WebP — max 1 MB).
            Use <strong>Remove</strong> to clear an upload or pasted URL.
            Storefront sidebar picks the logo up on the next page load.
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
