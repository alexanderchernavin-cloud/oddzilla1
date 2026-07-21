"use client";

import type {
  CompetitionLeaderboardEntry,
  CompetitionLeaderboardResponse,
} from "@oddzilla/types";
import { useTranslations } from "@/lib/i18n";

export function CompetitionLeaderboard({
  data,
}: {
  data: CompetitionLeaderboardResponse | null;
}) {
  const t = useTranslations("competitions");
  if (!data) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">
        {t("leaderboardLoadFailed")}
      </p>
    );
  }
  if (data.entries.length === 0) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">
        {t("leaderboardEmpty")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {data.viewerEntry ? (
        <div className="rounded-[10px] border border-[var(--color-accent)] bg-[var(--color-bg-elevated)] p-3">
          <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            {t("yourPosition")}
          </div>
          <Row entry={data.viewerEntry} highlight />
        </div>
      ) : null}

      <div className="overflow-hidden rounded-[10px] border border-[var(--color-border-strong)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--color-bg-elevated)] text-left text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">{t("colBettor")}</th>
              <th className="px-3 py-2 text-right">{t("colPts")}</th>
              <th className="px-3 py-2 text-right">{t("colCorrect")}</th>
              <th className="px-3 py-2 text-right">{t("colStreak")}</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e) => (
              <tr
                key={e.userId}
                className={
                  "border-t border-[var(--color-border-subtle)] " +
                  (e.isYou ? "bg-[var(--color-accent-soft)]" : "")
                }
              >
                <Cell>{e.rank}</Cell>
                <Cell>
                  <span className="font-medium text-[var(--color-fg)]">
                    {e.nickname}
                  </span>
                  {e.isYou ? (
                    <span className="ml-2 text-[10px] uppercase tracking-[0.15em] text-[var(--color-accent)]">
                      {t("you")}
                    </span>
                  ) : null}
                </Cell>
                <Cell align="right" mono>
                  {e.points}
                </Cell>
                <Cell align="right" mono>
                  {e.correctCount}/{e.totalSettled}
                </Cell>
                <Cell align="right" mono>
                  {e.streak}
                </Cell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-[var(--color-fg-subtle)]">
        {t("totalParticipants", { count: data.totalParticipants })}
      </p>
    </div>
  );
}

function Row({
  entry,
  highlight,
}: {
  entry: CompetitionLeaderboardEntry;
  highlight?: boolean;
}) {
  const t = useTranslations("competitions");
  return (
    <div className="mt-2 flex items-center justify-between text-sm">
      <div>
        <span className={highlight ? "text-[var(--color-accent)]" : "text-[var(--color-fg)]"}>
          #{entry.rank} {entry.nickname}
        </span>
      </div>
      <div className="font-mono text-xs text-[var(--color-fg-muted)]">
        {t("pointsSummary", {
          points: entry.points,
          correct: entry.correctCount,
          total: entry.totalSettled,
        })}
      </div>
    </div>
  );
}

function Cell({
  children,
  align,
  mono,
}: {
  children: React.ReactNode;
  align?: "right";
  mono?: boolean;
}) {
  return (
    <td
      className={
        "px-3 py-2 " +
        (align === "right" ? "text-right " : "") +
        (mono ? "font-mono text-xs text-[var(--color-fg-muted)]" : "")
      }
    >
      {children}
    </td>
  );
}
