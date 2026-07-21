"use client";

// Community section tab strip. Shared by /community (Recent / Big wins
// / Analyses / Competitions, all rendered in-place via ?tab=) and the
// sibling sub-routes that live at their own paths (/community/leaderboard).
//
// Sub-route tabs link to a different pathname rather than swapping
// ?tab= on the same page — keeps the URL shareable and the page server-
// rendered without conditional data fetches. Active state for those
// tabs is derived from the parent passing the right activeTab prop.

import type { Currency } from "@oddzilla/types";
import { useTranslations } from "@/lib/i18n";

export type CommunityTabKind =
  | "recent"
  | "bigWins"
  | "analyses"
  | "competitions"
  | "leaderboard";

type TicketSortKind = "recent" | "copied" | "stakes" | "live";
type AnalysisSortKind = "recommended" | "recent" | "most_inspired" | "top_authors";

interface CommunityTabsProps {
  activeTab: CommunityTabKind;
  // Optional state carry across query-driven tabs. Leaderboard has its
  // own sport filter and ignores currency entirely; the function below
  // only stamps these onto the URL for the four query-driven tabs.
  currency?: Currency | null;
  sportId?: number | null;
  // Sort state passed through for the two tabs that have one. The
  // leaderboard's sort lives on its own page and is not preserved here.
  ticketSort?: TicketSortKind;
  analysisSort?: AnalysisSortKind;
}

export function CommunityTabs({
  activeTab,
  currency = null,
  sportId = null,
  ticketSort = "recent",
  analysisSort = "recommended",
}: CommunityTabsProps) {
  const t = useTranslations("community");
  // Query-driven tabs share the /community page and rebuild the query
  // string. Carrying currency + sport across tab switches is the
  // existing convention; sort is per-tab so it only rides along for
  // the tab it belongs to.
  const baseParams: string[] = [];
  if (currency) baseParams.push(`currency=${encodeURIComponent(currency)}`);
  if (sportId) baseParams.push(`sport=${encodeURIComponent(sportId)}`);

  const queryLink = (next: "recent" | "bigWins" | "analyses" | "competitions") => {
    const parts = [...baseParams, `tab=${next}`];
    if (next === "bigWins" && ticketSort !== "recent") {
      parts.push(`sort=${encodeURIComponent(ticketSort)}`);
    } else if (next === "analyses" && analysisSort !== "recommended") {
      parts.push(`sort=${encodeURIComponent(analysisSort)}`);
    }
    return `/community?${parts.join("&")}`;
  };

  // Leaderboard lives at its own path. It accepts ?sport=<slug> via
  // its own page logic — sport id (numeric) doesn't translate
  // directly, so we don't propagate it from query-tab state. Users
  // re-pick the sport on the leaderboard via its own chip row.
  const leaderboardLink = "/community/leaderboard";

  return (
    <div
      role="tablist"
      aria-label={t("sectionAria")}
      className="mt-5 inline-flex rounded-[10px] border border-[var(--color-border-strong)] p-1"
    >
      <Tab href={queryLink("recent")} active={activeTab === "recent"}>
        {t("tabRecent")}
      </Tab>
      <Tab href={queryLink("bigWins")} active={activeTab === "bigWins"}>
        {t("tabBestWins")}
      </Tab>
      <Tab href={queryLink("analyses")} active={activeTab === "analyses"}>
        {t("tabAnalyses")}
      </Tab>
      <Tab href={queryLink("competitions")} active={activeTab === "competitions"}>
        {t("tabCompetitions")}
      </Tab>
      <Tab href={leaderboardLink} active={activeTab === "leaderboard"}>
        {t("tabLeaderboard")}
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
