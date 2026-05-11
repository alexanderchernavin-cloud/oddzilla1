"use client";

// Client-side Analyses section on /match/[id].
//
// Lifted out of SSR on 2026-05-11 — see docs/LOADTEST.md. The previous
// server-rendered version added a third /api/community/* fetch to every
// match-page render and the path is per-IP-rate-limited (which all
// k6 VUs share, so the section's 429s were dominating the load test's
// failure mode). Moving it client-side:
//   - Lets the match page SSR finish in one /catalog/matches/:id round
//     trip, regardless of how slow community is
//   - Spreads the /api/community/analyses load across each viewer's
//     own IP (proper per-user rate limiting)
//   - Renders the match data immediately; the analyses panel fills in
//     post-hydration with a brief skeleton
//
// Caller props are unchanged. `loggedIn` replaces the previous
// server-side `getSessionUser()` because we can't call /auth/me from
// a client component — the parent server component passes it down.

import { useEffect, useState } from "react";
import type { AnalysisFeedResponse, AnalysisSummary } from "@oddzilla/types";
import { clientApi, ApiFetchError } from "@/lib/api-client";
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
  loggedIn: boolean;
}

export function MatchAnalysesSection({
  matchId,
  matchTitle,
  matchStatus,
  loggedIn,
}: Props) {
  const isPreMatch = matchStatus === "not_started";
  const isLiveOrClosed = matchStatus === "live" || matchStatus === "closed";
  const showWriteButton = loggedIn && isPreMatch;

  const [analyses, setAnalyses] = useState<AnalysisSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    // Cancelled / suspended fixtures fall through to a null render
    // below, so skip the fetch entirely — we'd just discard it.
    if (!isPreMatch && !isLiveOrClosed) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setErrored(false);
    clientApi<AnalysisFeedResponse>(
      `/community/analyses?match=${encodeURIComponent(matchId)}&sort=recommended&pageSize=10`,
    )
      .then((res) => {
        if (cancelled) return;
        setAnalyses(res.analyses ?? []);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Soft-fail: a 429 from the rate limiter or a transient 5xx
        // should not break the match page. Render the empty-hint
        // placeholder and move on; user can refresh manually.
        if (e instanceof ApiFetchError) {
          // No-op — render the empty state below.
        }
        setAnalyses([]);
        setErrored(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [matchId, isPreMatch, isLiveOrClosed]);

  // Render whenever the analysis window is meaningful or recently
  // closed: pre-match (so logged-in users can publish, anonymous
  // users see the affordance) OR live/closed (so any analyses are
  // visible and a viewer who arrives expecting the Write CTA gets
  // an honest "window closed" answer instead of a silent no-op).
  if (!isPreMatch && !isLiveOrClosed) {
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

      {loading ? (
        <AnalysesSkeleton />
      ) : analyses && analyses.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {analyses.map((a) => (
            <AnalysisCard key={a.id} analysis={a} hideMatch />
          ))}
        </ul>
      ) : (
        <EmptyHint
          loggedIn={loggedIn}
          isPreMatch={isPreMatch}
          errored={errored}
        />
      )}
    </section>
  );
}

// Visual placeholder while the client fetch is in flight. Three rows
// match the average analyses count and keep the page height stable
// so further content below doesn't jump when results arrive.
function AnalysesSkeleton() {
  return (
    <ul className="mt-4 space-y-3" aria-hidden>
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="rounded-[12px] border border-[var(--color-border)] p-4"
          style={{ background: "var(--surface)" }}
        >
          <div
            style={{
              height: 12,
              width: "55%",
              borderRadius: 4,
              background: "var(--surface-2)",
            }}
          />
          <div
            style={{
              marginTop: 10,
              height: 10,
              width: "85%",
              borderRadius: 4,
              background: "var(--surface-2)",
            }}
          />
          <div
            style={{
              marginTop: 6,
              height: 10,
              width: "70%",
              borderRadius: 4,
              background: "var(--surface-2)",
            }}
          />
        </li>
      ))}
    </ul>
  );
}

// Keeps the empty-state copy honest about *why* the user isn't
// seeing a CTA. Four cases now (with `errored` so a transient
// fetch failure doesn't look like a genuine "no analyses yet"):
//   pre-match + logged in   → "Be the first" (CTA right above)
//   pre-match + anonymous   → "Log in to publish"
//   live/closed             → window closed (no analyses landed
//                             before kickoff)
//   errored                 → "Couldn't load analyses, try again"
function EmptyHint({
  loggedIn,
  isPreMatch,
  errored,
}: {
  loggedIn: boolean;
  isPreMatch: boolean;
  errored: boolean;
}) {
  let body: string;
  if (errored) {
    body = "Couldn't load analyses. Refresh to retry.";
  } else if (isPreMatch && loggedIn) {
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
