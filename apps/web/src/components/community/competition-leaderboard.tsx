import type {
  CompetitionLeaderboardEntry,
  CompetitionLeaderboardResponse,
} from "@oddzilla/types";

export function CompetitionLeaderboard({
  data,
}: {
  data: CompetitionLeaderboardResponse | null;
}) {
  if (!data) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">
        Couldn't load leaderboard.
      </p>
    );
  }
  if (data.entries.length === 0) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">
        Be the first to join — the leaderboard fills as participants make
        predictions.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {data.viewerEntry ? (
        <div className="rounded-[10px] border border-[var(--color-accent)] bg-[var(--color-bg-elevated)] p-3">
          <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Your position
          </div>
          <Row entry={data.viewerEntry} highlight />
        </div>
      ) : null}

      <div className="overflow-hidden rounded-[10px] border border-[var(--color-border-strong)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--color-bg-elevated)] text-left text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Bettor</th>
              <th className="px-3 py-2 text-right">Pts</th>
              <th className="px-3 py-2 text-right">Correct</th>
              <th className="px-3 py-2 text-right">Streak</th>
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
                      You
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
        {data.totalParticipants.toLocaleString()} total participants
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
  return (
    <div className="mt-2 flex items-center justify-between text-sm">
      <div>
        <span className={highlight ? "text-[var(--color-accent)]" : "text-[var(--color-fg)]"}>
          #{entry.rank} {entry.nickname}
        </span>
      </div>
      <div className="font-mono text-xs text-[var(--color-fg-muted)]">
        {entry.points} pts · {entry.correctCount}/{entry.totalSettled} correct
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
