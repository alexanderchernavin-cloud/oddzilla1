import Link from "next/link";
import type {
  LeaderboardResponse,
  LeaderboardRow,
  LeaderboardSort,
  AnalysisOutcome,
} from "@oddzilla/types";
import { serverApi } from "@/lib/server-fetch";
import { getTranslations, getServerLocale } from "@/lib/i18n/server";
import { Avatar } from "@/components/community/avatar";
import { CommunityTabs } from "@/components/community/tabs";

type LeaderboardT = Awaited<ReturnType<typeof getTranslations>>;

export const dynamic = "force-dynamic";

// Top Authors leaderboard. Ranks bettors by Oz earned (30d default).
// Renders as a minimal table: rank, avatar, nickname, recent W/L
// strip, ROI %, Oz earned. The visual "Expert cut-off" line drops in
// at the row where isExpertCandidate flips false — i.e. between
// ranks 5 and 6.
//
// Filters live in the URL so the view is shareable:
//   ?sport=<slug>   — sport filter (omit = all sports)
//   ?sort=oz|roi|recent
//   ?window=30d|all_time

interface SportsResponse {
  sports: Array<{ id: number; slug: string; name: string }>;
}

const SORT_LABEL_KEYS: Record<LeaderboardSort, string> = {
  oz: "sortOz",
  roi: "sortRoi",
  recent: "sortRecent",
};

function parseSort(raw: string | undefined): LeaderboardSort {
  if (raw === "roi" || raw === "recent") return raw;
  return "oz";
}

function parseSportSlug(raw: string | undefined): string | null {
  if (!raw) return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) return null;
  return raw;
}

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    sport?: string;
    sort?: string;
    window?: string;
  }>;
}) {
  const params = await searchParams;
  const sport = parseSportSlug(params.sport);
  const sort = parseSort(params.sort);
  const t = await getTranslations("leaderboardPage");
  const tCommunity = await getTranslations("community");
  const tTicket = await getTranslations("ticket");
  const locale = await getServerLocale();

  const queryParts: string[] = [`sort=${sort}`];
  if (sport) queryParts.push(`sport=${sport}`);

  const [board, sportsRes] = await Promise.all([
    serverApi<LeaderboardResponse>(
      `/community/leaderboard?${queryParts.join("&")}`,
    ),
    serverApi<SportsResponse>("/catalog/sports"),
  ]);

  const rows = board?.rows ?? [];
  const viewerRow = board?.viewerRow ?? null;
  const sports = sportsRes?.sports ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-4 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <span className="text-sm text-[var(--color-fg-muted)]">
          {t("window30d")}
        </span>
      </header>

      {/* Same tab strip as /community so users can hop between feed
          surfaces. Active state is "leaderboard" here; the other tabs
          link back to /community?tab=... */}
      <CommunityTabs activeTab="leaderboard" />


      {/* Sport filter — chip row. "All" returns the unfiltered view;
          each sport slug toggles the ?sport= query param. */}
      <nav
        className="mb-3 flex flex-wrap items-center gap-2"
        aria-label={t("sportFilterAria")}
      >
        <SportChip
          href={leaderboardHref({ sport: null, sort })}
          active={sport === null}
          label={tCommunity("allSports")}
        />
        {sports.map((s) => (
          <SportChip
            key={s.slug}
            href={leaderboardHref({ sport: s.slug, sort })}
            active={sport === s.slug}
            label={s.name}
          />
        ))}
      </nav>

      {/* Sort pills — minimal nudge surface. Three discrete modes only;
          deliberately no "ranking algorithm" tunable here. */}
      <nav className="mb-4 flex items-center gap-2" aria-label={t("sortAria")}>
        {(["oz", "roi", "recent"] as LeaderboardSort[]).map((opt) => (
          <SortPill
            key={opt}
            href={leaderboardHref({ sport, sort: opt })}
            active={sort === opt}
            label={t(SORT_LABEL_KEYS[opt])}
          />
        ))}
      </nav>

      {/* Rows. Empty state is plain text — no illustration — to match
          the minimalistic stance for v1. */}
      {rows.length === 0 ? (
        <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-6 text-center text-sm text-[var(--color-fg-muted)]">
          {t("empty")}
        </p>
      ) : (
        <ol className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          {rows.map((row, idx) => (
            <RowAndCutoff
              key={row.userId}
              row={row}
              prevIsCandidate={idx > 0 ? rows[idx - 1]!.isExpertCandidate : true}
              t={t}
              tWon={tTicket("won")}
              tLost={tTicket("lost")}
              locale={locale}
            />
          ))}
        </ol>
      )}

      {/* Viewer's own rank as a sticky-feeling footer when they're not
          inside the top-N. Same row chrome so the position reads as
          part of the same surface, not a separate widget. */}
      {viewerRow && !rows.some((r) => r.userId === viewerRow.userId) && (
        <section className="mt-3" aria-label={t("yourRank")}>
          <p className="mb-1 text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
            {t("yourRank")}
          </p>
          <ol className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
            <Row
              row={viewerRow}
              highlight
              t={t}
              tWon={tTicket("won")}
              tLost={tTicket("lost")}
              locale={locale}
            />
          </ol>
        </section>
      )}
    </div>
  );
}

