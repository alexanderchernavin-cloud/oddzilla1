import Link from "next/link";
import { notFound } from "next/navigation";
import type {
  CompetitionDetail,
  CompetitionMatchesResponse,
} from "@oddzilla/types";
import { serverApi } from "@/lib/server-fetch";
import { PublishButton } from "./publish-button";
import { ScoreEntryForm } from "./score-entry-form";

export const dynamic = "force-dynamic";

export default async function AdminCompetitionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, matchesRes] = await Promise.all([
    serverApi<CompetitionDetail>(`/admin/competitions/${id}`),
    serverApi<CompetitionMatchesResponse>(`/community/competitions/${id}/matches`),
  ]);
  if (!detail) notFound();
  const matches = matchesRes?.matches ?? [];

  return (
    <div>
      <Link
        href="/admin/competitions"
        className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
      >
        ← Competitions
      </Link>
      <header className="mt-3 flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{detail.title}</h1>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            {detail.type} · {detail.status} · {detail.participantCount.toLocaleString()}{" "}
            joined · {detail.matchCount} matches
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/community/competitions/${detail.id}`}
            target="_blank"
            className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--color-bg-elevated)]"
          >
            Preview ↗
          </Link>
          {detail.status === "draft" ? (
            <PublishButton competitionId={detail.id} />
          ) : null}
        </div>
      </header>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Description
        </h2>
        <p className="mt-2 whitespace-pre-line text-sm text-[var(--color-fg)]">
          {detail.description || "—"}
        </p>
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Schedule
        </h2>
        <dl className="mt-2 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <Cell label="Launch" value={detail.launchAt} />
          <Cell label="Picks close" value={detail.betCloseAt} />
          <Cell label="Match start" value={detail.matchStartAt} />
          <Cell label="Stops showing" value={detail.stopShowAt} />
        </dl>
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Rules
        </h2>
        {detail.rules.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--color-fg-muted)]">No rules.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {detail.rules.map((r, i) => (
              <li key={i} className="before:mr-2 before:content-['•']">
                {r}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Matches
        </h2>
        {matches.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
            No matches yet.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {matches.map((m) => {
              const settled = m.status === "done";
              return (
                <li
                  key={m.id}
                  className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-3"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                        {m.league || "—"} · {new Date(m.kickoffAt).toLocaleString()}
                      </div>
                      <div className="mt-1 text-sm font-medium">
                        {m.teamA}{" "}
                        <span className="text-[var(--color-fg-subtle)]">vs</span>{" "}
                        {m.teamB}
                      </div>
                    </div>
                    <span
                      className={
                        "shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] " +
                        (settled
                          ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                          : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)]")
                      }
                    >
                      {settled
                        ? `Final ${m.scoreA ?? "-"}–${m.scoreB ?? "-"}`
                        : m.status}
                    </span>
                  </div>
                  <div className="mt-3">
                    <ScoreEntryForm
                      competitionId={detail.id}
                      matchId={m.id}
                      teamA={m.teamA}
                      teamB={m.teamB}
                      initialScoreA={m.scoreA}
                      initialScoreB={m.scoreB}
                      alreadyScored={settled}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-3">
      <dt className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {label}
      </dt>
      <dd className="mt-1 text-xs">{new Date(value).toLocaleString()}</dd>
    </div>
  );
}
