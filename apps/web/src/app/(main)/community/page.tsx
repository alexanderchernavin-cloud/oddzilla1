import type {
  CommunityFeedResponse,
  Currency,
  CommunityTicketSummary,
} from "@oddzilla/types";
// Runtime imports come from the /currencies subpath — Next.js webpack
// can't resolve the ".js" re-exports in the package root.
import { isCurrency } from "@oddzilla/types/currencies";
import { serverApi } from "@/lib/server-fetch";
import { FeedFilters } from "@/components/community/feed-filters";
import { CommunityTicketCard } from "@/components/community/ticket-card";

export const dynamic = "force-dynamic";

interface SportsResponse {
  sports: Array<{ id: number; slug: string; name: string }>;
}

type SortKind = "recent" | "best";

function parseSort(raw: string | undefined): SortKind {
  return raw === "best" ? "best" : "recent";
}

export default async function CommunityFeedPage({
  searchParams,
}: {
  searchParams: Promise<{
    currency?: string;
    sport?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const currency: Currency | null =
    params.currency && isCurrency(params.currency) ? params.currency : null;
  const sportId = parseSportId(params.sport);
  const sort = parseSort(params.sort);
  const page = parsePage(params.page);

  // Build feed query string from validated params; omit when null so
  // the API's defaults apply.
  const queryParts: string[] = [`page=${page}`, `sort=${sort}`];
  if (currency) queryParts.push(`currency=${currency}`);
  if (sportId) queryParts.push(`sport=${sportId}`);

  const [feed, sportsRes] = await Promise.all([
    serverApi<CommunityFeedResponse>(`/community/feed?${queryParts.join("&")}`),
    serverApi<SportsResponse>("/catalog/sports"),
  ]);

  const sports = sportsRes?.sports ?? [];
  const sportsById = new Map(sports.map((s) => [s.id, s]));
  const tickets = feed?.tickets ?? [];

  return (
    <div>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Community</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
          {sort === "best"
            ? "Best wins of the last 7 days."
            : "What other bettors are winning right now."}
        </p>
      </header>

      <SortTabs activeSort={sort} currency={currency} sportId={sportId} />

      <FeedFilters sports={sports} activeSportId={sportId} activeCurrency={currency} />

      {tickets.length === 0 ? (
        <EmptyState filtered={Boolean(currency || sportId)} sort={sort} />
      ) : (
        <ul className="mt-6 space-y-3">
          {tickets.map((t: CommunityTicketSummary) => (
            <CommunityTicketCard
              key={t.ticketId}
              ticket={t}
              sportsById={sportsById}
            />
          ))}
        </ul>
      )}

      <Pagination page={page} hasMore={feed?.hasMore ?? false} params={params} />
    </div>
  );
}

// Tab bar for Recent / Best Wins. Matches the existing visual
// language of the [Match | Top] toggle on the match list cards
// (apps/web/src/components/match/match-list-tabs.tsx).
function SortTabs({
  activeSort,
  currency,
  sportId,
}: {
  activeSort: SortKind;
  currency: Currency | null;
  sportId: number | null;
}) {
  const baseParams: string[] = [];
  if (currency) baseParams.push(`currency=${encodeURIComponent(currency)}`);
  if (sportId) baseParams.push(`sport=${encodeURIComponent(sportId)}`);
  const link = (sort: SortKind) =>
    `/community?${[...baseParams, `sort=${sort}`].join("&")}`;

  return (
    <div
      role="tablist"
      aria-label="Sort"
      className="mt-5 inline-flex rounded-[10px] border border-[var(--color-border-strong)] p-1"
    >
      <Tab href={link("recent")} active={activeSort === "recent"}>
        Recent
      </Tab>
      <Tab href={link("best")} active={activeSort === "best"}>
        Best wins
      </Tab>
    </div>
  );
}

function Tab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  // Imported lazily so the page stays a server component (no client
  // navigation needed — sort change is a full reload, which keeps the
  // server-rendered data fresh).
  const cls =
    "rounded-[8px] px-3 py-1.5 text-xs uppercase tracking-[0.15em] transition " +
    (active
      ? "bg-[var(--color-bg-elevated)] text-[var(--color-fg)]"
      : "text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]");
  return (
    <a role="tab" aria-selected={active} href={href} className={cls}>
      {children}
    </a>
  );
}

function EmptyState({
  filtered,
  sort,
}: {
  filtered: boolean;
  sort: SortKind;
}) {
  let body: string;
  if (filtered) {
    body = "No tickets match these filters yet. Try a different sport or currency.";
  } else if (sort === "best") {
    body =
      "No big wins in the last 7 days. Switch to Recent to see fresh action.";
  } else {
    body = "No settled tickets yet. Check back after a few matches close.";
  }
  return (
    <div className="card mt-6 p-10 text-center text-sm text-[var(--color-fg-muted)]">
      {body}
    </div>
  );
}

function Pagination({
  page,
  hasMore,
  params,
}: {
  page: number;
  hasMore: boolean;
  params: { currency?: string; sport?: string };
}) {
  const base: string[] = [];
  if (params.currency) base.push(`currency=${encodeURIComponent(params.currency)}`);
  if (params.sport) base.push(`sport=${encodeURIComponent(params.sport)}`);
  const prev = base.concat(`page=${page - 1}`).join("&");
  const next = base.concat(`page=${page + 1}`).join("&");

  if (page === 1 && !hasMore) return null;
  return (
    <nav className="mt-6 flex items-center justify-between text-sm">
      {page > 1 ? (
        <a className="btn btn-ghost" href={`/community?${prev}`}>
          ← Newer
        </a>
      ) : (
        <span />
      )}
      {hasMore ? (
        <a className="btn btn-ghost" href={`/community?${next}`}>
          Older →
        </a>
      ) : (
        <span />
      )}
    </nav>
  );
}

function parseSportId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parsePage(raw: string | undefined): number {
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 1;
  return n;
}
