"use client";

// Shared card used on /match/[id], /community?tab=analyses, and
// /u/[nickname]. Renders one analysis with author + match meta +
// perex (always visible) + body (collapsed under "Read more"
// past 240 chars) + 👍 toggle + Copy CTA.
//
// Why one component for three surfaces?
//   The PRD's "visual hierarchy" rule (Key prediction prominent,
//   reasoning scannable) is the same regardless of where the card
//   renders. Differences between surfaces — whether to show the
//   match title, whether to show the author — are toggles, not
//   layout variants. One component, three flag combinations.

import { useState, useTransition } from "react";
import Link from "next/link";
import type { AnalysisOutcome, AnalysisSummary } from "@oddzilla/types";
import { fromMicro } from "@oddzilla/types/money";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { useBetSlip } from "@/lib/bet-slip";
import { Avatar } from "./avatar";

interface Props {
  analysis: AnalysisSummary;
  // Compact toggles per surface. Match-page hides the match meta
  // (the page already shows it); profile hides the author chip
  // (the page already shows the author).
  hideMatch?: boolean;
  hideAuthor?: boolean;
  // Optional collapsed-by-default mode for the cross-match feed,
  // where stacking 5 long bodies makes the page unscannable.
  collapsed?: boolean;
}

const COLLAPSE_LIMIT = 240;

export function AnalysisCard({
  analysis,
  hideMatch = false,
  hideAuthor = false,
  collapsed = true,
}: Props) {
  const [reacted, setReacted] = useState<boolean | null>(analysis.viewerReacted);
  const [thumbsUp, setThumbsUp] = useState(analysis.thumbsUpCount);
  const [reactPending, setReactPending] = useState(false);
  const [expanded, setExpanded] = useState(!collapsed);
  const router = useRouter();
  const slip = useBetSlip();
  const [_, startTransition] = useTransition();

  const isLong = analysis.body.length > COLLAPSE_LIMIT;
  const visibleBody = expanded || !isLong
    ? analysis.body
    : analysis.body.slice(0, COLLAPSE_LIMIT) + "…";

  async function onReact() {
    if (reactPending) return;
    setReactPending(true);
    try {
      const updated = await clientApi<AnalysisSummary>(
        `/community/analyses/${analysis.id}/inspire`,
        { method: "POST" },
      );
      setReacted(updated.viewerReacted);
      setThumbsUp(updated.thumbsUpCount);
    } catch (err) {
      // 401 → bounce to login; otherwise leave as-is and surface
      // a one-shot console hint, not a toast (the card is the row,
      // not the page).
      if (err instanceof ApiFetchError && err.status === 401) {
        router.push("/login");
      }
    } finally {
      setReactPending(false);
    }
  }

  async function onCopy() {
    // Copy the analysis's attached ticket into the slip. Re-uses the
    // existing /community/copy endpoint — same shape as the Big Wins
    // CTA — and bumps the analysis's inspiration_count via the
    // counter already on the row. Future PR threads
    // copied_from_analysis_id through bet placement.
    try {
      const resp = await clientApi<{
        selections: Array<{
          matchId: string;
          marketId: string;
          outcomeId: string;
          odds: string;
          homeTeam: string;
          awayTeam: string;
          marketLabel: string;
          outcomeLabel: string;
          sportSlug: string;
          available: boolean;
        }>;
        anyAvailable: boolean;
      }>(`/community/copy/${analysis.ticketId}`, { method: "POST" });

      const available = resp.selections.filter((s) => s.available);
      for (const sel of available) {
        slip.add(sel);
      }
      slip.setOpen(true);
      startTransition(() => router.refresh());
    } catch (err) {
      if (err instanceof ApiFetchError && err.status === 401) {
        router.push("/login");
      }
    }
  }

  return (
    <li className="card p-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {!hideAuthor ? (
          <Link
            href={`/u/${encodeURIComponent(analysis.authorNickname)}`}
            className="flex items-center gap-2 hover:opacity-80"
          >
            <Avatar imageUrl={analysis.authorAvatarUrl} name={analysis.authorNickname} size={32} />
            <span className="text-sm font-medium">{analysis.authorNickname}</span>
          </Link>
        ) : null}
        {analysis.authorWinRate !== null ? (
          <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            {analysis.authorWinRate}% win rate
          </span>
        ) : null}
        <OutcomeBadge outcome={analysis.outcome} />
        <span className="ml-auto text-xs text-[var(--color-fg-subtle)]">
          {timeAgo(analysis.publishedAt)}
        </span>
      </header>

      {!hideMatch ? (
        <Link
          href={`/match/${analysis.matchId}`}
          className="mt-2 block text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          {analysis.sportName} · {analysis.matchTitle} · kickoff{" "}
          {kickoffLabel(analysis.scheduledAt)}
        </Link>
      ) : null}

      <p className="mt-2 text-sm font-medium text-[var(--color-fg)]">{analysis.perex}</p>

      <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--color-fg-muted)]">
        {visibleBody}
      </p>
      {isLong ? (
        <button
          type="button"
          className="mt-1 text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:underline"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Read less" : "Read more"}
        </button>
      ) : null}

      <footer className="mt-3 flex items-center justify-between border-t border-[var(--color-border-strong)] pt-3 text-xs">
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={reactPending}
            onClick={onReact}
            className={
              "inline-flex items-center gap-1 rounded-full border px-3 py-1 transition " +
              (reacted
                ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
            }
            aria-pressed={reacted ?? false}
            aria-label="Thumbs up"
          >
            <span aria-hidden>👍</span>
            <span className="font-mono">{thumbsUp}</span>
          </button>
          <span className="inline-flex items-center gap-1 text-[var(--color-fg-subtle)]">
            <span aria-hidden>🔥</span>
            <span className="font-mono">{analysis.inspirationCount}</span>
          </span>
          <span className="inline-flex items-center gap-1 text-[var(--color-fg-subtle)]">
            @{analysis.ticketTotalOdds}
            {analysis.ticketLegCount > 1 ? ` · ${analysis.ticketLegCount} legs` : ""}
          </span>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="rounded-full border border-[var(--color-accent)] px-3 py-1 text-[11px] uppercase tracking-[0.15em] text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/10"
        >
          Copy bet
        </button>
      </footer>
    </li>
  );
}

function OutcomeBadge({ outcome }: { outcome: AnalysisOutcome | null }) {
  if (outcome === null) {
    return (
      <span className="rounded-full border border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Pending
      </span>
    );
  }
  const tone =
    outcome === "won"
      ? "border-[var(--color-positive)]/40 text-[var(--color-positive)]"
      : outcome === "lost"
        ? "border-[var(--color-negative)]/40 text-[var(--color-negative)]"
        : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)]";
  const label =
    outcome === "won"
      ? "Won"
      : outcome === "lost"
        ? "Lost"
        : outcome === "void"
          ? "Void"
          : "Cashout (void)";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] ${tone}`}
    >
      {label}
    </span>
  );
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

function kickoffLabel(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "soon";
  const diff = t - Date.now();
  if (diff < 0) return "started";
  const h = Math.round(diff / 3_600_000);
  if (h < 1) return "<1h";
  if (h < 24) return `in ${h}h`;
  const d = Math.round(h / 24);
  return `in ${d}d`;
}

// Avoid an unused warning when fromMicro is referenced only by
// downstream features wiring stake displays.
void fromMicro;
