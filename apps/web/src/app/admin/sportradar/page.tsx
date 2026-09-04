// /admin/sportradar — the Oddzilla ↔ Sportradar match mapping desk.
//
// Server component: reads the filter state out of the URL, fetches the
// summary, the sport options and one page of mappings in parallel, and
// hands them to the client desk.
//
// Why this screen exists at all: `matches.id` is our own id for every
// fixture from every feed, and the Oddin / Fonbet ids are readable
// straight off `matches.provider_urn`. Sportradar's is the one id nothing
// we ingest carries, so it has to be supplied and — because a wrong one
// silently shows another fixture's live statistics — reviewed.

import { serverApi } from "@/lib/server-fetch";
import { SportradarDesk, type MappingRow, type SportOption } from "./sportradar-client";

interface SummaryResponse {
  candidate: number;
  confirmed: number;
  rejected: number;
  unmapped: number;
  lmtSports: number;
}

interface MappingsResponse {
  page: number;
  pageSize: number;
  total: number;
  rows: MappingRow[];
}

interface SportsResponse {
  sports: SportOption[];
}

const STATUSES = ["candidate", "unmapped", "confirmed", "rejected", "all"] as const;
type Status = (typeof STATUSES)[number];

export default async function SportradarPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    sportId?: string;
    q?: string;
    page?: string;
  }>;
}) {
  const sp = await searchParams;
  const status: Status = STATUSES.includes(sp.status as Status)
    ? (sp.status as Status)
    : "candidate";
  const sportId = sp.sportId && /^\d+$/u.test(sp.sportId) ? sp.sportId : "";
  const q = (sp.q ?? "").slice(0, 128);
  const page = sp.page && /^\d+$/u.test(sp.page) ? sp.page : "1";

  const query = new URLSearchParams({ status, page, pageSize: "50" });
  if (sportId) query.set("sportId", sportId);
  if (q) query.set("q", q);

  const [summary, sports, mappings] = await Promise.all([
    serverApi<SummaryResponse>("/admin/sportradar/summary"),
    serverApi<SportsResponse>("/admin/sportradar/sports"),
    serverApi<MappingsResponse>(`/admin/sportradar/mappings?${query.toString()}`),
  ]);

  return (
    <SportradarDesk
      summary={
        summary ?? {
          candidate: 0,
          confirmed: 0,
          rejected: 0,
          unmapped: 0,
          lmtSports: 0,
        }
      }
      sports={sports?.sports ?? []}
      rows={mappings?.rows ?? []}
      total={mappings?.total ?? 0}
      page={Number(page)}
      pageSize={mappings?.pageSize ?? 50}
      status={status}
      sportId={sportId}
      q={q}
    />
  );
}
