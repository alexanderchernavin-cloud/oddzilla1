import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { MatchRow, type ListMatch } from "@/components/match/match-row";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { I } from "@/components/ui/icons";

interface SportResponse {
  sport: { id: number; slug: string; name: string };
  matches: ListMatch[];
}

export default async function SportPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tournament?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const tournamentId = sp.tournament && /^\d+$/.test(sp.tournament) ? sp.tournament : null;
  const qs = new URLSearchParams({ limit: "100" });
  if (tournamentId) qs.set("tournament", tournamentId);
  const data = await serverApi<SportResponse>(
    `/catalog/sports/${slug}?${qs.toString()}`,
  );
  if (!data) notFound();

  const filteredTournamentName = tournamentId
    ? data.matches.find((m) => String(m.tournament.id) === tournamentId)?.tournament.name ?? null
    : null;

  const live = data.matches.filter((m) => m.status === "live");
  const upcoming = data.matches.filter((m) => m.status !== "live");
  const sportShort = shortName(data.sport.name);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 20,
        padding: "28px 32px 60px",
        maxWidth: 1100,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <SportGlyph sport={slug} size={28} />
        </div>
        <div>
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--fg-dim)",
            }}
          >
            Sport
          </div>
          <h1
            className="display"
            style={{
              margin: 0,
              fontSize: 32,
              fontWeight: 500,
              letterSpacing: "-0.02em",
            }}
          >
            {data.sport.name}
          </h1>
        </div>
        <div style={{ flex: 1 }} />
        <div className="mono tnum" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          {data.matches.length} {data.matches.length === 1 ? "match" : "matches"}
        </div>
      </header>

      {tournamentId && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            alignSelf: "flex-start",
            gap: 8,
            padding: "6px 6px 6px 12px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 999,
            fontSize: 12.5,
            color: "var(--fg)",
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--fg-dim)",
            }}
          >
            Tournament
          </span>
          <span>{filteredTournamentName ?? "Filtered"}</span>
          <Link
            href={`/sport/${slug}`}
            aria-label="Clear tournament filter"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              borderRadius: 999,
              color: "var(--fg-muted)",
              textDecoration: "none",
            }}
          >
            <I.Close size={13} />
          </Link>
        </div>
      )}

      {live.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--fg-dim)",
              fontWeight: 600,
            }}
          >
            Live · {live.length}
          </div>
          {live.map((m) => (
            <MatchRow key={m.id} match={m} sportSlug={slug} sportShort={sportShort} />
          ))}
        </section>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div
          className="mono"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
            fontWeight: 600,
          }}
        >
          Upcoming · {upcoming.length}
        </div>
        {upcoming.length === 0 ? (
          <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
            No upcoming matches scheduled.
          </p>
        ) : (
          upcoming.map((m) => (
            <MatchRow key={m.id} match={m} sportSlug={slug} sportShort={sportShort} />
          ))
        )}
      </section>
    </div>
  );
}

function shortName(name: string): string {
  if (name === "Counter-Strike 2") return "CS2";
  if (name === "League of Legends") return "LoL";
  if (name === "Dota 2") return "Dota 2";
  if (name === "Rocket League") return "RL";
  return name;
}
