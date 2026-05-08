import Link from "next/link";
import type { CompetitionSummary } from "@oddzilla/types";

// Card row for the /community?tab=competitions list. Mirrors
// competition-v2's CompetitionListRow visual structure (title +
// chips + meta) trimmed to oddzilla's existing card chrome.

const TYPE_LABEL: Record<CompetitionSummary["type"], string> = {
  prediction: "Predictor",
  tipping: "Tipping",
  challenge: "Challenge",
};

const STATUS_LABEL: Record<CompetitionSummary["status"], string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  upcoming: "Upcoming",
  live: "Live",
  ended: "Ended",
};

export function CompetitionCard({
  competition: c,
}: {
  competition: CompetitionSummary;
}) {
  const startsAt = new Date(c.matchStartAt);
  const startsLabel = formatRelative(startsAt);

  return (
    <li>
      <Link
        href={`/community/competitions/${c.id}`}
        className="block rounded-[12px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-4 transition hover:border-[var(--color-border-stronger)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {c.featured ? (
                <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--color-accent)]">
                  Featured
                </span>
              ) : null}
              <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                {TYPE_LABEL[c.type]}
              </span>
              <span
                className={
                  "text-[10px] font-semibold uppercase tracking-[0.15em] " +
                  (c.status === "live"
                    ? "text-[var(--color-accent)]"
                    : c.status === "ended"
                      ? "text-[var(--color-fg-subtle)]"
                      : "text-[var(--color-fg-muted)]")
                }
              >
                {STATUS_LABEL[c.status]}
              </span>
            </div>
            <h3 className="mt-2 truncate text-base font-semibold text-[var(--color-fg)]">
              {c.title}
            </h3>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
              {[c.sportName, c.league].filter(Boolean).join(" · ") || "Multi-sport"}
            </p>
          </div>
          <div className="shrink-0 text-right text-xs text-[var(--color-fg-muted)]">
            <div>{c.participantCount.toLocaleString()} joined</div>
            <div className="mt-1">{c.matchCount} matches</div>
            <div className="mt-1">{startsLabel}</div>
          </div>
        </div>
        {c.viewerJoined ? (
          <div className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-accent)]">
            <span>● Joined</span>
            {c.viewerRank !== null ? <span>· Rank #{c.viewerRank}</span> : null}
          </div>
        ) : null}
      </Link>
    </li>
  );
}

function formatRelative(d: Date): string {
  const ms = d.getTime() - Date.now();
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60_000);
  if (min < 60) return ms >= 0 ? `Starts in ${min}m` : `Started ${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return ms >= 0 ? `Starts in ${h}h` : `Started ${h}h ago`;
  const d2 = Math.round(h / 24);
  return ms >= 0 ? `Starts in ${d2}d` : `${d2}d ago`;
}