// ─── Row primitives ────────────────────────────────────────────────────────

function RowAndCutoff({
  row,
  prevIsCandidate,
  t,
  tWon,
  tLost,
  locale,
}: {
  row: LeaderboardRow;
  prevIsCandidate: boolean;
  t: LeaderboardT;
  tWon: string;
  tLost: string;
  locale: string;
}) {
  // The cut-off line appears between the last candidate and the first
  // non-candidate — i.e. between rank 5 and rank 6 under v1 rules.
  const showCutoff = prevIsCandidate && !row.isExpertCandidate;
  return (
    <>
      {showCutoff && (
        <li
          aria-hidden
          className="flex items-center gap-2 border-t border-b border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1"
        >
          <span className="h-px flex-1 bg-[var(--color-accent)] opacity-40" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
            {t("expertCutoff")}
          </span>
          <span className="h-px flex-1 bg-[var(--color-accent)] opacity-40" />
        </li>
      )}
      <Row row={row} t={t} tWon={tWon} tLost={tLost} locale={locale} />
    </>
  );
}

function Row({
  row,
  highlight = false,
  t,
  tWon,
  tLost,
  locale,
}: {
  row: LeaderboardRow;
  highlight?: boolean;
  t: LeaderboardT;
  tWon: string;
  tLost: string;
  locale: string;
}) {
  return (
    <li
      className={`flex items-center gap-3 border-b border-[var(--color-border)] px-3 py-2 last:border-b-0 ${
        highlight ? "bg-[var(--color-accent-soft)]" : ""
      }`}
    >
      <span className="w-6 shrink-0 text-center text-sm font-bold tabular-nums text-[var(--color-fg)]">
        {row.rank}
      </span>
      <Avatar imageUrl={row.avatarUrl} name={row.nickname} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Link
            href={`/u/${encodeURIComponent(row.nickname)}`}
            className="block truncate text-sm font-semibold text-[var(--color-fg)] hover:underline"
          >
            {row.nickname}
          </Link>
          {row.isExpert && (
            <span
              title={t("expert")}
              className="inline-flex shrink-0 items-center rounded-sm bg-[var(--color-accent)] px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--color-accent-fg)]"
            >
              {t("expert")}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <WLBadges results={row.recentOutcomes} t={t} tWon={tWon} tLost={tLost} />
          <span className="text-xs text-[var(--color-fg-muted)]">
            {t("settledCount", { count: row.settled })}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-baseline gap-3 text-sm tabular-nums">
        <span
          className={
            row.roiPct === null
              ? "text-[var(--color-fg-muted)]"
              : row.roiPct >= 0
                ? "text-[var(--color-success)]"
                : "text-[var(--color-danger)]"
          }
        >
          {row.roiPct === null ? "—" : `${row.roiPct > 0 ? "+" : ""}${row.roiPct.toFixed(1)}%`}
        </span>
        <span className="font-bold text-[var(--color-accent)]">
          {t("ozEarned", { amount: row.ozEarned.toLocaleString(locale) })}
        </span>
      </div>
    </li>
  );
}

// Recent-outcomes mini badges. Five slots; missing slots render as
// dim placeholders so the row height stays consistent regardless of
// how many settled analyses the user has.
function WLBadges({
  results,
  t,
  tWon,
  tLost,
}: {
  results: AnalysisOutcome[];
  t: LeaderboardT;
  tWon: string;
  tLost: string;
}) {
  const slots = [0, 1, 2, 3, 4];
  return (
    <span
      className="inline-flex items-center gap-0.5"
      aria-label={t("recentResultsAria")}
    >
      {slots.map((i) => {
        const r = results[i];
        if (!r) {
          return (
            <span
              key={i}
              aria-hidden
              className="h-3 w-3 rounded-sm bg-[var(--color-border)]"
            />
          );
        }
        const isWin = r === "won";
        return (
          <span
            key={i}
            title={isWin ? tWon : tLost}
            className={`flex h-3 w-3 items-center justify-center rounded-sm text-[8px] font-bold leading-none text-white ${
              isWin ? "bg-[var(--color-success)]" : "bg-[var(--color-danger)]"
            }`}
          >
            {isWin ? t("winLetter") : t("lossLetter")}
          </span>
        );
      })}
    </span>
  );
}

// ─── Chip components ──────────────────────────────────────────────────────

function SportChip({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-xs ${
        active
          ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
          : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
      }`}
    >
      {label}
    </Link>
  );
}

function SortPill({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
        active
          ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
          : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
      }`}
    >
      {label}
    </Link>
  );
}

function leaderboardHref({
  sport,
  sort,
}: {
  sport: string | null;
  sort: LeaderboardSort;
}): string {
  const parts: string[] = [];
  if (sport) parts.push(`sport=${encodeURIComponent(sport)}`);
  if (sort !== "oz") parts.push(`sort=${sort}`);
  return parts.length === 0 ? "/community/leaderboard" : `/community/leaderboard?${parts.join("&")}`;
}
