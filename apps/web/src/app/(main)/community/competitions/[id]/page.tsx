import Link from "next/link";
import { notFound } from "next/navigation";
import type {
  CompetitionDetail,
  CompetitionLeaderboardResponse,
  CompetitionMatchesResponse,
} from "@oddzilla/types";
import { getSessionUser } from "@/lib/auth";
import { serverApi } from "@/lib/server-fetch";
import { CompetitionJoinButton } from "@/components/community/competition-join-button";
import { CompetitionMatchesList } from "@/components/community/competition-matches-list";
import { CompetitionLeaderboard } from "@/components/community/competition-leaderboard";

export const dynamic = "force-dynamic";

type View = "overview" | "matches" | "leaderboard";

function parseView(raw: string | undefined): View {
  if (raw === "matches" || raw === "leaderboard") return raw;
  return "overview";
}

export default async function CompetitionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { id } = await params;
  const { view: rawView } = await searchParams;
  const view = parseView(rawView);

  const sessionUser = await getSessionUser();

  // Detail call powers the header on every view; matches/leaderboard
  // load on demand per active sub-tab.
  const detail = await serverApi<CompetitionDetail>(
    `/community/competitions/${id}`,
  );
  if (!detail) notFound();

  let matches: CompetitionMatchesResponse["matches"] = [];
  let leaderboard: CompetitionLeaderboardResponse | null = null;
  if (view === "matches") {
    const r = await serverApi<CompetitionMatchesResponse>(
      `/community/competitions/${id}/matches`,
    );
    matches = r?.matches ?? [];
  } else if (view === "leaderboard") {
    leaderboard = await serverApi<CompetitionLeaderboardResponse>(
      `/community/competitions/${id}/leaderboard`,
    );
  }

  const startsAt = new Date(detail.matchStartAt);

  return (
    <div>
      <Link
        href="/community?tab=competitions"
        className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
      >
        ← Competitions
      </Link>
      <header className="mt-3">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          <span>{detail.type}</span>
          <span>·</span>
          <span>{detail.status}</span>
          {detail.featured ? (
            <>
              <span>·</span>
              <span className="text-[var(--color-accent)]">Featured</span>
            </>
          ) : null}
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{detail.title}</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
          {[detail.sportName, detail.league].filter(Boolean).join(" · ") ||
            "Multi-sport"}
          {" · "}
          {detail.participantCount.toLocaleString()} joined · {detail.matchCount} matches
        </p>
      </header>

      <div className="mt-4">
        <CompetitionJoinButton
          competitionId={detail.id}
          isAuthed={Boolean(sessionUser)}
          viewerJoined={detail.viewerJoined}
          status={detail.status}
        />
      </div>

      <SubTabs id={detail.id} view={view} />

      <div className="mt-6">
        {view === "overview" ? (
          <OverviewView detail={detail} startsAt={startsAt} />
        ) : view === "matches" ? (
          <CompetitionMatchesList
            competitionId={detail.id}
            competitionType={detail.type}
            matches={matches}
            isAuthed={Boolean(sessionUser)}
            viewerJoined={Boolean(detail.viewerJoined)}
          />
        ) : (
          <CompetitionLeaderboard data={leaderboard} />
        )}
      </div>
    </div>
  );
}

function SubTabs({ id, view }: { id: string; view: View }) {
  const link = (v: View) =>
    v === "overview"
      ? `/community/competitions/${id}`
      : `/community/competitions/${id}?view=${v}`;
  const cls = (active: boolean) =>
    "rounded-[8px] px-3 py-1.5 text-xs uppercase tracking-[0.15em] transition " +
    (active
      ? "bg-[var(--color-bg-elevated)] text-[var(--color-fg)]"
      : "text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]");
  return (
    <div
      role="tablist"
      aria-label="Section"
      className="mt-5 inline-flex rounded-[10px] border border-[var(--color-border-strong)] p-1"
    >
      <a role="tab" href={link("overview")} className={cls(view === "overview")}>
        Overview
      </a>
      <a role="tab" href={link("matches")} className={cls(view === "matches")}>
        Matches
      </a>
      <a role="tab" href={link("leaderboard")} className={cls(view === "leaderboard")}>
        Leaderboard
      </a>
    </div>
  );
}

function OverviewView({
  detail,
  startsAt,
}: {
  detail: CompetitionDetail;
  startsAt: Date;
}) {
  return (
    <div className="space-y-6">
      {detail.description ? (
        <p className="whitespace-pre-line text-sm text-[var(--color-fg)]">
          {detail.description}
        </p>
      ) : null}

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Schedule
        </h2>
        <dl className="mt-2 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <ScheduleCell label="Launch" value={detail.launchAt} />
          <ScheduleCell label="Picks close" value={detail.betCloseAt} />
          <ScheduleCell label="Match start" value={detail.matchStartAt} />
          <ScheduleCell label="Stops showing" value={detail.stopShowAt} />
        </dl>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Rules
        </h2>
        {detail.rules.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
            No rules configured yet.
          </p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm text-[var(--color-fg)]">
            {detail.rules.map((r, i) => (
              <li key={i} className="before:mr-2 before:content-['•']">
                {r}
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.markets.length > 0 ? (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Markets
          </h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {detail.markets.map((m) => (
              <span
                key={m}
                className="rounded-full border border-[var(--color-border-strong)] px-2.5 py-1 text-xs text-[var(--color-fg-muted)]"
              >
                {m}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {/* Reference startsAt to satisfy unused-var; the FE composes
          countdowns from this in a follow-up commit. */}
      <span className="hidden">{startsAt.toISOString()}</span>
    </div>
  );
}

function ScheduleCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-3">
      <dt className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {label}
      </dt>
      <dd className="mt-1 text-xs text-[var(--color-fg)]">
        {new Date(value).toLocaleString()}
      </dd>
    </div>
  );
}
