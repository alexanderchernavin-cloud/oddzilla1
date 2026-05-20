import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import { type ListMatch } from "@/components/match/match-row";
import {
  MatchListTabs,
  type ListMatchEnriched,
} from "@/components/match/match-list-tabs";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { LiveDot } from "@/components/ui/primitives";
import { ZillaFlashRow } from "@/components/lobby/zillaflash-row";
import { orderMatchesBySport, shortName } from "@/lib/sport-order";
import { getTranslations } from "@/lib/i18n/server";

interface ListMatchWithSport extends ListMatch {
  sport: { slug: string; name: string };
}

interface Response {
  matches: ListMatchWithSport[];
}

function enrich(m: ListMatchWithSport): ListMatchEnriched {
  return {
    ...m,
    _sportSlug: m.sport.slug,
    _sportShort: shortName(m.sport.name),
  };
}

interface PageProps {
  searchParams?: Promise<{ sport?: string | string[] }>;
}

export default async function LivePage({ searchParams }: PageProps) {
  const resolved = (await searchParams) ?? {};
  const rawSport = resolved.sport;
  const selectedSport =
    typeof rawSport === "string" && rawSport.length > 0 ? rawSport : null;

  const [data, tCommon, tSport] = await Promise.all([
    serverApi<Response>("/catalog/matches?status=live&limit=120"),
    getTranslations("common"),
    getTranslations("sport"),
  ]);
  const ordered = orderMatchesBySport(data?.matches ?? []);

  // Preserve insertion order from `ordered` so chips inherit the
  // CS2 -> Dota 2 -> LoL -> Valorant -> alphabetical ordering for free.
  const chipMap = new Map<string, { name: string; count: number }>();
  for (const m of ordered) {
    const existing = chipMap.get(m.sport.slug);
    if (existing) existing.count += 1;
    else chipMap.set(m.sport.slug, { name: m.sport.name, count: 1 });
  }
  const chipSports = Array.from(chipMap.entries()).map(([slug, v]) => ({
    slug,
    name: v.name,
    count: v.count,
  }));

  const visible = selectedSport
    ? ordered.filter((m) => m.sport.slug === selectedSport)
    : ordered;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 20,
        padding: "28px 32px 60px",
      }}
    >
      {chipSports.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Chip href="/live" label={tSport("all")} count={ordered.length} active={!selectedSport} />
          {chipSports.map((s) => (
            <Chip
              key={s.slug}
              href={`/live?sport=${s.slug}`}
              label={s.name}
              count={s.count}
              active={selectedSport === s.slug}
              sportSlug={s.slug}
            />
          ))}
        </div>
      )}

      {/* Live-only ZillaFlash boosts — the hook polls the same single
          /catalog/zillaflash endpoint as the lobby, but we filter to
          just the LIVE slots since prematch offers are out of context
          on a page that's specifically a live-status listing. */}
      <ZillaFlashRow kind="live" />

      {visible.length === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          {tSport("noMatches")}
        </p>
      ) : (
        // Page heading lives ON the match-list section-head row so it
        // shares a line with the cols toggle. MatchListTabs renders the
        // first labeled group's label on the left and the toggle on the
        // right via `.oz-match-list-section-head` (justify: space-between).
        <MatchListTabs
          matches={visible.map(enrich)}
          groups={[
            {
              key: "live",
              label: <LivePageHeading label={tCommon("live")} count={visible.length} />,
              matches: visible.map(enrich),
            },
          ]}
        />
      )}
    </div>
  );
}

// Page heading rendered inline with the MatchListTabs cols toggle on the
// section-head row. Visual mirror of the home lobby's LobbyTabLink — same
// 22-px label, same live-red count pill — but as plain text since we're
// already on /live (no navigation target).
function LivePageHeading({ label, count }: { label: string; count: number }) {
  return (
    <h1
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        margin: 0,
        fontSize: 22,
        fontWeight: 500,
        letterSpacing: "-0.015em",
        lineHeight: 1.1,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          color: "var(--fg-muted)",
        }}
        aria-hidden
      >
        <LiveDot size={9} />
      </span>
      {label}
      <span
        className="mono tnum"
        style={{
          display: "inline-flex",
          alignItems: "center",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--live)",
          border: "1px solid var(--live)",
          borderRadius: 999,
          padding: "2px 8px",
          lineHeight: 1.2,
        }}
      >
        {count}
      </span>
    </h1>
  );
}

function Chip({
  href,
  label,
  count,
  active,
  sportSlug,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
  sportSlug?: string;
}) {
  return (
    <Link
      href={href}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        height: 34,
        padding: "0 14px",
        background: active ? "var(--fg)" : "var(--surface)",
        border: `1px solid ${active ? "var(--fg)" : "var(--border)"}`,
        borderRadius: 999,
        textDecoration: "none",
        color: active ? "var(--bg)" : "var(--fg)",
        fontSize: 12.5,
        transition: "background 140ms var(--ease), color 140ms var(--ease)",
      }}
    >
      {sportSlug ? <SportGlyph sport={sportSlug} size={14} /> : null}
      {label}
      {count > 0 ? (
        <span
          className="mono tnum"
          style={{
            fontSize: 10.5,
            color: active ? "var(--bg)" : "var(--fg-dim)",
            opacity: active ? 0.75 : 1,
          }}
        >
          {count}
        </span>
      ) : null}
    </Link>
  );
}

