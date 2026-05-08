import Link from "next/link";
import type {
  CommunityFeedResponse,
  CommunityMe,
  Currency,
  CommunityTicketSummary,
} from "@oddzilla/types";
// Runtime imports come from the /currencies subpath — Next.js webpack
// can't resolve the ".js" re-exports in the package root.
import { isCurrency } from "@oddzilla/types/currencies";
import { getSessionUser } from "@/lib/auth";
import { serverApi } from "@/lib/server-fetch";
import { FeedFilters } from "@/components/community/feed-filters";
import { CommunityTicketCard } from "@/components/community/ticket-card";

export const dynamic = "force-dynamic";

interface SportsResponse {
  sports: Array<{ id: number; slug: string; name: string }>;
}

// Two top-level tabs:
//   recent  → tab=recent on the API (live in-flight bets)
//   bigWins → tab=best&bigWinsOnly=true on the API (settled wins
//             clearing the per-currency Big Win floor)
// The non-floored "Best Wins" surface was retired with the Apply
// Same Play rollout — Big Wins is the curated showcase and Recent
// is the live-action feed; everything in between added noise. The
// API still accepts tab=best without the floor (Notion PRD Open
// Question #1, recommendation C — keep the field, don't migrate
// every consumer), but the UI no longer links into it.
type TabKind = "recent" | "bigWins";
type SortKind = "recent" | "copied" | "stakes" | "live";

const SORT_LABELS: Record<SortKind, string> = {
  recent: "Most recent",
  copied: "Most copied",
  stakes: "High stakes",
  live: "Live matches",
};

function parseTab(raw: string | undefined): TabKind {
  if (raw === "bigWins") return "bigWins";
  return "recent";
}

function parseSort(raw: string | undefined): SortKind {
  if (raw === "copied" || raw === "stakes" || raw === "live") return raw;
  return "recent";
}

