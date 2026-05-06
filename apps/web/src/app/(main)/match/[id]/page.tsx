import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { LiveMarkets, type MarketGroup, type MarketSnapshot } from "./live-markets";
import { Pill, LiveDot, TeamMark } from "@/components/ui/primitives";
import { TierMark } from "@/components/ui/tier-mark";
import { I } from "@/components/ui/icons";
import { type MatchStream } from "@/components/match/match-streams";
import { MatchLiveMedia } from "@/components/widgets/match-live-media";
import { MatchPrematchMobile } from "@/components/widgets/match-prematch-mobile";
import { MatchPageRegistrar } from "@/lib/match-page-context";
import {
  mapCellValue,
  type LiveScore,
  type LiveScorePeriod,
  type LiveScoreScoreboard,
} from "@/lib/live-score";

interface MatchResponse {
  match: {
    id: string;
    homeTeam: string;
    awayTeam: string;
    homeLogoUrl?: string | null;
    awayLogoUrl?: string | null;
    homeBrandColor?: string | null;
    awayBrandColor?: string | null;
    scheduledAt: string | null;
    status: "not_started" | "live" | "closed" | "cancelled" | "suspended";
    bestOf: number | null;
    liveScore: LiveScore | null;
    streams?: MatchStream[];
    tournament: { id: number; name: string; riskTier?: number | null };
    sport: { id: number; slug: string; name: string };
  };
  markets: MarketSnapshot[];
  marketGroups: MarketGroup[];
}

