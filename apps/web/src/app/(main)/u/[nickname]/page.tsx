import { notFound } from "next/navigation";
import type {
  AnalysisAuthorStats,
  AnalysisFeedResponse,
  CommunityProfile,
  CommunityUserTicketsResponse,
} from "@oddzilla/types";
// Runtime values must come from the /currencies subpath — Next.js webpack
// can't resolve the ".js" re-exports in the package root.
import { isCurrency, type Currency } from "@oddzilla/types/currencies";
import { fromMicro } from "@oddzilla/types/money";
import { serverApi } from "@/lib/server-fetch";
import { CurrencyTabs } from "@/components/community/currency-tabs";
import { CommunityTicketCard } from "@/components/community/ticket-card";
import { CommunityAchievementsSection } from "@/components/community/achievements";
import { AnalysisCard } from "@/components/community/analysis-card";
import { Avatar } from "@/components/community/avatar";

interface SportsResponse {
  sports: Array<{ id: number; slug: string; name: string }>;
}

export const dynamic = "force-dynamic";

export default async function PublicProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ nickname: string }>;
  searchParams: Promise<{ currency?: string }>;
}) {
  const { nickname } = await params;
  const { currency: rawCurrency } = await searchParams;
  const currency: Currency =
    rawCurrency && isCurrency(rawCurrency) ? rawCurrency : "USDC";

  const [profile, ticketsRes, sportsRes, analysesRes, analysisStats] =
    await Promise.all([
      serverApi<CommunityProfile>(
        `/community/users/${encodeURIComponent(nickname)}/profile?currency=${currency}`,
      ),
      serverApi<CommunityUserTicketsResponse>(
        `/community/users/${encodeURIComponent(nickname)}/tickets?currency=${currency}&pageSize=10`,
      ),
      serverApi<SportsResponse>("/catalog/sports"),
      // Author's published analyses, cross-currency. The author's
      // tracker reads their full output, not a per-currency slice.
      serverApi<AnalysisFeedResponse>(
        `/community/analyses?author=${encodeURIComponent(nickname)}&sort=recent&pageSize=10`,
      ),
      serverApi<AnalysisAuthorStats>(
        `/community/users/${encodeURIComponent(nickname)}/analysis-stats`,
      ),
    ]);
  if (!profile) notFound();

  const joined = new Date(profile.joinedAt).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
  const tickets = ticketsRes?.tickets ?? [];
  const sportsById = new Map(
    (sportsRes?.sports ?? []).map((s) => [s.id, s]),
  );

  return (
    <div>
      <header className="flex flex-wrap items-start gap-4">
        <Avatar
          imageUrl={profile.avatarUrl}
          name={profile.nickname}
          size={96}
          priority
        />
        <div className="min-w-0 flex flex-1 flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {profile.nickname}
          </h1>
          <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Joined {joined}
          </p>
          {profile.bio ? (
            <p className="mt-2 max-w-prose text-sm">{profile.bio}</p>
          ) : null}
        </div>
      </header>

      <div className="mt-6">
        <CurrencyTabs nickname={profile.nickname} active={currency} />
      </div>

      <section className="mt-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Settled" value={String(profile.stats.settledTickets)} />
        <Stat label="Wins" value={String(profile.stats.wins)} />
        <Stat label="Win rate" value={`${profile.stats.winRatePct}%`} />
        <Stat
          label="ROI"
          value={`${profile.stats.roiPct >= 0 ? "+" : ""}${profile.stats.roiPct}%`}
        />
      </section>

      <CommunityAchievementsSection achievements={profile.achievements} />

      <section className="mt-8">
        <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Recent tickets
        </h2>
        {tickets.length === 0 ? (
          <div className="card mt-3 p-6 text-sm text-[var(--color-fg-muted)]">
            No settled {currency} tickets yet.
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {tickets.map((t) => (
              <CommunityTicketCard
                key={t.ticketId}
                ticket={t}
                sportsById={sportsById}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Outcome tracker + analyses list. Always renders the
          tracker chrome — even an author with zero analyses sees
          the empty state, which is the cue to write one. The
          tracker is cross-currency on purpose; an author's
          output is their output regardless of which wallet a
          reader is browsing in. */}
      <section className="mt-10">
        <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Analyses outcome tracker
        </h2>
        {analysisStats ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <Stat label="Published" value={String(analysisStats.totalAnalyses)} />
            <Stat
              label="Settled"
              value={`${analysisStats.wins}–${analysisStats.losses}${
                analysisStats.voids > 0 ? `–${analysisStats.voids}` : ""
              }`}
            />
            <Stat
              label="Win rate"
              value={
                analysisStats.winRatePct === null
                  ? "—"
                  : `${analysisStats.winRatePct}%`
              }
            />
            <Stat
              label="Inspired turnover"
              value={`${fromMicro(BigInt(analysisStats.inspiredTurnoverMicro))}`}
            />
          </div>
        ) : null}

        <h3 className="mt-6 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Recent analyses
        </h3>
        {analysesRes && analysesRes.analyses.length > 0 ? (
          <ul className="mt-3 space-y-3">
            {analysesRes.analyses.map((a) => (
              <AnalysisCard key={a.id} analysis={a} hideAuthor />
            ))}
          </ul>
        ) : (
          <div className="card mt-3 p-6 text-sm text-[var(--color-fg-muted)]">
            No published analyses yet.
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <dt className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {label}
      </dt>
      <dd className="mt-1 text-lg font-semibold">{value}</dd>
    </div>
  );
}
