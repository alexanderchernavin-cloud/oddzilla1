import Link from "next/link";
import type {
  AnalysisFeedResponse,
  CommunityFeedResponse,
  CommunityMe,
  CompetitionListResponse,
  CompetitionSummary,
  Currency,
  CommunityTicketSummary,
} from "@oddzilla/types";
// Runtime imports come from the /currencies subpath — Next.js webpack
// can't resolve the ".js" re-exports in the package root.
import { isCurrency } from "@oddzilla/types/currencies";
import { getSessionUser } from "@/lib/auth";
import { serverApi } from "@/lib/server-fetch";
import { getTranslations } from "@/lib/i18n/server";
import { FeedFilters } from "@/components/community/feed-filters";
import { CommunityTicketCard } from "@/components/community/ticket-card";
import { AnalysisCard } from "@/components/community/analysis-card";
import { CompetitionCard } from "@/components/community/competition-card";

export const dynamic = "force-dynamic";

interface SportsResponse {
  sports: Array<{ id: number; slug: string; name: string }>;
}

// Three top-level tabs. The first two read /community/feed; the
// third reads /community/analyses. They share the URL ?tab= space
// so a deep-linked filter (sport, currency) carries across tab
// switches where it makes sense.
type TabKind = "recent" | "bigWins" | "analyses" | "competitions";
// Sort space is per-tab. Tickets feed has 4 modes; analyses feed
// has its own 4 (recommended / recent / most_inspired / top_authors).
// Keeping them separate avoids enum gymnastics on the API.
type TicketSortKind = "recent" | "copied" | "stakes" | "live";
type AnalysisSortKind = "recommended" | "recent" | "most_inspired" | "top_authors";

const TICKET_SORT_LABELS: Record<TicketSortKind, string> = {
  recent: "Most recent",
  copied: "Most copied",
  stakes: "High stakes",
  live: "Live matches",
};

const ANALYSIS_SORT_LABELS: Record<AnalysisSortKind, string> = {
  recommended: "Recommended",
  recent: "Most recent",
  most_inspired: "Most inspired",
  top_authors: "Top authors",
};

function parseTab(raw: string | undefined): TabKind {
  if (raw === "bigWins") return "bigWins";
  if (raw === "analyses") return "analyses";
  if (raw === "competitions") return "competitions";
  return "recent";
}

function parseTicketSort(raw: string | undefined): TicketSortKind {
  if (raw === "copied" || raw === "stakes" || raw === "live") return raw;
  return "recent";
}