export default async function CommunityFeedPage({
  searchParams,
}: {
  searchParams: Promise<{
    currency?: string;
    sport?: string;
    tab?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const currency: Currency | null =
    params.currency && isCurrency(params.currency) ? params.currency : null;
  const sportId = parseSportId(params.sport);
  const tab = parseTab(params.tab);
  const sort = parseSort(params.sort);
  const page = parsePage(params.page);

  // Build feed query string from validated params; omit when null so
  // the API's defaults apply.
  const apiTab = tab === "recent" ? "recent" : "best";
  const apiSort = tab === "recent" ? "recent" : sort;
  const queryParts: string[] = [
    `page=${page}`,
    `tab=${apiTab}`,
    `sort=${apiSort}`,
  ];
  if (tab === "bigWins") queryParts.push(`bigWinsOnly=true`);
  if (currency) queryParts.push(`currency=${currency}`);
  if (sportId) queryParts.push(`sport=${sportId}`);

  // For signed-in users, also fetch their own community profile so we
  // can prompt them to pick a nickname if they haven't yet — otherwise
  // their settled tickets won't appear in the feed (the visibility
  // filter drops users with `nickname IS NULL`).
  const sessionUser = await getSessionUser();
  const [feed, sportsRes, mePromise] = await Promise.all([
    serverApi<CommunityFeedResponse>(`/community/feed?${queryParts.join("&")}`),
    serverApi<SportsResponse>("/catalog/sports"),
    sessionUser ? serverApi<CommunityMe>("/community/me") : Promise.resolve(null),
  ]);
  const me = mePromise;

  const sports = sportsRes?.sports ?? [];
  const sportsById = new Map(sports.map((s) => [s.id, s]));
  const tickets = feed?.tickets ?? [];

  return (
    <div>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Community</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
          {tabSubtitle(tab)}
        </p>
      </header>

      {sessionUser && me && me.nickname === null ? (
        <NicknameNudge />
      ) : null}

      <SortTabs
        activeTab={tab}
        sort={sort}
        currency={currency}
        sportId={sportId}
      />

      {tab !== "recent" ? (
        <SortDropdown activeSort={sort} tab={tab} currency={currency} sportId={sportId} />
      ) : null}

      <FeedFilters sports={sports} activeSportId={sportId} activeCurrency={currency} />

      {tickets.length === 0 ? (
        <EmptyState
          filtered={Boolean(currency || sportId)}
          tab={tab}
          sportName={sportId ? sportsById.get(sportId)?.name ?? null : null}
        />
      ) : (
        <ul className="mt-6 space-y-3">
          {tickets.map((t: CommunityTicketSummary, idx) => (
            <CommunityTicketCard
              key={t.ticketId}
              ticket={t}
              sportsById={sportsById}
              // Hero card only on Big Wins, only for the first row,
              // only on page 1. Subsequent pages render every card
              // at sibling size to avoid two heroes in the scroll
              // history.
              isHero={tab === "bigWins" && idx === 0 && page === 1}
            />
          ))}
        </ul>
      )}

      <Pagination page={page} hasMore={feed?.hasMore ?? false} params={params} />
    </div>
  );
}

function tabSubtitle(tab: TabKind): string {
  if (tab === "bigWins") return "Wins above the Big Win threshold from the last 7 days.";
  return "Live bets you can still copy — the matches are still on.";
}

// Tab bar for Recent / Best Wins / Big Wins. Matches the existing
// visual language of the [Match | Top] toggle on the match list cards.
function SortTabs({
  activeTab,
  sort,
  currency,
  sportId,
}: {
  activeTab: TabKind;
  sort: SortKind;
  currency: Currency | null;
  sportId: number | null;
}) {
  const baseParams: string[] = [];
  if (currency) baseParams.push(`currency=${encodeURIComponent(currency)}`);
  if (sportId) baseParams.push(`sport=${encodeURIComponent(sportId)}`);
  // Carry the active sort across Best ↔ Big Wins tab switches so a
  // user reading "Most copied" on Best Wins keeps that sort when they
  // toggle into Big Wins. Recent has no sort dropdown so we drop it.
  const sortParam = sort !== "recent" ? `sort=${encodeURIComponent(sort)}` : "";
  const link = (next: TabKind) => {
    const parts = [...baseParams, `tab=${next}`];
    if (next !== "recent" && sortParam) parts.push(sortParam);
    return `/community?${parts.join("&")}`;
  };

  return (
    <div
      role="tablist"
      aria-label="Section"
      className="mt-5 inline-flex rounded-[10px] border border-[var(--color-border-strong)] p-1"
    >
      <Tab href={link("recent")} active={activeTab === "recent"}>
        Recent
      </Tab>
      <Tab href={link("bigWins")} active={activeTab === "bigWins"}>
        Big wins
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

// Sort dropdown for the Best Wins / Big Wins tabs. Server-rendered
// as four <Link> chips — a real <select> needs a client component
// for onChange-to-navigate, and the chip layout matches the page's
// other filters (currency / sport). Live mode is shown but flagged
// as a Phase A placeholder per the API comment.
function SortDropdown({
  activeSort,
  tab,
  currency,
  sportId,
}: {
  activeSort: SortKind;
  tab: TabKind;
  currency: Currency | null;
  sportId: number | null;
}) {
  const baseParams: string[] = [`tab=${tab}`];
  if (currency) baseParams.push(`currency=${encodeURIComponent(currency)}`);
  if (sportId) baseParams.push(`sport=${encodeURIComponent(sportId)}`);
  const link = (s: SortKind) =>
    `/community?${[...baseParams, `sort=${s}`].join("&")}`;

  const options: SortKind[] = ["recent", "copied", "stakes", "live"];

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
      <span className="uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Sort
      </span>
      {options.map((s) => (
        <SortChip key={s} href={link(s)} active={activeSort === s}>
          {SORT_LABELS[s]}
        </SortChip>
      ))}
    </div>
  );
}

function SortChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={
        "rounded-full border px-3 py-1 transition " +
        (active
          ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
          : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
      }
    >
      {children}
    </Link>
  );
}

// Banner shown to signed-in users who haven't picked a nickname yet.
// Without one, the feed visibility filter (`nickname IS NOT NULL`)
// drops their settled tickets, so they'd see other people's wins but
// never their own — a silent failure mode that confused early users.
function NicknameNudge() {
  return (
    <div className="card mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-[var(--color-accent)]/40 p-4 text-sm">
      <span className="font-medium">Pick a nickname to appear here.</span>
      <span className="text-[var(--color-fg-muted)]">
        Your settled tickets show in this feed only after you set a public
        handle.
      </span>
      <Link
        href="/account/community"
        className="font-medium text-[var(--color-accent)] hover:underline"
      >
        Set nickname →
      </Link>
    </div>
  );
}

function EmptyState({
  filtered,
  tab,
  sportName,
}: {
  filtered: boolean;
  tab: TabKind;
  sportName: string | null;
}) {
  let body: string;
  if (tab === "bigWins") {
    if (filtered && sportName) {
      body = `No big wins in ${sportName} yet. Try another sport, or check back after the next match.`;
    } else if (filtered) {
      body = "No big wins match these filters yet. Try clearing one.";
    } else {
      body = "Big wins land here. Wins above the Big Win threshold show up here. Place a bet to start the streak.";
    }
  } else if (filtered) {
    body = "No live bets match these filters. Try clearing one.";
  } else {
    body = "No live bets right now. Check back when matches kick off.";
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
  params: { currency?: string; sport?: string; tab?: string; sort?: string };
}) {
  const base: string[] = [];
  if (params.currency) base.push(`currency=${encodeURIComponent(params.currency)}`);
  if (params.sport) base.push(`sport=${encodeURIComponent(params.sport)}`);
  if (params.tab) base.push(`tab=${encodeURIComponent(params.tab)}`);
  if (params.sort) base.push(`sort=${encodeURIComponent(params.sort)}`);
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
