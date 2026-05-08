// Server-rendered Analyses section on /match/[id].
//
// Fetches the per-match analyses feed (sort=recommended, top 10),
// renders each via AnalysisCard, and inlines a client-only Write
// button that opens the editor modal. The Write button is gated
// server-side: only logged-in users with at least one accepted
// ticket on this match see it (the editor would server-reject any
// publish attempt without one anyway, but skipping the CTA when
// it can't possibly succeed is the kinder UX).

import type { AnalysisFeedResponse } from "@oddzilla/types";
import { getSessionUser } from "@/lib/auth";
import { serverApi } from "@/lib/server-fetch";
import { AnalysisCard } from "./analysis-card";
import { WriteAnalysisButton } from "./write-analysis-button";

interface Props {
  matchId: string;
  matchTitle: string;
  // Pre-match-only — don't bother fetching once a match is live or
  // closed. Analyses written before kickoff stay visible (they're
  // the historical record), but the section's framing of "predict"
  // doesn't apply once the match is in progress.
  matchStatus: "not_started" | "live" | "closed" | "cancelled" | "suspended";
}

export async function MatchAnalysesSection({ matchId, matchTitle, matchStatus }: Props) {
  const sessionUser = await getSessionUser();

  const feed = await serverApi<AnalysisFeedResponse>(
    `/community/analyses?match=${encodeURIComponent(matchId)}&sort=recommended&pageSize=10`,
  );
  const analyses = feed?.analyses ?? [];

  const showWriteButton = Boolean(sessionUser) && matchStatus === "not_started";

  if (analyses.length === 0 && !showWriteButton) {
    // No-op: pre-match without auth + no analyses → nothing to render.
    // Returning null keeps the page from a vacant header band.
    return null;
  }

  return (
    <section className="mt-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
            Pre-match analyses
          </h2>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Skin-in-the-game takes from the community. 100–5000 chars; min odds 1.30.
          </p>
        </div>
        {showWriteButton ? (
          <WriteAnalysisButton matchId={matchId} matchTitle={matchTitle} />
        ) : null}
      </header>

      {analyses.length === 0 ? (
        <p className="mt-4 rounded-[12px] border border-dashed border-[var(--color-border-strong)] p-6 text-center text-sm text-[var(--color-fg-muted)]">
          No analyses on this match yet.
          {showWriteButton ? " Be the first." : " Place a bet first to publish one."}
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {analyses.map((a) => (
            <AnalysisCard key={a.id} analysis={a} hideMatch />
          ))}
        </ul>
      )}
    </section>
  );
}
