import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";

interface FeedMessage {
  id: string;
  kind: string;
  routingKey: string | null;
  product: number | null;
  payloadXml: string;
  receivedAt: string;
}
interface MessagesResponse {
  messages: FeedMessage[];
  limit: number;
}

interface MatchResponse {
  match: {
    id: string;
    providerUrn: string;
    homeTeam: string;
    awayTeam: string;
    status: string;
    tournament: { id: number; name: string };
    sport: { slug: string; name: string };
  };
}

const KIND_OPTIONS = [
  { value: "", label: "all" },
  { value: "odds_change", label: "odds_change" },
  { value: "fixture_change", label: "fixture_change" },
  { value: "bet_stop", label: "bet_stop" },
  { value: "bet_settlement", label: "bet_settlement" },
  { value: "bet_cancel", label: "bet_cancel" },
  { value: "rollback_bet_settlement", label: "rollback_settlement" },
  { value: "rollback_bet_cancel", label: "rollback_cancel" },
] as const;

function productLabel(p: number | null): string {
  if (p === 1) return "pre";
  if (p === 2) return "live";
  return "—";
}

function kindTone(kind: string): string {
  if (kind === "odds_change") return "text-[var(--color-accent)]";
  if (kind.startsWith("rollback_")) return "text-[var(--color-negative)]";
  if (kind === "bet_cancel") return "text-[var(--color-negative)]";
  if (kind === "bet_settlement") return "text-[var(--color-positive)]";
  if (kind === "bet_stop") return "text-[#f5c77e]";
  return "text-[var(--color-fg-muted)]";
}

export default async function LogsMatchFeedPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ kind?: string; limit?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const kind = sp.kind && sp.kind !== "" ? sp.kind : undefined;
  const limit = Math.min(2000, Math.max(1, Number(sp.limit ?? 500) || 500));

  const qs = new URLSearchParams({ limit: String(limit) });
  if (kind) qs.set("kind", kind);

  const [matchData, feedData] = await Promise.all([
    serverApi<MatchResponse>(`/admin/logs/matches/${id}`),
    serverApi<MessagesResponse>(`/admin/logs/matches/${id}/feed?${qs.toString()}`),
  ]);
  if (!matchData) notFound();
  const messages = feedData?.messages ?? [];

  return (
    <div>
      <nav className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        <Link href="/admin/logs" className="hover:text-[var(--color-fg)]">
          Feed logs
        </Link>
        <span> / </span>
        <Link
          href={`/admin/logs/sports/${matchData.match.sport.slug}`}
          className="hover:text-[var(--color-fg)]"
        >
          {matchData.match.sport.name}
        </Link>
        <span> / </span>
        <Link
          href={`/admin/logs/tournaments/${matchData.match.tournament.id}`}
          className="hover:text-[var(--color-fg)]"
        >
          {matchData.match.tournament.name}
        </Link>
        <span> / </span>
        <Link
          href={`/admin/logs/matches/${matchData.match.id}`}
          className="hover:text-[var(--color-fg)]"
        >
          {matchData.match.homeTeam} vs {matchData.match.awayTeam}
        </Link>
      </nav>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Raw feed log</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Every AMQP message received for this match. Retained for 24h past
            scheduled start. Click a row to expand the XML payload.
          </p>
        </div>
      </div>

      <section className="mt-6 flex flex-wrap items-center gap-2 text-sm text-[var(--color-fg-muted)]">
        <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Kind
        </span>
        {KIND_OPTIONS.map((opt) => {
          const active = (kind ?? "") === opt.value;
          const url = opt.value
            ? `/admin/logs/matches/${id}/feed?kind=${opt.value}`
            : `/admin/logs/matches/${id}/feed`;
          return (
            <Link
              key={opt.value}
              href={url}
              className={
                "rounded-[8px] border px-3 py-1 font-mono text-xs " +
                (active
                  ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                  : "border-[var(--color-border-strong)] hover:text-[var(--color-fg)]")
              }
            >
              {opt.label}
            </Link>
          );
        })}
      </section>

      {messages.length === 0 ? (
        <p className="mt-8 text-sm text-[var(--color-fg-muted)]">
          No messages
          {kind ? (
            <>
              {" "}of kind{" "}
              <span className="font-mono text-[var(--color-fg)]">{kind}</span>
            </>
          ) : null}
          {" "}for this match.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
          {messages.map((m) => (
            <li key={m.id}>
              <details className="group">
                <summary className="flex cursor-pointer items-center justify-between gap-4 px-4 py-2.5 text-xs hover:bg-[var(--color-bg)]">
                  <div className="flex items-center gap-3 truncate">
                    <span
                      className={
                        "font-mono uppercase tracking-[0.12em] " + kindTone(m.kind)
                      }
                    >
                      {m.kind}
                    </span>
                    <span className="rounded-[6px] border border-[var(--color-border-strong)] px-1.5 py-0.5 font-mono text-[var(--color-fg-subtle)]">
                      {productLabel(m.product)}
                    </span>
                    {m.routingKey ? (
                      <span className="truncate font-mono text-[var(--color-fg-subtle)]">
                        {m.routingKey}
                      </span>
                    ) : null}
                  </div>
                  <time
                    dateTime={m.receivedAt}
                    className="whitespace-nowrap font-mono text-[var(--color-fg-muted)]"
                  >
                    {new Date(m.receivedAt).toLocaleString()}
                  </time>
                </summary>
                <pre className="overflow-x-auto border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-xs text-[var(--color-fg-muted)]">
                  {m.payloadXml}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-[var(--color-fg-subtle)]">
        {messages.length} of up to {limit} messages shown.
      </p>
    </div>
  );
}
