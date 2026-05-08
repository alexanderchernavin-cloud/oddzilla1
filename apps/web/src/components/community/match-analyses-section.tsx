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

  const isPreMatch = matchStatus === "not_started";
  const showWriteButton = Boolean(sessionUser) && isPreMatch;

  // Render whenever the analysis window is meaningful: pre-match
  // (so logged-in users can publish, anonymous users see the
  // affordance) OR there's existing content (so live/closed
  // matches show the analyses people published before kickoff).
  // Cancelled / suspended matches with no analyses fall through
  // to null — they're operational dead-ends, no editorial signal.
  if (analyses.length === 0 && !isPreMatch) {
    return null;
  }

  return (
    <section className="mt-8">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-sm uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
            Pre-match analyses
          </h2>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            {isPreMatch
              ? "Skin-in-the-game takes from the community. 100–5000 chars; min odds 1.30."
              : "Pre-match window closed — these were published before kickoff."}
          </p>
        </div>
        {showWriteButton ? (
          <WriteAnalysisButton matchId={matchId} matchTitle={matchTitle} />
        ) : null}
      </header>

      {analyses.length === 0 ? (
        <EmptyHint loggedIn={Boolean(sessionUser)} isPreMatch={isPreMatch} />
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

// Keeps the empty-state copy honest about *why* the user isn't
// seeing a CTA. Three real cases (everything else falls through
// to a returns-null upstream):
//   pre-match + logged in   → "Be the first" (CTA right above)
//   pre-match + anonymous   → "Log in to publish"
//   live/closed             → window closed (no analyses landed
//                             before kickoff)
function EmptyHint({
  loggedIn,
  isPreMatch,
}: {
  loggedIn: boolean;
  isPreMatch: boolean;
}) {
  let body: string;
  if (isPreMatch && loggedIn) {
    body = "No analyses on this match yet. Be the first.";
  } else if (isPreMatch) {
    body = "No analyses on this match yet. Log in and place a bet to publish one.";
  } else {
    body = "No analyses landed before kickoff.";
  }
  return (
    <p className="mt-4 rounded-[12px] border border-dashed border-[var(--color-border-strong)] p-6 text-center text-sm text-[var(--color-fg-muted)]">
      {body}
    </p>
  );
}