export default async function MatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await serverApi<MatchResponse>(`/catalog/matches/${id}`);
  if (!data) notFound();

  const { match, markets, marketGroups } = data;
  const streams = match.streams ?? [];
  const parentHost = await resolveEmbedHost();
  const isLive = match.status === "live";
  const liveScore = match.liveScore ?? null;
  const homeSeries = liveScore?.home ?? 0;
  const awaySeries = liveScore?.away ?? 0;

  const whenLabel = match.scheduledAt
    ? new Date(match.scheduledAt).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Time TBD";

  // The number of map columns in the scoreboard table. Prefer bestOf so
  // unplayed maps render as placeholders; fall back to the count of
  // periods we've seen so the table doesn't shrink to zero columns
  // pre-match for sports with no bestOf metadata.
  const periods = (liveScore?.periods ?? []).filter((p) => p.number != null);
  const periodCount = periods.length;
  const mapCount = Math.max(match.bestOf ?? 0, periodCount, 0);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 24,
        padding: "28px 32px 60px",
        maxWidth: 1000,
      }}
    >
      <Link
        href={`/sport/${match.sport.slug}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          alignSelf: "flex-start",
          color: "var(--fg-muted)",
          textDecoration: "none",
          fontSize: 12.5,
        }}
      >
        <span style={{ transform: "rotate(180deg)", display: "inline-flex" }}>
          <I.Arrow size={13} />
        </span>
        Back to {match.sport.name}
      </Link>

      <div
        className="card"
        style={{
          padding: "clamp(14px, 4vw, 24px)",
          borderRadius: "var(--r-lg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 18,
            flexWrap: "wrap",
          }}
        >
          {isLive ? (
            <Pill tone="live">
              <LiveDot size={6} /> LIVE
            </Pill>
          ) : (
            <Pill>Upcoming · {whenLabel}</Pill>
          )}
          {(match.tournament.riskTier === 1 || match.tournament.riskTier === 2) && (
            <TopPill />
          )}
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--fg-muted)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <TierMark tier={match.tournament.riskTier ?? null} size={11} />
            {match.tournament.name}
            {match.bestOf ? ` · BO${match.bestOf}` : ""}
          </span>
        </div>

        <Scoreboard
          homeTeam={match.homeTeam}
          awayTeam={match.awayTeam}
          homeLogoUrl={match.homeLogoUrl ?? null}
          awayLogoUrl={match.awayLogoUrl ?? null}
          homeSeries={homeSeries}
          awaySeries={awaySeries}
          mapCount={mapCount}
          liveScore={liveScore}
          isLive={isLive}
          sportSlug={match.sport.slug}
        />
      </div>

      <MatchLiveMedia
        matchId={String(match.id)}
        sportSlug={match.sport.slug}
        homeTeam={match.homeTeam}
        awayTeam={match.awayTeam}
        streams={streams}
        parentHost={parentHost}
        isLive={isLive}
      />

      <MatchPrematchMobile
        matchId={String(match.id)}
        sportSlug={match.sport.slug}
        homeTeam={match.homeTeam}
        awayTeam={match.awayTeam}
      />

      <MatchPageRegistrar
        matchId={String(match.id)}
        sportSlug={match.sport.slug}
        sportName={match.sport.name}
        homeTeam={match.homeTeam}
        awayTeam={match.awayTeam}
      />

      {markets.length === 0 ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          No markets from the feed yet. This page will update live when odds start
          flowing.
        </p>
      ) : (
        <LiveMarkets
          matchId={match.id}
          match={{
            id: match.id,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            sportSlug: match.sport.slug,
          }}
          initialGroups={marketGroups}
        />
      )}
    </div>
  );
}

// Twitch's iframe player only loads when its `parent=` query param matches
// the embedding hostname (any Host or X-Forwarded-Host header it sees from
// the browser). Reading from the same place Next.js does keeps prod
// (s.oddzilla.cc) and `pnpm dev` (localhost) working without env config.
async function resolveEmbedHost(): Promise<string | null> {
  const h = await headers();
  const raw = h.get("x-forwarded-host") ?? h.get("host");
  if (!raw) return null;
  const host = raw.split(":")[0]?.toLowerCase() ?? "";
  return host || null;
}

// TopPill renders a filled gold "TOP" chip in the match-detail header
// for any tournament Oddin marks risk_tier 1 or 2. Mono-uppercase to
// match the LIVE/Upcoming pills next to it.
function TopPill() {
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--accent-fg)",
        background: "var(--tier-gold)",
        border: "1px solid var(--tier-gold)",
      }}
      title="Top tournament"
    >
      Top
    </span>
  );
}

function teamTag(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w[0])
    .join("")
    .slice(0, 4);
}

// Cap the rendered length and append ".." (two dots) when a name is too
// long. Combines with CSS ellipsis below for narrow viewports.
function truncateName(name: string, max: number): string {
  if (name.length <= max) return name;
  return name.slice(0, max).trimEnd() + "..";
}

// Scoreboard renders a two-row table:
//   [team mark] [team name] | Score | 1 | 2 | … | N
// where Score is the series score (boxed) and the numeric columns are
// the per-map metric (rounds for CS2/Valorant, kills for Dota/LoL, etc.).
// The currently-live map column is highlighted; unplayed maps render
// dimmed dashes.
function Scoreboard({
  homeTeam,
  awayTeam,
  homeLogoUrl,
  awayLogoUrl,
  homeSeries,
  awaySeries,
  mapCount,
  liveScore,
  isLive,
  sportSlug,
}: {
  homeTeam: string;
  awayTeam: string;
  homeLogoUrl: string | null;
  awayLogoUrl: string | null;
  homeSeries: number;
  awaySeries: number;
  mapCount: number;
  liveScore: LiveScore | null;
  isLive: boolean;
  sportSlug: string;
}) {
  const periods = (liveScore?.periods ?? []).filter((p) => p.number != null);
  const periodByNumber = new Map<number, LiveScorePeriod>();
  for (const p of periods) periodByNumber.set(p.number ?? 0, p);

  const currentMap = isLive ? liveScore?.currentMap ?? null : null;
  const scoreboard = liveScore?.scoreboard ?? null;

  const cols = mapCount > 0 ? Array.from({ length: mapCount }, (_, i) => i + 1) : [];

  const extraRows =
    isLive && scoreboard ? extraScoreRows(scoreboard, sportSlug) : [];

  // Grid template: [team] [score] [map1] [map2] … [mapN]
  // Team column flexes; numeric columns are fixed-width and centered.
  // Bump per-map width when extras render so paired values like
  // "23k:28k" fit on the same row without crowding.
  const mapColWidth = extraRows.length > 0 ? "56px" : "44px";
  const gridTemplate = `minmax(0, 1fr) 60px${cols.length ? " " + cols.map(() => mapColWidth).join(" ") : ""}`;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        role="table"
        style={{
          display: "grid",
          gridTemplateColumns: gridTemplate,
          rowGap: 6,
          columnGap: 10,
          alignItems: "center",
        }}
      >
        {/* Header row */}
        <div role="row" style={{ display: "contents" }}>
          <div />
          <ColHeader label="Score" />
          {cols.map((n) => (
            <ColHeader
              key={n}
              label={String(n)}
              live={currentMap === n}
            />
          ))}
        </div>

        {/* Home row */}
        <TeamRow
          name={homeTeam}
          logoUrl={homeLogoUrl}
          series={homeSeries}
          cols={cols}
          getValue={(n) => mapCellValue("home", n, periodByNumber.get(n), scoreboard, currentMap, sportSlug)}
          isLiveCol={(n) => currentMap === n}
        />

        {/* Away row */}
        <TeamRow
          name={awayTeam}
          logoUrl={awayLogoUrl}
          series={awaySeries}
          cols={cols}
          getValue={(n) => mapCellValue("away", n, periodByNumber.get(n), scoreboard, currentMap, sportSlug)}
          isLiveCol={(n) => currentMap === n}
        />

        {/* Secondary stats (Towers, Gold for Dota/LoL). Same grid columns
            as the team rows so values line up under the live map column,
            but smaller + dimmer so kills stays the primary metric. */}
        {extraRows.map((row, i) => (
          <ExtraRow
            key={row.label}
            label={row.label}
            cols={cols}
            currentMap={currentMap}
            homeValue={row.homeValue}
            awayValue={row.awayValue}
            firstExtra={i === 0}
          />
        ))}
      </div>
    </div>
  );
}

function ColHeader({ label, live = false }: { label: string; live?: boolean }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 10.5,
        color: live ? "var(--fg)" : "var(--fg-dim)",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        textAlign: "center",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
      }}
    >
      {live ? <LiveDot size={5} /> : null}
      {label}
    </div>
  );
}

function TeamRow({
  name,
  logoUrl,
  series,
  cols,
  getValue,
  isLiveCol,
}: {
  name: string;
  logoUrl?: string | null;
  series: number;
  cols: number[];
  getValue: (n: number) => number | null;
  isLiveCol: (n: number) => boolean;
}) {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          minWidth: 0,
        }}
      >
        <TeamMark tag={teamTag(name)} size={28} logoUrl={logoUrl} name={name} />
        <span
          style={{
            fontWeight: 500,
            fontSize: 15,
            letterSpacing: "-0.01em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: 1,
          }}
        >
          {truncateName(name, 24)}
        </span>
      </div>

      <div
        className="mono tnum"
        style={{
          textAlign: "center",
          fontSize: 16,
          fontWeight: 500,
          color: "var(--fg)",
          padding: "6px 0",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-sm, 6px)",
          minWidth: 44,
        }}
      >
        {series}
      </div>

      {cols.map((n) => {
        const v = getValue(n);
        const live = isLiveCol(n);
        return (
          <div
            key={n}
            className="mono tnum"
            style={{
              textAlign: "center",
              fontSize: 15,
              fontWeight: 500,
              color: v == null ? "var(--fg-dim)" : live ? "var(--fg)" : "var(--fg-muted)",
            }}
          >
            {v == null ? "—" : v}
          </div>
        );
      })}
    </>
  );
}

// extraScoreRows returns one row per secondary metric (Towers/Turrets/Gold
// for Dota & LoL). Kills is intentionally omitted — it's already rendered
// as the primary per-map cell in the team rows above. Returns [] for
// games where the team-row cell already shows the most useful stat
// (rounds for CS2 / Valorant), so no extras render at all.
function extraScoreRows(
  sb: LiveScoreScoreboard,
  sportSlug: string,
): { label: string; homeValue: string; awayValue: string }[] {
  const slug = sportSlug.toLowerCase();
  const out: { label: string; homeValue: string; awayValue: string }[] = [];

  const isDotaLikeSlug =
    slug === "dota2" ||
    slug === "dota" ||
    slug === "lol" ||
    slug === "leagueoflegends" ||
    slug === "league-of-legends";

  if (!isDotaLikeSlug) return out;

  if (sb.homeDestroyedTowers != null && sb.awayDestroyedTowers != null) {
    out.push({
      label: "Towers",
      homeValue: String(sb.homeDestroyedTowers),
      awayValue: String(sb.awayDestroyedTowers),
    });
  }
  if (sb.homeDestroyedTurrets != null && sb.awayDestroyedTurrets != null) {
    out.push({
      label: "Turrets",
      homeValue: String(sb.homeDestroyedTurrets),
      awayValue: String(sb.awayDestroyedTurrets),
    });
  }
  if (sb.homeGold != null && sb.awayGold != null) {
    out.push({
      label: "Gold",
      homeValue: formatGold(sb.homeGold),
      awayValue: formatGold(sb.awayGold),
    });
  }

  return out;
}

// ExtraRow renders one secondary-stat row across the same grid columns
// as the team rows. The label sits in the team-name column (right-aligned
// to visually pair with the team-mark column), the score column stays
// empty, and only the live map cell carries a value (e.g. "0:4" or
// "23k:28k"). All cells are dimmer + smaller than the team rows so the
// kills score remains the primary read.
function ExtraRow({
  label,
  cols,
  currentMap,
  homeValue,
  awayValue,
  firstExtra,
}: {
  label: string;
  cols: number[];
  currentMap: number | null;
  homeValue: string;
  awayValue: string;
  firstExtra: boolean;
}) {
  const topPad = firstExtra ? 6 : 0;
  return (
    <>
      <div
        className="mono"
        style={{
          fontSize: 10.5,
          color: "var(--fg-dim)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          textAlign: "right",
          paddingTop: topPad,
        }}
      >
        {label}
      </div>
      <div style={{ paddingTop: topPad }} />
      {cols.map((n) => {
        const live = currentMap === n;
        return (
          <div
            key={n}
            className="mono tnum"
            style={{
              textAlign: "center",
              fontSize: 11,
              fontWeight: 400,
              color: "var(--fg-dim)",
              paddingTop: topPad,
            }}
          >
            {live ? `${homeValue}:${awayValue}` : ""}
          </div>
        );
      })}
    </>
  );
}

function formatGold(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}
