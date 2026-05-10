// "Wedged matches" admin page. Matches that should have started by now
// but are still sitting at `not_started` in the DB with active markets.
// Almost always the result of Oddin going silent on the match around
// kickoff during a service outage; the AMQP recovery replay didn't carry
// the live transition or the close, so the row stayed stuck. Mostly
// auto-cleared now by the suspend-before-recover flush on every AMQP
// reconnect (services/feed-ingester/cmd/feed-ingester/main.go), but
// this page exists as the manual operator tool for whatever slipped
// through.
//
// Each row exposes a "Refresh from REST" button that fires
// `pg_notify('fixture_refresh', urn)`; the feed-ingester re-fetches the
// fixture from Oddin's REST endpoint and applies the fixture body's
// `status` attribute, which carries Oddin's authoritative current
// state. The "Refresh all" button does the same for every wedged row in
// one click — feed-ingester's per-URN 5 min cooldown absorbs the burst.

import { serverApi } from "@/lib/server-fetch";
import { RefreshOne, WedgedMatchesActions } from "./actions";

interface WedgedMatch {
  matchId: string;
  providerUrn: string | null;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string;
  sportSlug: string;
  sportName: string;
  tournamentName: string;
  activeMarkets: number;
  lastFeedMessageAt: string | null;
  lastFeedMessageKind: string | null;
  lastFeedMessageRoutingKey: string | null;
}

interface ListResponse {
  matches: WedgedMatch[];
}

export const metadata = {
  title: "Wedged matches — Oddzilla Admin",
};

// Always SSR-fresh — operators come here when they suspect bad state,
// caching would defeat the point.
export const dynamic = "force-dynamic";

export default async function WedgedMatchesPage() {
  const data = await serverApi<ListResponse>("/admin/wedged-matches");
  const matches = data?.matches ?? [];

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Wedged matches</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">
            Matches still at <code className="font-mono">not_started</code> more than
            1 h past their scheduled start, with active markets the storefront
            could otherwise show. Almost always Oddin went silent on the match
            around kickoff during a service outage on our side. Use{" "}
            <strong>Refresh from REST</strong> to re-fetch the fixture and let
            the feed-ingester apply Oddin&apos;s authoritative status.
          </p>
        </div>
        <WedgedMatchesActions count={matches.length} />
      </div>

      {matches.length === 0 ? (
        <p className="mt-8 text-sm text-[var(--color-fg-muted)]">
          No wedged matches. Catalog is clean.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
              <tr>
                <Th>Match</Th>
                <Th>Sport · Tournament</Th>
                <Th>Scheduled</Th>
                <Th>Last feed message</Th>
                <Th className="text-right">Active markets</Th>
                <Th className="text-right">Action</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {matches.map((m) => (
                <MatchRow key={m.matchId} match={m} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MatchRow({ match }: { match: WedgedMatch }) {
  const scheduled = new Date(match.scheduledAt);
  const ageHours = Math.max(0, (Date.now() - scheduled.getTime()) / 3_600_000);
  const lastMsg = match.lastFeedMessageAt
    ? new Date(match.lastFeedMessageAt)
    : null;
  const lastMsgAgeMin = lastMsg
    ? Math.max(0, (Date.now() - lastMsg.getTime()) / 60_000)
    : null;
  // Surface the producer (pre / live) from the routing key prefix —
  // "hi.pre" never having flipped to "hi.live" is a useful tell that
  // Oddin never started streaming live odds for this fixture.
  const producer = match.lastFeedMessageRoutingKey
    ? match.lastFeedMessageRoutingKey.split(".")[1] ?? "—"
    : "—";

  return (
    <tr className="align-top">
      <Td>
        <div className="font-medium">
          {match.homeTeam} <span className="text-[var(--color-fg-subtle)]">vs</span>{" "}
          {match.awayTeam}
        </div>
        <div className="mt-1 font-mono text-[11px] text-[var(--color-fg-subtle)]">
          id {match.matchId}
          {match.providerUrn ? ` · ${match.providerUrn}` : ""}
        </div>
      </Td>
      <Td>
        <div>{match.sportName}</div>
        <div className="text-[12px] text-[var(--color-fg-muted)]">
          {match.tournamentName}
        </div>
      </Td>
      <Td>
        <time dateTime={match.scheduledAt} className="whitespace-nowrap">
          {scheduled.toLocaleString()}
        </time>
        <div className="text-[12px] text-[var(--color-fg-subtle)]">
          {ageHours.toFixed(1)} h ago
        </div>
      </Td>
      <Td>
        {lastMsg ? (
          <>
            <time dateTime={lastMsg.toISOString()} className="whitespace-nowrap">
              {lastMsg.toLocaleString()}
            </time>
            <div className="text-[12px] text-[var(--color-fg-subtle)]">
              {match.lastFeedMessageKind ?? "—"} ·{" "}
              <span className="font-mono">{producer}</span>
              {lastMsgAgeMin != null ? (
                <>
                  {" · "}
                  {lastMsgAgeMin < 60
                    ? `${lastMsgAgeMin.toFixed(0)}m ago`
                    : `${(lastMsgAgeMin / 60).toFixed(1)}h ago`}
                </>
              ) : null}
            </div>
          </>
        ) : (
          <span className="text-[var(--color-fg-subtle)]">never</span>
        )}
      </Td>
      <Td className="text-right font-mono">{match.activeMarkets}</Td>
      <Td className="text-right">
        <RefreshOne matchId={match.matchId} disabled={!match.providerUrn} />
      </Td>
    </tr>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`px-4 py-2 font-medium ${className ?? ""}`}>{children}</th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 ${className ?? ""}`}>{children}</td>;
}