function parseAnalysisSort(raw: string | undefined): AnalysisSortKind {
  if (
    raw === "recent" ||
    raw === "most_inspired" ||
    raw === "top_authors"
  ) {
    return raw;
  }
  return "recommended";
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
  const ticketSort = parseTicketSort(params.sort);
  const analysisSort = parseAnalysisSort(params.sort);
  const page = parsePage(params.page);

  // For signed-in users, also fetch their own community profile so we
  // can prompt them to pick a nickname if they haven't yet — otherwise
  // their settled tickets won't appear in the feed (the visibility
  // filter drops users with `nickname IS NULL`).
  const sessionUser = await getSessionUser();

  // Branch the data fetch on tab. Analyses tab reads a different
  // endpoint with a different shape; trying to share one feed
  // call would mean a discriminated union all the way through.
  let tickets: CommunityTicketSummary[] = [];
  let analyses: AnalysisFeedResponse["analyses"] = [];
  let competitions: CompetitionSummary[] = [];
  let hasMore = false;

  if (tab === "competitions") {
    // Competitions tab reads /community/competitions. Status filter
    // lives in the URL via ?sort= reusing the existing key (we don't
    // need a third per-tab URL slot for V1).
    const queryParts: string[] = [`page=${page}`, `pageSize=20`];
    if (sportId) queryParts.push(`sport=${sportId}`);
    const feed = await serverApi<CompetitionListResponse>(
      `/community/competitions?${queryParts.join("&")}`,
    );
    competitions = feed?.competitions ?? [];
    hasMore = feed?.hasMore ?? false;
  } else if (tab === "analyses") {
    const queryParts: string[] = [
      `page=${page}`,
      `sort=${analysisSort}`,
      `pageSize=20`,
    ];
    if (sportId) queryParts.push(`sport=${sportId}`);
    const feed = await serverApi<AnalysisFeedResponse>(
      `/community/analyses?${queryParts.join("&")}`,
    );
    analyses = feed?.analyses ?? [];
    hasMore = feed?.hasMore ?? false;
  } else {
    // Existing tickets-feed path.
    const apiTab = tab === "recent" ? "recent" : "best";
    const apiSort = tab === "recent" ? "recent" : ticketSort;
    const queryParts: string[] = [
      `page=${page}`,
      `tab=${apiTab}`,
      `sort=${apiSort}`,
    ];
    if (tab === "bigWins") queryParts.push(`bigWinsOnly=true`);
    if (currency) queryParts.push(`currency=${currency}`);
    if (sportId) queryParts.push(`sport=${sportId}`);
    const feed = await serverApi<CommunityFeedResponse>(
      `/community/feed?${queryParts.join("&")}`,
    );
    tickets = feed?.tickets ?? [];
    hasMore = feed?.hasMore ?? false;
  }

  const [sportsRes, mePromise, tCommunity] = await Promise.all([
    serverApi<SportsResponse>("/catalog/sports"),
    sessionUser ? serverApi<CommunityMe>("/community/me") : Promise.resolve(null),
    getTranslations("community"),
  ]);
  const me = mePromise;

  const sports = sportsRes?.sports ?? [];
  const sportsById = new Map(sports.map((s) => [s.id, s]));

  return (
    <div>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{tCommunity("title")}</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
          {tabSubtitle(tab)}
        </p>
      </header>

      {sessionUser && me && me.nickname === null ? (
        <NicknameNudge />
      ) : null}

      <SortTabs
        activeTab={tab}
        ticketSort={ticketSort}
        analysisSort={analysisSort}
        currency={currency}
        sportId={sportId}
      />

      {tab === "analyses" ? (
        <AnalysisSortDropdown
          activeSort={analysisSort}
          currency={currency}
          sportId={sportId}
        />
      ) : tab !== "recent" ? (
        <SortDropdown activeSort={ticketSort} tab={tab} currency={currency} sportId={sportId} />
      ) : null}

      <FeedFilters sports={sports} activeSportId={sportId} activeCurrency={currency} />

      {tab === "competitions" ? (
        competitions.length === 0 ? (
          <EmptyState
            filtered={Boolean(sportId)}
            tab={tab}
            sportName={sportId ? sportsById.get(sportId)?.name ?? null : null}
          />
        ) : (
          <ul className="mt-6 space-y-3">
            {competitions.map((c) => (
              <CompetitionCard key={c.id} competition={c} />
            ))}
          </ul>
        )
      ) : tab === "analyses" ? (
        analyses.length === 0 ? (
          <EmptyState
            filtered={Boolean(sportId)}
            tab={tab}
            sportName={sportId ? sportsById.get(sportId)?.name ?? null : null}
          />
        ) : (
          <ul className="mt-6 space-y-3">
            {analyses.map((a) => (
              <AnalysisCard key={a.id} analysis={a} />
            ))}
          </ul>
        )
      ) : tickets.length === 0 ? (
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

      <Pagination page={page} hasMore={hasMore} params={params} />
    </div>
  );
}

function tabSubtitle(tab: TabKind): string {
  if (tab === "bigWins") return "Wins above the Big Win threshold from the last 7 days.";
  if (tab === "analyses") return "Pre-match takes from the community. Skin in the game required.";
  if (tab === "competitions") return "Free prediction games. Pick scores, climb the leaderboard.";
  return "Live bets you can still copy — the matches are still on.";
}

// Tab bar for Recent / Best Wins / Big Wins. Matches the existing
// visual language of the [Match | Top] toggle on the match list cards.
function SortTabs({
  activeTab,
  ticketSort,
  analysisSort,
  currency,
  sportId,
}: {
  activeTab: TabKind;
  ticketSort: TicketSortKind;
  analysisSort: AnalysisSortKind;
  currency: Currency | null;
  sportId: number | null;
}) {
  // We don't try to carry sort across tab switches that map to
  // different sort universes — tickets sort and analyses sort
  // share a URL key but mean different things. Each link drops
  // the irrelevant sort and the receiving page falls back to its
  // own default.
  const baseParams: string[] = [];
  if (currency) baseParams.push(`currency=${encodeURIComponent(currency)}`);
  if (sportId) baseParams.push(`sport=${encodeURIComponent(sportId)}`);

  const link = (next: TabKind) => {
    const parts = [...baseParams, `tab=${next}`];
    if (next === "bigWins" && ticketSort !== "recent") {
      parts.push(`sort=${encodeURIComponent(ticketSort)}`);
    } else if (next === "analyses" && analysisSort !== "recommended") {
      parts.push(`sort=${encodeURIComponent(analysisSort)}`);
    }
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
      <Tab href={link("analyses")} active={activeTab === "analyses"}>
        Analyses
      </Tab>
      <Tab href={link("competitions")} active={activeTab === "competitions"}>
        Competitions
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
  activeSort: TicketSortKind;
  tab: TabKind;
  currency: Currency | null;
  sportId: number | null;
}) {
  const baseParams: string[] = [`tab=${tab}`];
  if (currency) baseParams.push(`currency=${encodeURIComponent(currency)}`);
  if (sportId) baseParams.push(`sport=${encodeURIComponent(sportId)}`);
  const link = (s: TicketSortKind) =>
    `/community?${[...baseParams, `sort=${s}`].join("&")}`;

  const options: TicketSortKind[] = ["recent", "copied", "stakes", "live"];

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
      <span className="uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Sort
      </span>
      {options.map((s) => (
        <SortChip key={s} href={link(s)} active={activeSort === s}>
          {TICKET_SORT_LABELS[s]}
        </SortChip>
      ))}
    </div>
  );
}

// Sort dropdown for the Analyses tab. Same chip pattern as the
// tickets-tab dropdown; different sort universe so the labels and
// API param values diverge.
function AnalysisSortDropdown({
  activeSort,
  currency,
  sportId,
}: {
  activeSort: AnalysisSortKind;
  currency: Currency | null;
  sportId: number | null;
}) {
  const baseParams: string[] = [`tab=analyses`];
  if (currency) baseParams.push(`currency=${encodeURIComponent(currency)}`);
  if (sportId) baseParams.push(`sport=${encodeURIComponent(sportId)}`);
  const link = (s: AnalysisSortKind) =>
    `/community?${[...baseParams, `sort=${s}`].join("&")}`;

  const options: AnalysisSortKind[] = [
    "recommended",
    "recent",
    "most_inspired",
    "top_authors",
  ];

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
      <span className="uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Sort
      </span>
      {options.map((s) => (
        <SortChip key={s} href={link(s)} active={activeSort === s}>
          {ANALYSIS_SORT_LABELS[s]}
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
  if (tab === "analyses") {
    if (filtered && sportName) {
      body = `No analyses in ${sportName} yet. Try another sport, or check back after the next round of fixtures.`;
    } else if (filtered) {
      body = "No analyses match these filters yet. Try clearing one.";
    } else {
      body = "No published analyses yet. Open a match page and write the first one.";
    }
  } else if (tab === "bigWins") {
    if (filtered && sportName) {
      body = `No big wins in ${sportName} yet. Try another sport, or check back after the next match.`;
    } else if (filtered) {
      body = "No big wins match these filters yet. Try clearing one.";
    } else {
      body = "Big wins land here. Wins above the Big Win threshold show up here. Place a bet to start the streak.";
    }
  } else if (tab === "competitions") {
    if (filtered && sportName) {
      body = `No active competitions for ${sportName} yet. Try another sport, or check back when the next event opens.`;
    } else if (filtered) {
      body = "No competitions match these filters. Try clearing one.";
    } else {
      body = "No active competitions yet. The next prediction game will appear here as soon as it opens.";
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
