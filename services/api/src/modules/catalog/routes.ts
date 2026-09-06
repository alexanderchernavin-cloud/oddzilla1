// /catalog endpoints. Read-only; serves the SSR catalog pages, the
// match-details panel, the top-bar global search, and the sidebar
// tournament sub-tree. Public (no auth required).
//
// Routes:
//   GET  /catalog/sports                          active sports
//   GET  /catalog/sports/:slug                    sport + matches (?tournament=N | ?team=N filter)
//   GET  /catalog/sports/:slug/tournaments        tournaments under a sport + live counts
//   GET  /catalog/matches                         cross-sport list (live | upcoming)
//   GET  /catalog/matches/:id                     match + tournament/sport + markets
//   GET  /catalog/tournaments/:id/sportradar     SR reference for a tournament (Live Table)
//   GET  /catalog/search                          global search (sports/tournaments/teams/matches)
//   GET  /catalog/live-counts                     live match counts per sport

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, gte, ilike, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  sports,
  categories,
  tournaments,
  competitors,
  matches,
  markets,
  marketOutcomes,
  marketDescriptions,
  outcomeDescriptions,
  competitorProfiles,
  playerProfiles,
  feMarketDisplayOrder,
  feMarketGroups,
  isCustomScope,
  combiBoostConfig,
  matchSportradarIds,
} from "@oddzilla/db";
import { NotFoundError } from "../../lib/errors.js";
import { cached, cachedSwr } from "../../lib/cache.js";
import {
  applyFeedTabMembership,
  resolveGroupRows,
} from "../../lib/market-groups.js";
import {
  loadBoostRulesForMatches,
  loadViewerRiskScore,
  toQuoteRule,
  type BatchedMatchBoosts,
  type MatchBoostContext,
} from "../../lib/boosted-odds.js";
import {
  quoteMarketBoost,
  type BoostQuoteCell,
  type BoostQuoteRule,
} from "@oddzilla/types";
import {
  loadPromoVisibilityCascades,
  resolveVisible,
} from "../../lib/bettor-promo-visibility.js";
import {
  substituteTemplate,
  renderOutcomeLabel,
  deriveMarketScope,
  outcomeSortWeight,
  type OutcomeProfiles,
} from "../../lib/market-naming.js";
import {
  loadBettorAdjustmentCascade,
  resolveBettorAdjustmentBp,
  applyBettorAdjustment,
  EMPTY_CASCADE,
  type BettorAdjustmentCascade,
} from "../../lib/bettor-odds-adjustment.js";

// Mirror of the storefront's i18n config — kept tiny + duplicated here
// so the API doesn't import the web bundle. If we ship a new locale
// the list updates in both places. Anything not in the list (or
// missing entirely) resolves to 'en'.
const SUPPORTED_LOCALES = new Set(["en", "cs", "pt", "ru", "es", "hr"]);
const LOCALE_COOKIE = "oz_locale";

function resolveLocale(cookies: Record<string, string | undefined>): string {
  const raw = cookies[LOCALE_COOKIE];
  if (raw && SUPPORTED_LOCALES.has(raw)) return raw;
  return "en";
}

// Deduplicate a list of strings preserving order. Used to build the
// `language IN (locale, 'en')` filter — when locale === 'en' the
// resulting array is just ['en'] instead of ['en', 'en'].
function uniq<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

// ── Catalog cache keys (v1 suffix lets us roll a shape change forward
// without flushing). TTLs are tuned to the surface's mutation cadence:
//   • /catalog/sports — mutates monthly at most (admin curation),
//     invalidated explicitly on admin sport writes; 60s is the
//     belt-and-braces eventual-consistency guarantee.
//   • /catalog/live-counts — derived from match status (live vs
//     scheduled), churns continuously during a busy slate; 5s absorbs
//     burst traffic from the layout render without visible staleness.
const SPORTS_CACHE_KEY = "catalog:sports:v1";
const SPORTS_CACHE_TTL_SECONDS = 60;
const LIVE_COUNTS_CACHE_KEY = "catalog:live-counts:v1";
const LIVE_COUNTS_CACHE_TTL_SECONDS = 5;
// Anonymous-only response cache for the three hottest catalog endpoints
// (sport list, cross-sport list, match detail). Signed-out responses are
// identical for every viewer; authed requests bypass because the
// per-bettor odds adjustment personalises prices. 3 s is short enough
// that list staleness is invisible next to the WS live-odds reconcile,
// while collapsing the 3 SSR replicas' render fan-out (plus client
// refetches) to roughly one DB build per key per window.
const ANON_LIST_CACHE_TTL_SECONDS = 3;

// Two aliases of `competitors` so a single match query can pull the home
// and away team's branding columns (logo_url, brand_color) in one round
// trip. LEFT JOIN: a match may have NULL competitor FKs (placeholder team
// names from the feed before the auto-mapper resolved a URN).
const homeCompetitor = alias(competitors, "home_competitor");
const awayCompetitor = alias(competitors, "away_competitor");

// Oddin specifier names that act as "lines" — i.e. each value produces
// a separate market row on the feed, but users see them as one market
// with many thresholds to choose from (Totals, Handicaps, …).
const LINE_SPECIFIERS = ["threshold", "handicap"] as const;
type LineSpec = (typeof LINE_SPECIFIERS)[number];

// provider_market_id namespace of the Fonbet KZ feed
// (services/fonbet-ingester, docs/FONBET.md): 1_000_000 + Fonbet table
// number. Oddin ids stay far below this. Fonbet's match-winner tables are
// the only Fonbet markets whose outcome ids are the canonical "1" / "2" /
// "3" — every other Fonbet outcome id is a numeric factor id >= 100.
const FONBET_PMID_BASE = 1_000_000;

// lineInfo returns the line-specifier present on the market (if any)
// plus a grouping key that collapses markets that differ only in their
// line value. Markets with no line specifier get lineKey=null and the
// client renders them as a single card.
function lineInfo(
  providerMarketId: number,
  variant: string,
  specs: Record<string, string>,
): { lineKey: string | null; lineSpec: LineSpec | null; lineValue: string | null } {
  for (const key of LINE_SPECIFIERS) {
    const v = specs[key];
    if (v == null || v === "") continue;
    // Collapse key = (market, variant, all other specifiers sorted). The
    // `variant` inner specifier is already part of Oddin's canonical
    // specifier set, so we just drop the line specifier before hashing.
    const rest = Object.entries(specs)
      .filter(([k]) => k !== key)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, val]) => `${k}=${val}`)
      .join("|");
    return {
      lineKey: `${providerMarketId}|${variant}|${rest}|line=${key}`,
      lineSpec: key,
      lineValue: v,
    };
  }
  return { lineKey: null, lineSpec: null, lineValue: null };
}

// stripLinePlaceholder removes the `{threshold}` / `{handicap}` token
// from a name template so the card header reads as a generic market
// name ("Total kills - map 1") while each row carries the line value.
function stripLinePlaceholder(template: string, lineSpec: LineSpec): string {
  const pattern = new RegExp(`\\{${lineSpec}\\}`, "g");
  return template.replace(pattern, "").replace(/\s{2,}/g, " ").trim();
}

// Oddin's English outcome templates use the literal tokens "home",
// "away" and "draw" to mark the team-side outcomes of two/three-way team
// markets (match winner, map winner, handicap, …). Detect the side from
// the English template so the caller can substitute the actual team name
// in every locale — the localized templates render generic words
// ("хозяева"/"гости") that no longer identify which team the outcome is.
function homeAwaySideFromTemplate(
  template: string | undefined,
): "home" | "away" | "draw" | null {
  if (!template) return null;
  const s = template.trim().toLowerCase();
  if (s === "home") return "home";
  if (s === "away") return "away";
  if (s === "draw") return "draw";
  return null;
}

const matchListQuery = z.object({
  live: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  tournament: z.coerce.number().int().positive().optional(),
  team: z.coerce.number().int().positive().optional(),
  // Narrows the list to one category, and is the only way to see a
  // category flagged `hidden_from_lists` (migration 0102). The sidebar's
  // category header links here.
  category: z.coerce.number().int().positive().optional(),
});

// Postgres returns NUMERIC(10,4) as "3.1400" or "1.0030" with trailing
// zeros padded to scale. Floor-truncate to 4dp (with an epsilon nudge to
// absorb float64 round-down artefacts) and trim trailing zeros down to
// a 2dp minimum so a 1.50 quote stays "1.50" while a 1.003 quote keeps
// its third decimal. Matches odds-publisher's formatPublishedOdds shape
// byte-for-byte.
function formatOdds(s: string | null | undefined): string | null {
  if (s == null) return null;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  const units = Math.floor(n * 10000 + 1e-6);
  if (units < 0) return null;
  const intP = Math.floor(units / 10000);
  const frac = units % 10000;
  const padded = `${intP}.${frac.toString().padStart(4, "0")}`;
  return padded.replace(/(\.\d{2})(\d*?)0+$/, "$1$2");
}

// Stream embed helper. matches.tv_channels is a JSONB array of
// `{ name, language, streamUrl }` (see migration 0022 + the
// feed-ingester resolver). The frontend embeds Twitch, YouTube, Kick
// and Gjirafa; anything else falls back to a single card pointing at
// the source URL. We classify here so the Next.js page can stay dumb
// — and so a future admin override (e.g. blocking a misbehaving
// channel) has one place to land.
type StreamSource = {
  platform: "twitch" | "youtube" | "kick" | "gjirafa" | "vpplayer" | "other";
  // For Twitch / Kick: the channel slug (`esl_csgo`, `xqc`).
  // For YouTube: the video id (`abc123XYZ`).
  // For Gjirafa: the page slug (`gjirafa50-masters-league-...`).
  // For vpplayer: always null — that URL is already the player page and
  // gets used verbatim as the iframe src.
  // null for `other` and for malformed URLs — caller falls back to
  // the original URL.
  embedId: string | null;
  url: string;
  name: string | null;
  language: string | null;
};

function parseMatchStreams(raw: unknown): StreamSource[] {
  if (!Array.isArray(raw)) return [];
  const out: StreamSource[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const url = typeof e.streamUrl === "string" ? e.streamUrl.trim() : "";
    if (!url) continue;
    const classified = classifyStreamUrl(url);
    // classified === null means the URL had a non-http(s) scheme (e.g.
    // `javascript:`) or was unparseable. Drop the entry entirely so the
    // storefront never rendered a malicious anchor — the Oddin feed is
    // a semi-trusted source and we strip dangerous schemes at the API
    // boundary rather than the React layer.
    if (classified === null) continue;
    const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : null;
    const language =
      typeof e.language === "string" && e.language.trim() ? e.language.trim() : null;
    out.push({ ...classified, url, name, language });
  }
  return out;
}

function classifyStreamUrl(
  url: string,
): Pick<StreamSource, "platform" | "embedId"> | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Hard scheme allow-list. `javascript:`, `data:`, `vbscript:`, `file:`,
  // `mailto:` and friends all parse as valid URLs but executing them
  // server-side or rendering them as anchors is a stored-XSS surface
  // when the source (Oddin AMQP feed) is semi-trusted.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "twitch.tv" || host === "player.twitch.tv" || host === "m.twitch.tv") {
    // https://www.twitch.tv/<channel> | https://player.twitch.tv/?channel=<channel>
    const channelParam = parsed.searchParams.get("channel");
    if (channelParam && /^[a-zA-Z0-9_]+$/.test(channelParam)) {
      return { platform: "twitch", embedId: channelParam.toLowerCase() };
    }
    const seg = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    if (seg && /^[a-zA-Z0-9_]+$/.test(seg)) {
      return { platform: "twitch", embedId: seg.toLowerCase() };
    }
    return { platform: "twitch", embedId: null };
  }
  if (
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "youtube-nocookie.com" ||
    host === "youtu.be"
  ) {
    // https://www.youtube.com/watch?v=ID | https://youtu.be/ID |
    // https://www.youtube.com/live/ID | https://www.youtube.com/embed/ID
    let videoId: string | null = null;
    if (host === "youtu.be") {
      videoId = parsed.pathname.split("/").filter(Boolean)[0] ?? null;
    } else {
      const v = parsed.searchParams.get("v");
      if (v) {
        videoId = v;
      } else {
        const segs = parsed.pathname.split("/").filter(Boolean);
        if (segs.length >= 2 && (segs[0] === "live" || segs[0] === "embed" || segs[0] === "shorts")) {
          videoId = segs[1] ?? null;
        }
      }
    }
    if (videoId && /^[a-zA-Z0-9_-]{6,}$/.test(videoId)) {
      return { platform: "youtube", embedId: videoId };
    }
    return { platform: "youtube", embedId: null };
  }
  if (host === "kick.com" || host === "m.kick.com" || host === "player.kick.com") {
    // https://kick.com/<channel> | https://player.kick.com/<channel>
    // Kick channel slugs allow lowercase letters, digits, underscore
    // and hyphen; length 3..25 in practice. Embed URL is
    // https://player.kick.com/<channel>.
    const seg = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    if (seg && /^[a-zA-Z0-9_-]{2,25}$/.test(seg)) {
      return { platform: "kick", embedId: seg.toLowerCase() };
    }
    return { platform: "kick", embedId: null };
  }
  if (host === "video.gjirafa.com") {
    // Page: https://video.gjirafa.com/<slug>
    // Embed: https://video.gjirafa.com/embed/<slug>
    // Some feeds may already point at the /embed/ form — strip the
    // prefix so we don't double-embed.
    const segs = parsed.pathname.split("/").filter(Boolean);
    const slug = segs[0] === "embed" ? segs[1] ?? "" : segs[0] ?? "";
    if (slug && /^[a-z0-9-]{2,120}$/i.test(slug)) {
      return { platform: "gjirafa", embedId: slug.toLowerCase() };
    }
    return { platform: "gjirafa", embedId: null };
  }
  if (host === "host.vpplayer.tech") {
    // Gjirafa's white-label player host. Oddin labels these channels
    // "Gjirafa" but the URL is not video.gjirafa.com, so the branch above
    // never matched them and they fell through to `other` — visible in the
    // payload but never embedded (observed 2026-08-31 on eFootball, where
    // it was one of three advertised sources).
    //
    // Unlike the others there is nothing to build: the URL already IS the
    // player page (`/player/<account>/<video>.html`), so embedId stays null
    // and the frontend uses `url` verbatim. The path is still shape-checked
    // — this value ends up as an iframe `src`, and the feed is only
    // semi-trusted.
    if (/^\/player\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\.html$/.test(parsed.pathname)) {
      return { platform: "vpplayer", embedId: null };
    }
    return { platform: "other", embedId: null };
  }
  return { platform: "other", embedId: null };
}

// Has-active-market guard. Every list/count endpoint runs this so we
// skip matches with zero active markets — there's nothing to bet on,
// the card would render empty. Intentionally lenient: a real live
// match can have its match-winner briefly suspended (mid-round, post-
// goal in football) while secondary markets stay open, and we still
// want the row visible.
//
// Defense in depth on the storefront side. Two clauses:
//
//   1. matches.status IN ('not_started','live') — closed/cancelled
//      matches drop out even if a stray market row stayed at status=1
//      (settlement only flips markets it touches; an untouched market
//      on a closed event would otherwise keep the card visible).
//
//   2. A 6 h time gate on `not_started`: if Oddin never delivered the
//      lifecycle transition (e.g. our service was down for hours and
//      the message fell outside the recovery window), the row stays
//      stuck at `not_started` past its scheduled start. A match
//      scheduled > 6 h ago that hasn't moved to `live` is broken data —
//      live esports rounds don't run that long. Hides it from listings
//      until the suspend-before-recover flush or the admin
//      "Refresh from REST" tool repairs the row. Live matches don't
//      need the gate (by definition the lifecycle DID advance).
const hasActiveMarket = sql`EXISTS (
  SELECT 1 FROM markets mk
   WHERE mk.match_id = ${matches.id}
     AND mk.status = 1
) AND (
  ${matches.status} = 'live'
  OR (${matches.status} = 'not_started'
      AND ${matches.scheduledAt} > NOW() - INTERVAL '6 hours')
)`;

// Tournaments whose name matches one of these strings are hidden from
// every list/count endpoint. Oddin's integration broker exposes test
// tournaments (e.g. "Integration testing" with bot teams "Integration
// testing 1/2") that are useful for protocol verification but never
// belong on the storefront. Match by exact name — these strings are
// stable Oddin constants. The `/catalog/matches/:id` detail route
// intentionally does not filter by this list: hidden tournaments are
// unreachable through the UI anyway, and a deep link should still
// resolve so admin/debug tooling keeps working.
const HIDDEN_TOURNAMENT_NAMES = ["Integration testing"];
const notHiddenTournament = notInArray(tournaments.name, HIDDEN_TOURNAMENT_NAMES);

// Categories an operator has flagged as list-excluded (migration 0102).
// Fonbet files EA FC simulations under the real Football sport, so 10 of
// Football's 23 live matches — and 184 of its upcoming ones — were
// computer-played 2x4-minute games crowding out the actual football offer
// (measured on production 2026-09-04). The flag removes them from every
// list a bettor gets WITHOUT asking — the lobby, /live, /upcoming, the
// sport page default view, and the per-sport live badge that labels them.
//
// It is NOT a hidden-tournament-style blackout: the sidebar tree still
// carries the category, and any EXPLICIT narrowing (?category=, ?tournament=
// or ?team=) drops this predicate so the offer is one click away. That is
// the whole distinction — HIDDEN_TOURNAMENT_NAMES hides rows that should
// never be reachable, this one hides rows that shouldn't be the default.
const notHiddenCategory = eq(categories.hiddenFromLists, false);

/**
 * How long before kickoff a top-tier match starts competing with the live
 * offer for the top of the list.
 */
const FEATURED_PREMATCH_WINDOW = "12 hours";

/**
 * The tiers prominent enough to outrank a live match before they start.
 * Deliberately narrower than `isFeaturedTier` on the storefront: a gold
 * star is decoration, displacing live football is a merchandising claim.
 */
const HOISTABLE_TIERS = [1, 2];

/**
 * Storefront match ordering: prominence first, then time.
 *
 * The lists used to sort live-before-upcoming and then purely by kickoff,
 * which on a broad line means whatever happens to have started. On
 * production that put `Venezuela. Division 2` and `Brazil. Women. Series
 * A1` at the top of Football's live list while the tier-3 leagues sat
 * below the fold — the ordering carried no notion of which match anyone
 * wants to see.
 *
 * Two rules, both the operator's:
 *
 *   1. Among matches competing for the top, LOWER risk tier ranks higher.
 *      The tier is already our best statement of how big a competition is,
 *      so it is the right sort key, and it now exists for the traditional
 *      line as well as esports (ZillaAGI, migration 0106).
 *   2. A tier 1 or 2 match joins that competition 12 HOURS BEFORE KICKOFF,
 *      so an upcoming Champions League tie outranks a live tier-6 game.
 *
 * Everything else keeps chronological order — a "what's on soon" list
 * sorted by prestige rather than time would be actively worse — with tier
 * only breaking ties. Untiered rows sort as 99: last within their group,
 * never promoted by the absence of information.
 */
function matchListOrder(): SQL[] {
  const hoisted = sql`(
    ${matches.status} = 'live'
    OR (
      ${tournaments.riskTier} IN (${sql.join(
        HOISTABLE_TIERS.map((t) => sql`${t}`),
        sql`, `,
      )})
      AND ${matches.scheduledAt} IS NOT NULL
      AND ${matches.scheduledAt} <= now() + ${FEATURED_PREMATCH_WINDOW}::interval
    )
  )`;
  return [
    sql`CASE WHEN ${hoisted} THEN 0 ELSE 1 END ASC`,
    sql`CASE WHEN ${hoisted} THEN COALESCE(${tournaments.riskTier}, 99) ELSE 99 END ASC`,
    sql`${matches.scheduledAt} ASC NULLS LAST`,
    // Deterministic tail so paging and repeated polls cannot reshuffle
    // rows that tie on every key above.
    sql`${matches.id} ASC`,
  ];
}

// loadMatchWinnerOdds fetches the match-winner outcomes for a batch of
// matches and pairs them by Oddin's canonical outcome_id ("1" = home,
// "2" = away, "3" = draw). Used by both the per-sport and cross-sport
// list endpoints to render inline odds on list cards without an extra
// round trip per row.
//
// Both 2-way and 3-way variants are accepted. Some formats (BO2 series
// in Dota 2 / LoL, soccer-style sports like eFootball) emit a 1X2
// market because a draw is a real outcome; in that case the storefront
// list card grows a third "Draw" row between home and away. Matches
// missing either home or away outcome are skipped (the storefront falls
// back to no inline price).
//
// When Oddin somehow emits both 2-way and 3-way variants for the same
// match (rare but defensible), the 3-way wins so the draw stays
// discoverable. Pairing is scoped to a single market row so home / away
// / draw prices always come from the same market — a 2-way home price
// next to a 3-way away price would mismatch overround.
interface MatchWinnerPair {
  homeMarketId: string;
  homeOutcomeId: string;
  homePrice: string | null;
  homeProbability: string | null;
  awayMarketId: string;
  awayOutcomeId: string;
  awayPrice: string | null;
  awayProbability: string | null;
  drawOutcomeId: string | null;
  drawPrice: string | null;
  drawProbability: string | null;
  /**
   * The chosen market's FULL active+priced outcome set, raw published
   * odds. ZillaBoost's key math needs the whole book (it shaves the
   * market's key, so a two-way boost derived from only one side would be
   * wrong), and the boost is computed from the RAW price — matching
   * validateCustomBoostForBet, so the price on the card is exactly the
   * price placement will re-derive. Boosted legs bypass the per-bettor
   * odds adjustment at placement too, so skipping it here is consistent.
   */
  boostOutcomes: Array<{ outcomeId: string; publishedOdds: number }>;
}

/**
 * ZillaBoost the inline match-winner row of a list card.
 *
 * The match-detail page recomputes boosts client-side from live WS ticks;
 * a list card has no per-outcome WS subscription and is server-rendered,
 * so the list prices its one market here instead. Returns the boosted
 * cells keyed by outcomeId, or null when nothing applies (no rule, the
 * fair-book clamp swallowed the boost, or the price didn't move at
 * display precision).
 */
interface MatchWinnerBoostQuote {
  /** Boosted cells for the CURRENT server-side prices (SSR render). */
  cells: Map<string, BoostQuoteCell>;
  /** Resolved market-wide rule, for the client's per-tick re-price. */
  marketWide: BoostQuoteRule | null;
  /** Resolved outcome-scope rules, keyed by outcomeId. */
  selections: Record<string, BoostQuoteRule> | null;
}

function quoteMatchWinnerBoost(
  pair: MatchWinnerPair,
  ctx: MatchBoostContext,
  boosts: BatchedMatchBoosts,
): MatchWinnerBoostQuote | null {
  if (boosts.empty) return null;
  const marketId = BigInt(pair.homeMarketId);
  // provider_market_id 1 by construction — loadMatchWinnerOdds only
  // selects the match-winner market. Passing it lets a team_only
  // competitor rule resolve to this team's own outcome.
  const { marketWide: marketWideRule, selections: selectionRules } =
    boosts.resolve(ctx, marketId, 1);
  const hasSelections = !!selectionRules && selectionRules.size > 0;
  if (!marketWideRule && !hasSelections) return null;

  const marketWide = marketWideRule ? toQuoteRule(marketWideRule) : null;
  const selections = hasSelections
    ? new Map([...selectionRules].map(([k, v]) => [k, toQuoteRule(v)]))
    : null;
  // The RULE is returned even when it currently prices to nothing (the
  // fair-book clamp swallowed it, or the price didn't move at display
  // precision). The client re-prices on every WS tick, so a boost that
  // is invisible now can materialise a tick later — withholding the rule
  // would leave the row permanently unboosted until the next SSR load.
  const cells =
    pair.boostOutcomes.length > 0
      ? quoteMarketBoost({
          outcomes: pair.boostOutcomes,
          marketWide,
          selections,
        })
      : [];
  return {
    cells: new Map(cells.map((c) => [c.outcomeId, c])),
    marketWide,
    selections: selections ? Object.fromEntries(selections) : null,
  };
}

/** Serialised boost attached to one list-card price. */
function boostDto(cell: BoostQuoteCell | undefined) {
  if (!cell) return null;
  return {
    ruleId: cell.ruleId,
    boostPct: cell.boostPct,
    endsAt: cell.endsAt,
    /** Pre-boost price, for the struck-through original on the card. */
    originalPrice: cell.originalOdds,
  };
}

async function loadMatchWinnerOdds(
  db: FastifyInstance["db"],
  matchIds: bigint[],
): Promise<Map<string, MatchWinnerPair>> {
  const out = new Map<string, MatchWinnerPair>();
  if (matchIds.length === 0) return out;

  const rows = await db
    .select({
      matchId: markets.matchId,
      marketId: markets.id,
      outcomeId: marketOutcomes.outcomeId,
      publishedOdds: marketOutcomes.publishedOdds,
      probability: marketOutcomes.probability,
      active: marketOutcomes.active,
    })
    .from(markets)
    .innerJoin(marketOutcomes, eq(marketOutcomes.marketId, markets.id))
    .where(
      and(
        inArray(markets.matchId, matchIds),
        eq(markets.status, 1),
        // Oddin's match winner is provider_market_id 1. Fonbet match
        // winners live in the FONBET_PMID_BASE namespace and are the only
        // Fonbet markets using outcome ids "1" / "2" / "3", so the id
        // filter selects exactly the match-winner rows for both providers.
        or(
          eq(markets.providerMarketId, 1),
          and(
            gte(markets.providerMarketId, FONBET_PMID_BASE),
            inArray(marketOutcomes.outcomeId, ["1", "2", "3"]),
          ),
        ),
      ),
    );

  // Group by match, then by market_id within the match. Picking the
  // market with the most outcomes lets 3-way variants win over 2-way
  // when both exist for the same match.
  const byMatch = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.matchId.toString();
    const arr = byMatch.get(key) ?? [];
    arr.push(r);
    byMatch.set(key, arr);
  }
  for (const [key, outs] of byMatch) {
    const byMarket = new Map<string, typeof rows>();
    for (const r of outs) {
      const mk = r.marketId.toString();
      const arr = byMarket.get(mk) ?? [];
      arr.push(r);
      byMarket.set(mk, arr);
    }
    let best: typeof rows | null = null;
    for (const arr of byMarket.values()) {
      if (!best || arr.length > best.length) best = arr;
    }
    if (!best) continue;
    const home = best.find((o) => o.outcomeId === "1");
    const away = best.find((o) => o.outcomeId === "2");
    const draw = best.find((o) => o.outcomeId === "3");
    if (!home || !away) continue;
    out.set(key, {
      homeMarketId: home.marketId.toString(),
      homeOutcomeId: home.outcomeId,
      homePrice: home.active ? home.publishedOdds : null,
      // Probability is metadata — keep it independent of `active`.
      // The bet slip uses it for tiple/tippot preview; a suspended
      // price shouldn't blank the pricing context.
      homeProbability: home.probability ?? null,
      awayMarketId: away.marketId.toString(),
      awayOutcomeId: away.outcomeId,
      awayPrice: away.active ? away.publishedOdds : null,
      awayProbability: away.probability ?? null,
      drawOutcomeId: draw ? draw.outcomeId : null,
      drawPrice: draw ? (draw.active ? draw.publishedOdds : null) : null,
      drawProbability: draw?.probability ?? null,
      // >= 1 in parity with the client compute and placement: a favorite
      // at exactly 1.00 stays in the set so a live near-decided market
      // doesn't lose its boost on every tick.
      boostOutcomes: best
        .filter((o) => o.active && o.publishedOdds !== null)
        .map((o) => ({
          outcomeId: o.outcomeId,
          publishedOdds: Number(o.publishedOdds),
        }))
        .filter((o) => Number.isFinite(o.publishedOdds) && o.publishedOdds >= 1),
    });
  }
  return out;
}

// loadTopMarketIdsBySport fetches the ordered Top market ids for one or
// more sports. Returns a map keyed by sportId — empty array when the
// admin hasn't curated any Top markets for that sport. Used by the list
// endpoints to expose `topMarket` per card so the storefront can render
// a Top tab inline.
async function loadTopMarketIdsBySport(
  db: FastifyInstance["db"],
  sportIds: number[],
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (sportIds.length === 0) return out;
  const rows = await db
    .select({
      sportId: feMarketDisplayOrder.sportId,
      providerMarketId: feMarketDisplayOrder.providerMarketId,
      displayOrder: feMarketDisplayOrder.displayOrder,
    })
    .from(feMarketDisplayOrder)
    .where(
      and(
        eq(feMarketDisplayOrder.scope, "top"),
        inArray(feMarketDisplayOrder.sportId, sportIds),
      ),
    )
    .orderBy(asc(feMarketDisplayOrder.sportId), asc(feMarketDisplayOrder.displayOrder));
  for (const r of rows) {
    const arr = out.get(r.sportId) ?? [];
    // Since migration 0109 a Top list can hold the same market type more
    // than once, once per sub-event ("Total" on Match and on Corners). A
    // list card renders ONE market inline and has no tab to say which
    // sub-event it is, so it takes the first configured copy and ignores
    // the rest — the match page is where the distinction is legible.
    if (!arr.includes(r.providerMarketId)) {
      arr.push(r.providerMarketId);
      out.set(r.sportId, arr);
    }
  }
  return out;
}

// loadTopMarketsForMatches loads the first available Top market for each
// match (priority order = admin's configured order). Returns a map keyed
// by matchId. Designed for inline use on match list cards: one market
// per match, two outcomes preferred (so the card layout stays a clean
// 2-column row of price buttons).
// `formatPrice` is the per-outcome odds renderer. The default mirrors
// the historical behaviour (formatOdds() → 2-decimal floor truncate).
// Authed callers with a non-empty bettor cascade swap in a closure that
// applies the cascade per match before formatting.
type OutcomeFormatter = (
  raw: string | null,
  probability: string | null,
  matchId: bigint,
) => string | null;

async function loadTopMarketsForMatches(
  db: FastifyInstance["db"],
  matchSports: Array<{ matchId: bigint; sportId: number }>,
  topIdsBySport: Map<number, number[]>,
  formatPrice: OutcomeFormatter = (raw) => formatOdds(raw),
): Promise<Map<string, InlineTopMarket>> {
  const out = new Map<string, InlineTopMarket>();
  if (matchSports.length === 0) return out;

  const allTopIds = new Set<number>();
  for (const ids of topIdsBySport.values()) for (const id of ids) allTopIds.add(id);
  if (allTopIds.size === 0) return out;

  const matchIds = matchSports.map((m) => m.matchId);
  const rows = await db
    .select({
      matchId: markets.matchId,
      marketId: markets.id,
      providerMarketId: markets.providerMarketId,
      specifiersJson: markets.specifiersJson,
      status: markets.status,
      outcomeId: marketOutcomes.outcomeId,
      outcomeName: marketOutcomes.name,
      publishedOdds: marketOutcomes.publishedOdds,
      probability: marketOutcomes.probability,
      active: marketOutcomes.active,
    })
    .from(markets)
    .innerJoin(marketOutcomes, eq(marketOutcomes.marketId, markets.id))
    .where(
      and(
        inArray(markets.matchId, matchIds),
        inArray(markets.providerMarketId, Array.from(allTopIds)),
        eq(markets.status, 1),
      ),
    );

  // Group rows: matchId → providerMarketId → market data + outcomes.
  type MarketBucket = {
    marketId: bigint;
    providerMarketId: number;
    specifiers: Record<string, string>;
    outcomes: Array<{
      outcomeId: string;
      name: string;
      publishedOdds: string | null;
      probability: string | null;
      active: boolean;
    }>;
  };
  const byMatch = new Map<string, Map<number, MarketBucket>>();
  for (const r of rows) {
    const mkey = r.matchId.toString();
    let perMarket = byMatch.get(mkey);
    if (!perMarket) {
      perMarket = new Map();
      byMatch.set(mkey, perMarket);
    }
    let bucket = perMarket.get(r.providerMarketId);
    if (!bucket) {
      bucket = {
        marketId: r.marketId,
        providerMarketId: r.providerMarketId,
        specifiers: (r.specifiersJson ?? {}) as Record<string, string>,
        outcomes: [],
      };
      perMarket.set(r.providerMarketId, bucket);
    }
    bucket.outcomes.push({
      outcomeId: r.outcomeId,
      name: r.outcomeName ?? "",
      publishedOdds: r.publishedOdds,
      probability: r.probability,
      active: r.active,
    });
  }

  const sportByMatch = new Map<string, number>();
  for (const ms of matchSports) sportByMatch.set(ms.matchId.toString(), ms.sportId);

  for (const [mkey, perMarket] of byMatch) {
    const sportId = sportByMatch.get(mkey);
    if (!sportId) continue;
    const ids = topIdsBySport.get(sportId) ?? [];
    let pick: MarketBucket | undefined;
    for (const id of ids) {
      const candidate = perMarket.get(id);
      if (candidate) {
        pick = candidate;
        break;
      }
    }
    if (!pick) continue;
    // Three-way markets render 1 / X / 2 — outcome "3" (draw) sits between
    // home and away. See identical comment on m.outcomes.sort below for
    // the full rationale.
    pick.outcomes.sort((a, b) => {
      const aw = outcomeSortWeight(a.outcomeId);
      const bw = outcomeSortWeight(b.outcomeId);
      if (aw != null && bw != null) return aw - bw;
      if (aw != null) return -1;
      if (bw != null) return 1;
      return 0;
    });
    const mkeyBig = BigInt(mkey);
    out.set(mkey, {
      marketId: pick.marketId.toString(),
      providerMarketId: pick.providerMarketId,
      specifiers: pick.specifiers,
      outcomes: pick.outcomes.map((o) => ({
        outcomeId: o.outcomeId,
        name: o.name,
        publishedOdds: o.active
          ? formatPrice(o.publishedOdds, o.probability, mkeyBig)
          : null,
        probability: o.probability ?? null,
      })),
    });
  }
  return out;
}

interface InlineTopMarket {
  marketId: string;
  providerMarketId: number;
  specifiers: Record<string, string>;
  outcomes: Array<{
    outcomeId: string;
    name: string;
    publishedOdds: string | null;
    probability: string | null;
  }>;
}

// Sport slug shape is the same lowercase-and-hyphens convention used by
// every other slug in the catalog. The byte-serve regex stays anchored
// so a malformed segment (e.g. "..", "%2F") can't sneak through into the
// SQL lookup.
const SPORT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

export default async function catalogRoutes(app: FastifyInstance) {
  // ── Sport logo byte-serve (admin-uploaded) ──────────────────────────
  //
  // Returns the bytes stored on sports.logo_data with the recorded
  // logo_mime. Mirrors /community/avatars/:slug/image — anonymous,
  // long immutable cache because the storefront includes a ?v=<unix-ms>
  // query parameter on every upload that busts the browser cache for
  // the next render. Routes that don't carry uploaded bytes 404 here;
  // the storefront falls back to the bundled SVG for those.
  app.get<{ Params: { slug: string } }>(
    "/sports/:slug/logo",
    async (request, reply) => {
      const { slug } = request.params;
      if (!SPORT_SLUG_RE.test(slug)) throw new NotFoundError();
      const [row] = await app.db
        .select({
          logoData: sports.logoData,
          logoMime: sports.logoMime,
        })
        .from(sports)
        .where(eq(sports.slug, slug))
        .limit(1);
      if (!row || !row.logoData || !row.logoMime) throw new NotFoundError();
      reply
        .header("content-type", row.logoMime)
        .header("cache-control", "public, max-age=31536000, immutable")
        .send(Buffer.from(row.logoData));
    },
  );

  // ── Competitor logo byte-serve (admin-uploaded) ─────────────────────
  //
  // Numeric primary key keyed: competitors live behind a (sportId, slug)
  // composite unique, so a clean public URL needs the sport slug too.
  // Keeping the handler keyed by id avoids that branching — the upload
  // endpoint emits the byte-serve URL, so anything pointing at this
  // route is one we wrote ourselves.
  app.get<{ Params: { id: string } }>(
    "/competitors/:id/logo",
    async (request, reply) => {
      const idNum = Number(request.params.id);
      if (!Number.isInteger(idNum) || idNum <= 0) throw new NotFoundError();
      const [row] = await app.db
        .select({
          logoData: competitors.logoData,
          logoMime: competitors.logoMime,
        })
        .from(competitors)
        .where(eq(competitors.id, idNum))
        .limit(1);
      if (!row || !row.logoData || !row.logoMime) throw new NotFoundError();
      reply
        .header("content-type", row.logoMime)
        .header("cache-control", "public, max-age=31536000, immutable")
        .send(Buffer.from(row.logoData));
    },
  );

  // ── Tournament logo byte-serve (admin-uploaded) ─────────────────────
  //
  // Same shape as competitor: keyed by id because tournament slugs
  // aren't globally unique (they're scoped to category). The upload
  // endpoint stamps the byte-serve URL onto tournaments.logo_url.
  app.get<{ Params: { id: string } }>(
    "/tournaments/:id/logo",
    async (request, reply) => {
      const idNum = Number(request.params.id);
      if (!Number.isInteger(idNum) || idNum <= 0) throw new NotFoundError();
      const [row] = await app.db
        .select({
          logoData: tournaments.logoData,
          logoMime: tournaments.logoMime,
        })
        .from(tournaments)
        .where(eq(tournaments.id, idNum))
        .limit(1);
      if (!row || !row.logoData || !row.logoMime) throw new NotFoundError();
      reply
        .header("content-type", row.logoMime)
        .header("cache-control", "public, max-age=31536000, immutable")
        .send(Buffer.from(row.logoData));
    },
  );

  // ── Sports tree ─────────────────────────────────────────────────────
  // Cached: hit on every page render via (main)/layout.tsx; underlying
  // table mutates only via /admin/sports writes (which invalidate this
  // key on success).
  app.get("/catalog/sports", async () => {
    return cached(app.redis, SPORTS_CACHE_KEY, SPORTS_CACHE_TTL_SECONDS, async () => {
      // Drops sports with zero currently-bookable matches. A sport
      // with no live or upcoming matches (within the 6-h time gate
      // `hasActiveMarket` enforces) shouldn't take up real estate in
      // the sidebar — there's nothing to bet on. 60-s SPORTS_CACHE
      // TTL means a sport reappears within a minute of its first
      // match flipping to bookable. Mirrors the join chain in
      // /catalog/live-counts: sports → categories → tournaments →
      // matches → markets, with the same hidden-tournament gate.
      const rows = await app.db
        .select({
          id: sports.id,
          slug: sports.slug,
          name: sports.name,
          kind: sports.kind,
          active: sports.active,
          logoUrl: sports.logoUrl,
          brandColor: sports.brandColor,
          // Operator pin position (migration 0103). NULL for anything
          // unpinned, which the client orders by the old rule.
          displayOrder: sports.displayOrder,
        })
        .from(sports)
        .where(
          and(
            eq(sports.active, true),
            sql`EXISTS (
              SELECT 1
                FROM categories c
                JOIN tournaments t ON t.category_id = c.id
                                  AND t.name NOT IN ('Integration testing')
                JOIN matches m ON m.tournament_id = t.id
               WHERE c.sport_id = ${sports.id}
                 AND (
                   m.status = 'live'
                   OR (m.status = 'not_started'
                       AND m.scheduled_at > NOW() - INTERVAL '6 hours')
                 )
                 AND EXISTS (
                   SELECT 1 FROM markets mk
                    WHERE mk.match_id = m.id
                      AND mk.status = 1
                 )
            )`,
          ),
        )
        .orderBy(sql`${sports.displayOrder} ASC NULLS LAST`, sports.slug);
      return { sports: rows };
    });
  });

  // ── Combi Boost config (read-only, live-tunable in /admin) ───────────
  app.get("/catalog/combi-boost-config", async (request) => {
    // Per-bettor visibility (migration 0071). When the authed user has a
    // global combi_boost = false override, return `enabled=false` so the
    // storefront stops rendering the multiplier strip. Per-sport / per-
    // tournament / per-match overrides apply at placement only — the
    // list endpoint can't enumerate every (matchA, matchB, ...) combo a
    // bettor might build, so the bet-side resolver does the final say.
    if (request.user) {
      const cascades = await loadPromoVisibilityCascades(app.db, request.user.id);
      if (!resolveVisible(cascades, "combi_boost")) {
        return { enabled: false, minOdds: 1.5, tiers: [] };
      }
    }
    // The public shape is one singleton row, identical for everyone who
    // passed the visibility gate — cache it briefly. Placement reads the
    // row live inside its own transaction (bets/service.ts), so the
    // "admin save applies to the very next placement" contract is
    // unaffected; only this display endpoint lags by up to the TTL.
    return cached(app.redis, "catalog:combi-boost:v1", 10, async () => {
    const [row] = await app.db
      .select()
      .from(combiBoostConfig)
      .where(eq(combiBoostConfig.id, "default"))
      .limit(1);
    if (!row) {
      // Migration 0032 seeds the singleton, but on a freshly bootstrapped
      // dev DB it may briefly not exist. Return the static defaults so
      // the storefront still renders something coherent.
      return {
        enabled: true,
        minOdds: 1.5,
        tiers: [
          { minLegs: 2, multiplier: 1.03, label: "x1.03" },
          { minLegs: 4, multiplier: 1.05, label: "x1.05" },
          { minLegs: 6, multiplier: 1.08, label: "x1.08" },
          { minLegs: 8, multiplier: 1.12, label: "x1.12" },
        ],
      };
    }
    const tiers = [
      { minLegs: row.tier1MinLegs, multiplier: Number(row.tier1Multiplier) },
      { minLegs: row.tier2MinLegs, multiplier: Number(row.tier2Multiplier) },
      { minLegs: row.tier3MinLegs, multiplier: Number(row.tier3Multiplier) },
      { minLegs: row.tier4MinLegs, multiplier: Number(row.tier4Multiplier) },
    ].map((t) => ({ ...t, label: `x${t.multiplier.toFixed(2)}` }));
    return {
      enabled: row.enabled,
      minOdds: Number(row.minOdds),
      tiers,
    };
    });
  });

  // ── One sport + its upcoming/live matches ───────────────────────────
  // Per-IP cap on the odds-bearing catalog reads (2026-09-03). Friction
  // for the naive scraper, not a wall: ~5 req/s sustained, so enumerating
  // the whole offer takes minutes instead of seconds while a human — or an
  // office / carrier NAT worth of humans — never gets close. request.ip is
  // the real visitor on both paths: Caddy pins X-Forwarded-For for browser
  // calls, and the web tier forwards the same value on its SSR fetches
  // (apps/web/src/lib/server-fetch.ts), so the three replicas don't share
  // three buckets. Search keeps its own tighter 60/min below.
  app.get(
    "/catalog/sports/:slug",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
    const params = z.object({ slug: z.string().min(1).max(32) }).parse(request.params);
    const q = matchListQuery.parse(request.query);

    // Anonymous responses are identical for every signed-out viewer — the
    // only personalisation is the per-bettor odds adjustment, which
    // resolves to EMPTY_CASCADE without a user. Cache briefly keyed by the
    // full query shape so the 3 SSR replicas' render fan-out collapses to
    // ~one build per key per window; the storefront reconciles live odds
    // over WS after hydration, so a few seconds of staleness is invisible.
    // Authed requests bypass (their odds are per-user).
    const build = async () => {

    const [sport] = await app.db
      .select()
      .from(sports)
      .where(and(eq(sports.slug, params.slug), eq(sports.active, true)))
      .limit(1);
    if (!sport) throw new NotFoundError("sport_not_found", "sport_not_found");

    // Resolve the category filter before the matches query, for the same
    // reason the team filter is resolved below: the chip needs a name, and
    // an id that doesn't belong to this sport must produce an empty list
    // rather than silently widening back to "all matches". Simpler than
    // the team lookup — a category belongs to exactly one sport, so an
    // (id, sport_id) probe settles it.
    let filteredCategory: { id: number; name: string } | null = null;
    if (q.category) {
      const [c] = await app.db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(
          and(eq(categories.id, q.category), eq(categories.sportId, sport.id)),
        )
        .limit(1);
      if (c) filteredCategory = c;
    }

    // Resolve the team filter (if any) before the matches query so we can
    // surface the team's name back to the storefront for the chip. Scoped
    // by ACTUAL gameplay rather than `competitors.sport_id`: a team's
    // competitor row carries the sport that first saw the URN, but the
    // same row can be referenced as home/away_competitor_id by matches in
    // any sport. Lookup is active+id-only, and we additionally require an
    // EXISTS over matches in THIS sport so a team that doesn't play here
    // yields filteredTeam=null (chip hides, list is empty) — never silently
    // falls back to "all matches".
    let filteredTeam: { id: number; name: string } | null = null;
    if (q.team) {
      const teamId = q.team;
      const [t] = await app.db
        .select({ id: competitors.id, name: competitors.name })
        .from(competitors)
        .where(
          and(
            eq(competitors.id, teamId),
            eq(competitors.active, true),
            sql`EXISTS (
              SELECT 1 FROM ${matches} mm
              JOIN ${tournaments} tt ON tt.id = mm.tournament_id
              JOIN ${categories} cc ON cc.id = tt.category_id
              WHERE cc.sport_id = ${sport.id}
                AND (mm.home_competitor_id = ${teamId}
                     OR mm.away_competitor_id = ${teamId})
            )`,
          ),
        )
        .limit(1);
      if (t) filteredTeam = t;
    }

    const matchStatusCondition = q.live
      ? eq(matches.status, "live")
      : inArray(matches.status, ["not_started", "live"]);

    const rows = await app.db
      .select({
        matchId: matches.id,
        providerUrn: matches.providerUrn,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
        homeLogoUrl: homeCompetitor.logoUrl,
        awayLogoUrl: awayCompetitor.logoUrl,
        homeBrandColor: homeCompetitor.brandColor,
        awayBrandColor: awayCompetitor.brandColor,
        scheduledAt: matches.scheduledAt,
        status: matches.status,
        bestOf: matches.bestOf,
        liveScore: matches.liveScore,
        tournamentId: tournaments.id,
        tournamentName: tournaments.name,
        tournamentRiskTier: tournaments.riskTier,
        // Needed for the competitor tier of the ZillaBoost cascade.
        homeCompetitorId: matches.homeCompetitorId,
        awayCompetitorId: matches.awayCompetitorId,
      })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .leftJoin(homeCompetitor, eq(homeCompetitor.id, matches.homeCompetitorId))
      .leftJoin(awayCompetitor, eq(awayCompetitor.id, matches.awayCompetitorId))
      .where(
        and(
          eq(categories.sportId, sport.id),
          matchStatusCondition,
          // Skip matches with zero active markets — nothing to bet on.
          hasActiveMarket,
          notHiddenTournament,
          // List-excluded categories (EA FC and friends) are dropped from
          // the DEFAULT view only. Any explicit narrowing — a category, a
          // tournament or a team the bettor picked out of the tree or the
          // search box — means they asked for these rows, so the predicate
          // comes off. Leaving it on would render a chip for a filter that
          // then returns nothing, which is worse than not offering it.
          q.category || q.tournament || q.team ? undefined : notHiddenCategory,
          q.category ? eq(categories.id, q.category) : undefined,
          q.tournament ? eq(tournaments.id, q.tournament) : undefined,
          q.team
            ? or(
                eq(matches.homeCompetitorId, q.team),
                eq(matches.awayCompetitorId, q.team),
              )
            : undefined,
        ),
      )
      .orderBy(...matchListOrder())
      .limit(q.limit);

    // These three reads are mutually independent (all keyed off `rows` +
    // sport.id), so fire them together instead of paying three serial round
    // trips on this high-QPS SSR endpoint:
    //   • match-winner odds (provider_market_id=1) for inline list-card prices
    //   • per-bettor odds-adjustment cascade — anonymous requests resolve to
    //     EMPTY_CASCADE so the public-feed path is unchanged
    //   • the curated Top-market id list for this sport
    // loadTopMarketsForMatches below genuinely depends on the latter two, so
    // it stays sequential.
    const [oddsByMatch, cascade, topIdsBySport] = await Promise.all([
      loadMatchWinnerOdds(
        app.db,
        rows.map((r) => r.matchId),
      ),
      request.user
        ? loadBettorAdjustmentCascade(app.db, request.user.id)
        : Promise.resolve(EMPTY_CASCADE),
      loadTopMarketIdsBySport(app.db, [sport.id]),
    ]);
    const bpByMatch = new Map<string, number>();
    if (!cascade.empty) {
      for (const r of rows) {
        bpByMatch.set(
          r.matchId.toString(),
          resolveBettorAdjustmentBp(cascade, {
            matchId: r.matchId,
            tournamentId: r.tournamentId,
            sportId: sport.id,
          }),
        );
      }
    }
    const formatForMatch = (
      raw: string | null,
      probability: string | null,
      matchId: bigint,
    ): string | null => {
      const bp = bpByMatch.get(matchId.toString()) ?? 0;
      return applyBettorAdjustment(raw, probability, bp);
    };

    // ZillaBoost for the inline match-winner row. Sequential because it
    // needs the market ids that loadMatchWinnerOdds just resolved. The
    // match page recomputes boosts client-side per WS tick; a list card
    // has no per-outcome subscription, so it's priced here.
    const boostCtxBySport: MatchBoostContext[] = rows.map((r) => ({
      matchId: r.matchId,
      tournamentId: r.tournamentId,
      sportId: sport.id,
      homeCompetitorId: r.homeCompetitorId,
      awayCompetitorId: r.awayCompetitorId,
    }));
    const [viewerRiskScore, topMarkets] = await Promise.all([
      loadViewerRiskScore(app.db, request.user?.id),
      // Inline Top market per card (when admin configured the Top scope
      // for this sport). Returned alongside matchWinner so the storefront
      // can show either depending on which list-page tab is active.
      loadTopMarketsForMatches(
        app.db,
        rows.map((r) => ({ matchId: r.matchId, sportId: sport.id })),
        topIdsBySport,
        formatForMatch,
      ),
    ]);
    const boosts = await loadBoostRulesForMatches(
      app.db,
      boostCtxBySport,
      Array.from(oddsByMatch.values()).map((o) => BigInt(o.homeMarketId)),
      viewerRiskScore,
    );
    const boostCtxByMatch = new Map(
      boostCtxBySport.map((c) => [c.matchId.toString(), c]),
    );

    return {
      sport: {
        id: sport.id,
        slug: sport.slug,
        name: sport.name,
      },
      topConfigured: (topIdsBySport.get(sport.id) ?? []).length > 0,
      filteredTeam,
      filteredCategory,
      matches: rows.map((r) => {
        const o = oddsByMatch.get(r.matchId.toString());
        const top = topMarkets.get(r.matchId.toString()) ?? null;
        const bp = bpByMatch.get(r.matchId.toString()) ?? 0;
        return {
          id: r.matchId.toString(),
          providerUrn: r.providerUrn,
          homeTeam: r.homeTeam,
          awayTeam: r.awayTeam,
          homeLogoUrl: r.homeLogoUrl,
          awayLogoUrl: r.awayLogoUrl,
          homeBrandColor: r.homeBrandColor,
          awayBrandColor: r.awayBrandColor,
          scheduledAt: r.scheduledAt?.toISOString() ?? null,
          status: r.status,
          bestOf: r.bestOf,
          liveScore: r.liveScore,
          tournament: {
            id: r.tournamentId,
            name: r.tournamentName,
            riskTier: r.tournamentRiskTier,
          },
          matchWinner: o
            ? (() => {
                // A boosted cell REPLACES the adjusted price outright:
                // placement prices a boosted leg from the raw published
                // odds and skips the per-bettor adjustment entirely
                // (bets/service.ts branches on boostedOddsRuleId before
                // the adjustment branch), so the card has to show the
                // number placement will re-derive — otherwise the
                // bettor is quoted one price and charged another.
                const bctx = boostCtxByMatch.get(r.matchId.toString());
                const bq = bctx ? quoteMatchWinnerBoost(o, bctx, boosts) : null;
                const cells = bq?.cells;
                const homeCell = cells?.get(o.homeOutcomeId);
                const awayCell = cells?.get(o.awayOutcomeId);
                const drawCell = o.drawOutcomeId
                  ? cells?.get(o.drawOutcomeId)
                  : undefined;
                return {
                  marketId: o.homeMarketId,
                  // Resolved boost inputs so the client can re-price this
                  // row from live WS ticks. Without them the first tick
                  // would replace the boosted price with the raw one and
                  // the boost would visibly flicker off — the same bug
                  // 32286a7 fixed on the match page.
                  boostRule: bq?.marketWide ?? null,
                  boostSelections: bq?.selections ?? null,
                  home: {
                    outcomeId: o.homeOutcomeId,
                    // Suspended (price null) stays null — a boost must
                    // never resurrect an unbettable outcome.
                    price:
                      o.homePrice !== null && homeCell
                        ? homeCell.boostedOdds
                        : applyBettorAdjustment(
                            o.homePrice,
                            o.homeProbability,
                            bp,
                          ),
                    probability: o.homeProbability,
                    boost: o.homePrice !== null ? boostDto(homeCell) : null,
                  },
                  away: {
                    outcomeId: o.awayOutcomeId,
                    price:
                      o.awayPrice !== null && awayCell
                        ? awayCell.boostedOdds
                        : applyBettorAdjustment(
                            o.awayPrice,
                            o.awayProbability,
                            bp,
                          ),
                    probability: o.awayProbability,
                    boost: o.awayPrice !== null ? boostDto(awayCell) : null,
                  },
                  // Present only when the match-winner market is 3-way
                  // (BO2 esports, 1X2 sports). Storefront list cards
                  // grow a "Draw" row between home and away when this
                  // field is non-null.
                  draw: o.drawOutcomeId
                    ? {
                        outcomeId: o.drawOutcomeId,
                        price:
                          o.drawPrice !== null && drawCell
                            ? drawCell.boostedOdds
                            : applyBettorAdjustment(
                                o.drawPrice,
                                o.drawProbability,
                                bp,
                              ),
                        probability: o.drawProbability,
                        boost: o.drawPrice !== null ? boostDto(drawCell) : null,
                      }
                    : null,
                };
              })()
            : null,
          topMarket: top,
        };
      }),
    };
    };
    if (!request.user) {
      const key = `catalog:sport:v1:${params.slug}:${q.live ? 1 : 0}:${q.tournament ?? ""}:${q.team ?? ""}:${q.category ?? ""}:${q.limit}`;
      return cached(app.redis, key, ANON_LIST_CACHE_TTL_SECONDS, build);
    }
    return build();
  });

  // ── One match (+ tournament/sport + active markets + outcomes) ──────
  app.get(
    "/catalog/matches/:id",
    // Per-IP scraper friction — see the /catalog/sports/:slug note.
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
    const params = z
      .object({ id: z.coerce.bigint() })
      .parse(request.params);
    // Storefront writes its picked language into the oz_locale cookie
    // (see apps/web/src/lib/i18n/actions.ts). We pull the same cookie
    // here so the description templates land in the right language.
    // Falls back silently to 'en' on missing / unsupported values; the
    // SQL filter below always includes 'en' as a second source so
    // every market still gets a label even if Oddin doesn't ship the
    // requested language.
    const locale = resolveLocale(request.cookies as Record<string, string | undefined>);

    // Anonymous-only short cache. The response varies by locale (market
    // description templates), so the key carries it. Side note: the
    // phantom-live REST-refresh trip wire inside the build only fires on
    // cache misses now — fine, feed-ingester dedupes per URN with a 5-min
    // cooldown anyway, so per-request firing was always redundant.
    const build = async () => {

    const [match] = await app.db
      .select({
        id: matches.id,
        providerUrn: matches.providerUrn,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
        homeLogoUrl: homeCompetitor.logoUrl,
        awayLogoUrl: awayCompetitor.logoUrl,
        homeBrandColor: homeCompetitor.brandColor,
        awayBrandColor: awayCompetitor.brandColor,
        scheduledAt: matches.scheduledAt,
        status: matches.status,
        bestOf: matches.bestOf,
        liveScore: matches.liveScore,
        tvChannels: matches.tvChannels,
        tournamentId: tournaments.id,
        tournamentName: tournaments.name,
        tournamentRiskTier: tournaments.riskTier,
        sportId: sports.id,
        sportSlug: sports.slug,
        sportName: sports.name,
      })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .innerJoin(sports, eq(sports.id, categories.sportId))
      .leftJoin(homeCompetitor, eq(homeCompetitor.id, matches.homeCompetitorId))
      .leftJoin(awayCompetitor, eq(awayCompetitor.id, matches.awayCompetitorId))
      .where(eq(matches.id, params.id))
      .limit(1);
    if (!match) throw new NotFoundError("match_not_found", "match_not_found");

    // Phantom-live trip wire. Oddin's integration broker sometimes leaves
    // a match flagged `live` for hours (or, in extreme cases, years) after
    // the real fixture is over — usually because we missed a
    // match_status_change during a recovery gap. If a match still says
    // `live` more than 6 h after its scheduled start, ask the feed
    // ingester to re-fetch the fixture from REST. Feed-ingester dedupes
    // per-URN so repeated detail-page hits don't hammer Oddin.
    if (
      match.status === "live" &&
      match.providerUrn &&
      match.scheduledAt &&
      Date.now() - match.scheduledAt.getTime() > 6 * 60 * 60 * 1000
    ) {
      const urn = match.providerUrn;
      void app.db
        .execute(sql`SELECT pg_notify('fixture_refresh', ${urn})`)
        .catch((err) => {
          app.log.warn(
            { err, urn },
            "fixture_refresh notify failed",
          );
        });
    }

    // Four independent reads run together so the match-detail page (SSR'd
    // per navigation across 3 replicas) doesn't pay serial round trips:
    //   • the markets + outcomes themselves
    //   • the per-bettor odds-adjustment cascade (EMPTY_CASCADE for anonymous)
    //   • the per-scope admin market ordering for this sport (consumed near
    //     the end of the handler; only needs match.sportId, known already)
    //   • the tab (group) config for this sport — custom curated groups +
    //     admin-set tab order (migration 0084)
    //
    // Markets note: include in-play-suspended markets too — between
    // possessions / free throws / mid-round Oddin briefly flips the whole
    // offer to status 0 (deactivated) or -1 (suspended). If we filter to
    // only status=1 here, the page goes blank during those windows and the
    // WS subscription is never mounted, so when markets come back active a
    // few seconds later the user sees nothing until they hard-refresh. The
    // rendered button shows a Suspended pill and locks until an outcome tick
    // lands with active=true (see live-markets.tsx). Settled / cancelled /
    // pre-match-stuck (-2/-3/-4) stay excluded — those don't recover.
    //
    // market_descriptions is joined later (per distinct market id) to expand
    // {specifier} placeholders; missing ones fall back to "Market #N".
    const [rows, cascade, orderRows, groupConfigRows, srMapping] = await Promise.all([
      app.db
        .select({
          marketId: markets.id,
          providerMarketId: markets.providerMarketId,
          specifiersJson: markets.specifiersJson,
          status: markets.status,
          lastOddinTs: markets.lastOddinTs,
          outcomeId: marketOutcomes.outcomeId,
          outcomeName: marketOutcomes.name,
          publishedOdds: marketOutcomes.publishedOdds,
          probability: marketOutcomes.probability,
          active: marketOutcomes.active,
        })
        .from(markets)
        .leftJoin(marketOutcomes, eq(marketOutcomes.marketId, markets.id))
        .where(
          and(
            eq(markets.matchId, params.id),
            // 1 active, -1 suspended. Deactivated (0) markets are lines the
            // provider pulled — nothing to render, so they stay out of the
            // page instead of being loaded and dropped afterwards.
            inArray(markets.status, [1, -1]),
          ),
        )
        .orderBy(markets.providerMarketId),
      request.user
        ? loadBettorAdjustmentCascade(app.db, request.user.id)
        : Promise.resolve(EMPTY_CASCADE),
      app.db
        .select({
          scope: feMarketDisplayOrder.scope,
          providerMarketId: feMarketDisplayOrder.providerMarketId,
          variant: feMarketDisplayOrder.variant,
          displayOrder: feMarketDisplayOrder.displayOrder,
        })
        .from(feMarketDisplayOrder)
        .where(eq(feMarketDisplayOrder.sportId, match.sportId)),
      app.db
        .select({
          scope: feMarketGroups.scope,
          label: feMarketGroups.label,
          displayOrder: feMarketGroups.displayOrder,
          membership: feMarketGroups.membership,
        })
        .from(feMarketGroups)
        .where(eq(feMarketGroups.sportId, match.sportId)),
      // Sportradar mapping (migration 0100). CONFIRMED only — a candidate
      // is a guess nobody has signed off, and a wrong one would put
      // another fixture's live statistics on this page.
      app.db
        .select({
          srMatchId: matchSportradarIds.srMatchId,
          srSportId: matchSportradarIds.srSportId,
        })
        .from(matchSportradarIds)
        .where(
          and(
            eq(matchSportradarIds.matchId, match.id),
            eq(matchSportradarIds.status, "confirmed"),
          ),
        )
        .limit(1),
    ]);
    // Per-bettor adjustment for this match. Used by the full markets render
    // path below and the related-tab helpers downstream.
    const matchBp = resolveBettorAdjustmentBp(cascade, {
      matchId: match.id,
      tournamentId: match.tournamentId,
      sportId: match.sportId,
    });

    // Collect URN-style outcome ids (od:competitor:N / od:player:N) so
    // we can join against our profile cache and substitute human names
    // on the way out. Outcomes without a matching profile fall through
    // to their existing `name` / `outcomeId`.
    //
    // Also harvest URN-style specifier *values* — player-prop market
    // templates carry `{entity}` whose value is an `od:player:N` URN
    // ("{entity} Total kills - map {map}" → "Myrwn Total kills - map
    // 2"). Team-prop markets carry an `od:competitor:N` URN in the
    // same slot, so probe both buckets.
    const competitorUrns = new Set<string>();
    const playerUrns = new Set<string>();
    const harvestUrn = (raw: string) => {
      if (raw.startsWith("od:competitor:")) competitorUrns.add(raw);
      else if (raw.startsWith("od:player:")) playerUrns.add(raw);
    };
    for (const r of rows) {
      if (r.outcomeId) harvestUrn(r.outcomeId);
      const specs = (r.specifiersJson ?? {}) as Record<string, string>;
      for (const v of Object.values(specs)) {
        if (typeof v === "string" && v.startsWith("od:")) harvestUrn(v);
      }
    }
    // All four lookups are independent — fire in parallel so the
    // match-detail page p99 isn't a sum of four round-trips.
    const distinctMarketIds = Array.from(new Set(rows.map((r) => r.providerMarketId)));
    const [cps, pps, marketDescs, outcomeDescs] = await Promise.all([
      competitorUrns.size > 0
        ? app.db
            .select({ urn: competitorProfiles.urn, name: competitorProfiles.name })
            .from(competitorProfiles)
            .where(inArray(competitorProfiles.urn, Array.from(competitorUrns)))
        : Promise.resolve([]),
      playerUrns.size > 0
        ? app.db
            .select({ urn: playerProfiles.urn, name: playerProfiles.name })
            .from(playerProfiles)
            .where(inArray(playerProfiles.urn, Array.from(playerUrns)))
        : Promise.resolve([]),
      distinctMarketIds.length > 0
        ? app.db
            .select({
              providerMarketId: marketDescriptions.providerMarketId,
              variant: marketDescriptions.variant,
              language: marketDescriptions.language,
              nameTemplate: marketDescriptions.nameTemplate,
            })
            .from(marketDescriptions)
            .where(
              and(
                inArray(marketDescriptions.providerMarketId, distinctMarketIds),
                // Locale + EN fallback in one shot. Migration 0051 adds
                // the `language` column; pre-migration rows are 'en'.
                inArray(marketDescriptions.language, uniq([locale, "en"])),
              ),
            )
        : Promise.resolve([]),
      distinctMarketIds.length > 0
        ? app.db
            .select({
              providerMarketId: outcomeDescriptions.providerMarketId,
              variant: outcomeDescriptions.variant,
              outcomeId: outcomeDescriptions.outcomeId,
              language: outcomeDescriptions.language,
              nameTemplate: outcomeDescriptions.nameTemplate,
            })
            .from(outcomeDescriptions)
            .where(
              and(
                inArray(outcomeDescriptions.providerMarketId, distinctMarketIds),
                inArray(outcomeDescriptions.language, uniq([locale, "en"])),
              ),
            )
        : Promise.resolve([]),
    ]);
    const competitorNameMap = new Map<string, string>();
    for (const c of cps) competitorNameMap.set(c.urn, c.name);
    const playerNameMap = new Map<string, string>();
    for (const p of pps) playerNameMap.set(p.urn, p.name);
    // OutcomeProfiles bundle for substituteTemplate / renderOutcomeLabel
    // — the URN-prefix branches below still consult the underlying
    // maps directly because they decide on the fallback shape (raw
    // URN vs template) per-prefix.
    const profiles: OutcomeProfiles = {
      competitors: competitorNameMap,
      players: playerNameMap,
    };

    const descKey = (mid: number, variant: string) => `${mid}:${variant ?? ""}`;
    // Build a locale-preferring map. We inserted both locale and 'en'
    // rows above; if both exist for the same key, the locale row wins
    // by overwriting the 'en' row that lands first in the sort. When
    // locale === 'en', the inArray is just ['en'] and the preference
    // pass is a no-op.
    const marketDescMap = new Map<string, string>();
    const sortedMarketDescs = [...marketDescs].sort((a, b) => {
      const ap = a.language === locale ? 1 : 0;
      const bp = b.language === locale ? 1 : 0;
      return ap - bp; // 'en' first, locale second so it wins on .set()
    });
    for (const d of sortedMarketDescs) {
      marketDescMap.set(descKey(d.providerMarketId, d.variant), d.nameTemplate);
    }
    const outcomeDescMap = new Map<string, string>();
    // English-only companion map. Oddin's EN outcome templates use the
    // literal tokens "home" / "away" / "draw" for team-side outcomes; the
    // localized templates render a generic word ("хозяева" / "гости") that
    // no longer identifies the side. We consult the EN template as the
    // language-neutral semantic anchor to decide whether an outcome is the
    // home / away side, then substitute the actual team name so every
    // locale reads the team (matching the English behaviour) instead of a
    // generic "Home"/"Away" word. See the outcome loop below.
    const outcomeDescMapEn = new Map<string, string>();
    const sortedOutcomeDescs = [...outcomeDescs].sort((a, b) => {
      const ap = a.language === locale ? 1 : 0;
      const bp = b.language === locale ? 1 : 0;
      return ap - bp;
    });
    for (const d of sortedOutcomeDescs) {
      const k = `${d.providerMarketId}:${d.variant ?? ""}:${d.outcomeId}`;
      outcomeDescMap.set(k, d.nameTemplate);
      if (d.language === "en") outcomeDescMapEn.set(k, d.nameTemplate);
    }

    type MarketRow = {
      id: string;
      providerMarketId: number;
      specifiers: Record<string, string>;
      variant: string;
      name: string;
      baseName: string;
      scope: { id: string; label: string; order: number };
      status: number;
      lastOddinTs: string;
      lineKey: string | null;
      lineSpec: LineSpec | null;
      lineValue: string | null;
      outcomes: Array<{
        outcomeId: string;
        name: string;
        rawName: string;
        publishedOdds: string | null;
        probability: string | null;
        active: boolean;
      }>;
    };
    const marketMap = new Map<string, MarketRow>();

    for (const r of rows) {
      const key = r.marketId.toString();
      let m = marketMap.get(key);
      if (!m) {
        const specs = (r.specifiersJson ?? {}) as Record<string, string>;
        const variant = specs.variant ?? "";
        const template =
          marketDescMap.get(descKey(r.providerMarketId, variant)) ??
          marketDescMap.get(descKey(r.providerMarketId, "")) ??
          `Market #${r.providerMarketId}`;
        const line = lineInfo(r.providerMarketId, variant, specs);
        const baseTemplate = line.lineSpec
          ? stripLinePlaceholder(template, line.lineSpec)
          : template;
        // Pass match team names so "{side}" templates render as the
        // actual team ("Astralis total rounds 2.5") instead of the
        // literal word ("away total rounds 2.5"). Same on the base
        // template since the {side} placeholder lives in both name +
        // baseName paths.
        const teams = {
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
        };
        // Tab this market lands in — Match, Map N, or a Fonbet sub-event
        // (halves, corners, cards, player props). The sub-event label is
        // the prefix on the description template, so the derivation needs
        // the template as well as the specifiers; see
        // packages/types/src/market-scope.ts, which the backoffice reads
        // too so the tabs it offers are the tabs bettors get.
        //
        // The label is deliberately LEFT ON the market name and stripped
        // only from `baseName`. It used to come off both, on the reasoning
        // that the tab already says "3rd set aces" so repeating it on the
        // card is noise. That reasoning only holds where the tab is on
        // screen. `market.name` is also what the bet slip stores as its
        // leg label, what bet history renders, and what a copied community
        // ticket shows — none of which carry the tab. The result was a slip
        // leg reading "MATCH RESULT / 1" for a bet on the 3rd set ACES
        // count, at odds nothing like the real match-winner price: the
        // bettor could not tell what they had backed, and neither could
        // support reading it back. Repetition inside one tab is a cosmetic
        // cost; an unidentifiable leg on a money surface is not.
        const derived = deriveMarketScope({
          specifiers: specs,
          template,
          baseTemplate,
          playersLabel: locale === "ru" ? "Игроки" : "Players",
        });
        const scope = derived.scope;
        const baseNameTemplate = derived.baseTemplate;
        m = {
          id: key,
          providerMarketId: r.providerMarketId,
          specifiers: specs,
          variant,
          name: substituteTemplate(template, specs, teams, profiles, locale),
          baseName: substituteTemplate(baseNameTemplate, specs, teams, profiles, locale),
          scope,
          status: r.status,
          lastOddinTs: r.lastOddinTs.toString(),
          lineKey: line.lineKey,
          lineSpec: line.lineSpec,
          lineValue: line.lineValue,
          outcomes: [],
        };
        marketMap.set(key, m);
      }
      if (r.outcomeId) {
        const outcomeKey = `${r.providerMarketId}:${m.variant}:${r.outcomeId}`;
        const outcomeKeyNoVariant = `${r.providerMarketId}::${r.outcomeId}`;
        const outcomeTemplate =
          outcomeDescMap.get(outcomeKey) ??
          outcomeDescMap.get(outcomeKeyNoVariant) ??
          r.outcomeName ??
          r.outcomeId;
        const outcomeTemplateEn =
          outcomeDescMapEn.get(outcomeKey) ??
          outcomeDescMapEn.get(outcomeKeyNoVariant);
        // Player/competitor outcomes come off the feed as bare URNs —
        // prefer the cached profile name, fall back to whatever the
        // template resolved (which for team/player outcomes is usually
        // the same URN again). Non-URN outcome ids use the template.
        // Team-side outcome (match winner, map winner, handicap, …)?
        // Oddin's EN template is the literal "home"/"away", which
        // renderOutcomeLabel maps to the team name — but the localized
        // template is a generic word ("хозяева"/"гости") that the check
        // never matches, so non-English surfaces showed the generic word
        // instead of the team. Anchor on the EN template and substitute
        // the team name so every locale reads the team consistently.
        // (Draw falls through to the localized template so it stays
        // translated, e.g. "Ничья".)
        const enSide = homeAwaySideFromTemplate(outcomeTemplateEn);
        let resolvedName: string;
        // URN outcomes: profile name first, then the per-instance name the
        // feed carried on the outcome (the Bifrost backup fills it from
        // its selection names, so a player first seen while Oddin's REST
        // is down still reads as a name), then the raw URN.
        if (r.outcomeId.startsWith("od:competitor:")) {
          resolvedName = competitorNameMap.get(r.outcomeId) ?? (r.outcomeName || r.outcomeId);
        } else if (r.outcomeId.startsWith("od:player:")) {
          resolvedName = playerNameMap.get(r.outcomeId) ?? (r.outcomeName || r.outcomeId);
        } else if (enSide === "home") {
          resolvedName = match.homeTeam;
        } else if (enSide === "away") {
          resolvedName = match.awayTeam;
        } else {
          resolvedName = renderOutcomeLabel(
            outcomeTemplate,
            m.specifiers,
            match.homeTeam,
            match.awayTeam,
            profiles,
            locale,
          );
        }
        m.outcomes.push({
          outcomeId: r.outcomeId,
          name: resolvedName,
          rawName: r.outcomeName ?? "",
          publishedOdds: applyBettorAdjustment(
            r.publishedOdds,
            r.probability,
            matchBp,
          ),
          probability: r.probability ?? null,
          active: r.active ?? false,
        });
      }
    }

    // Group markets by scope (Match / Map 1 / Map 2 / …). Within a group
    // honour the per-sport admin ordering from fe_market_display_order;
    // markets without an explicit row fall back to provider_market_id
    // ascending (the legacy default). The override table is small —
    // typically <50 rows per sport — so a per-request fetch is cheap.
    const marketList = Array.from(marketMap.values());
    // Sort outcomes inside each market by Oddin's canonical outcome_id
    // (see outcomeSortWeight). PG returns outcomes in undefined order
    // without ORDER BY, which made home/away appear randomly swapped on
    // the match-detail UI before this sort was added.
    for (const m of marketList) {
      m.outcomes.sort((a, b) => {
        const aw = outcomeSortWeight(a.outcomeId);
        const bw = outcomeSortWeight(b.outcomeId);
        if (aw != null && bw != null) return aw - bw;
        if (aw != null) return -1;
        if (bw != null) return 1;
        return 0;
      });
    }
    const scopeMap = new Map<string, { id: string; label: string; order: number; markets: MarketRow[] }>();
    for (const m of marketList) {
      const g = scopeMap.get(m.scope.id) ?? { ...m.scope, markets: [] as MarketRow[] };
      g.markets.push(m);
      scopeMap.set(m.scope.id, g);
    }
    // Natural (Match / Map N) groups; curated groups (Top + custom) are
    // appended below and the whole set is sorted once at the end.
    const groups = Array.from(scopeMap.values());

    // Per-scope admin configuration (loaded in the parallel batch above).
    // Scope values live directly in fe_market_display_order and are
    // addressed the same way the storefront tabs are: `match`, `top`,
    // `map_<N>` (migration 0057), `fb_<kinds>` (0106), `custom_<key>`.
    // Rows keep their sub-event (0109) on every kind of tab — see
    // lib/market-groups.ts for what an empty one means where.
    const curatedByScope = new Map<
      string,
      Array<{ providerMarketId: number; variant: string; displayOrder: number }>
    >();
    for (const r of orderRows) {
      const list = curatedByScope.get(r.scope) ?? [];
      list.push({
        providerMarketId: r.providerMarketId,
        variant: r.variant ?? "",
        displayOrder: r.displayOrder,
      });
      curatedByScope.set(r.scope, list);
    }

    /** Feed default: market id ascending, the pre-config storefront order. */
    function sortByMarketId(list: MarketRow[]) {
      list.sort((a, b) => a.providerMarketId - b.providerMarketId);
    }
    // Feed tabs: the operator's rows can now do three things — order the
    // tab's own markets (what they always did), IMPORT a market from
    // another sub-event, and, when the tab is set to membership='manual'
    // (migration 0111), define the tab's contents outright.
    //
    // 'auto' is the default and stays lossless: the listed markets render
    // first in the operator's order, then everything else the feed puts on
    // the tab. That matters because the backoffice pool is built from the
    // CURRENT offer — a market kind that was not live when the operator
    // saved is simply not in the list, and under 'auto' it still reaches
    // bettors.
    const membershipByScope = new Map(
      groupConfigRows.map((r) => [r.scope as string, r.membership]),
    );
    for (const g of groups) {
      // Group id is the same string we store in fe_market_display_order
      // (match / map_<N> / fb_<kinds>), so one Map.get covers every feed
      // tab. Missing rows = default order.
      const rows = curatedByScope.get(g.id);
      if (rows && rows.length > 0) {
        g.markets = applyFeedTabMembership(
          g.markets,
          resolveGroupRows(marketList, g.id, rows, false),
          membershipByScope.get(g.id) === "manual" ? "manual" : "auto",
        );
        continue;
      }
      sortByMarketId(g.markets);
    }

    // Synthetic curated groups — markets the admin explicitly listed for
    // this sport, regardless of which tab they normally sit on. Two kinds
    // share the shape: the built-in "Top" tab and admin-created custom
    // groups (migration 0084).
    //
    // A row names a market TYPE and, since migration 0109, the SUB-EVENT it
    // means: provider_market_id alone is the catalogue table, which Fonbet
    // reuses across every sub-event, so "Total" without a variant cannot
    // distinguish the match total from the corners total. An empty variant
    // keeps its original meaning — any copy — and every pre-0109 row is
    // empty, so those resolve exactly as they did. Within the candidates a
    // row admits we still pick one representative (preferring the
    // match-scope copy, else the lowest-order map) so a curated tab doesn't
    // double up on totals that exist for both Match and Map 1.
    function buildCuratedGroup(
      id: string,
      label: string,
      order: number,
    ): { id: string; label: string; order: number; markets: MarketRow[] } | null {
      const curated = curatedByScope.get(id);
      if (!curated || curated.length === 0) return null;
      const markets = resolveGroupRows(marketList, id, curated, true);
      return markets.length > 0 ? { id, label, order, markets } : null;
    }

    // order=-1 renders Top before Match when no admin tab order is set.
    const topGroup = buildCuratedGroup("top", "Top", -1);
    if (topGroup) groups.push(topGroup);

    // Custom groups carry their operator-authored label verbatim — the
    // storefront's scopeLabel() falls through to `label` for ids it
    // doesn't recognise, so no client change is needed per group.
    for (const cfg of groupConfigRows) {
      if (!isCustomScope(cfg.scope)) continue;
      const custom = buildCuratedGroup(
        cfg.scope,
        cfg.label ?? "Custom",
        cfg.displayOrder,
      );
      if (custom) groups.push(custom);
    }

    // A tab set to membership='manual' can resolve to nothing on a given
    // fixture — its list may name markets this match does not carry — and
    // an empty tab is worse than no tab. Curated groups already return
    // null in that case; this covers the feed tabs.
    for (let i = groups.length - 1; i >= 0; i--) {
      if ((groups[i]?.markets.length ?? 0) === 0) groups.splice(i, 1);
    }

    // Tab order: groups with a fe_market_groups row sort first by the
    // admin-set display_order; the rest keep the default order (top=-1,
    // match=0, map_N=N). A sport with zero config rows behaves exactly
    // as before migration 0084.
    const groupOrderConfig = new Map(
      groupConfigRows.map((r) => [r.scope as string, r.displayOrder]),
    );
    groups.sort((a, b) => {
      const ca = groupOrderConfig.get(a.id);
      const cb = groupOrderConfig.get(b.id);
      if (ca != null && cb != null) return ca - cb || a.order - b.order;
      if (ca != null) return -1;
      if (cb != null) return 1;
      return a.order - b.order;
    });
    // Re-stamp `order` with the final render position so the wire value
    // stays consistent with the sorted array for any client that sorts.
    groups.forEach((g, idx) => {
      g.order = idx;
    });

    return {
      match: {
        id: match.id.toString(),
        providerUrn: match.providerUrn,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        homeLogoUrl: match.homeLogoUrl,
        awayLogoUrl: match.awayLogoUrl,
        homeBrandColor: match.homeBrandColor,
        awayBrandColor: match.awayBrandColor,
        scheduledAt: match.scheduledAt?.toISOString() ?? null,
        status: match.status,
        bestOf: match.bestOf,
        liveScore: match.liveScore,
        streams: parseMatchStreams(match.tvChannels),
        tournament: {
          id: match.tournamentId,
          name: match.tournamentName,
          riskTier: match.tournamentRiskTier,
        },
        sport: {
          id: match.sportId,
          slug: match.sportSlug,
          name: match.sportName,
        },
        // Set only when an operator-confirmed Sportradar mapping exists.
        // The storefront mounts the Live Match Tracker on it, and renders
        // no tracker at all when this is null.
        sportradar:
          srMapping[0] === undefined
            ? null
            : {
                srMatchId: Number(srMapping[0].srMatchId),
                srSportId: srMapping[0].srSportId,
              },
      },
      markets: marketList,
      marketGroups: groups,
    };
    };
    if (!request.user) {
      const key = `catalog:match:v1:${params.id}:${locale}`;
      return cached(app.redis, key, ANON_LIST_CACHE_TTL_SECONDS, build);
    }
    return build();
  });

  // ── Cross-sport match list (powers /live + /upcoming pages) ───────
  // status=live → currently-live matches across every allowed sport
  // status=upcoming → not-started matches sorted by scheduled_at
  //
  // Filters out matches with zero active markets. Oddin's integration
  // broker leaves some matches stuck at status='live' for hours with
  // no corresponding odds flow — those shouldn't appear in the live
  // list because the user can't place a bet on them anyway.
  app.get(
    "/catalog/matches",
    // Per-IP scraper friction — see the /catalog/sports/:slug note.
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
    const q = z
      .object({
        status: z.enum(["live", "upcoming"]).default("live"),
        limit: z.coerce.number().int().min(1).max(200).default(80),
        // Optional vertical filter: the /sports tab lists traditional
        // sports (Fonbet feed) only; the lobby keeps mixing both.
        kind: z.enum(["esport", "traditional"]).optional(),
      })
      .parse(request.query);

    // Anonymous-only short cache — same rationale as /catalog/sports/:slug.
    const build = async () => {

    const cond =
      q.status === "live"
        ? eq(matches.status, "live")
        : eq(matches.status, "not_started");

    const rows = await app.db
      .select({
        matchId: matches.id,
        providerUrn: matches.providerUrn,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
        homeLogoUrl: homeCompetitor.logoUrl,
        awayLogoUrl: awayCompetitor.logoUrl,
        homeBrandColor: homeCompetitor.brandColor,
        awayBrandColor: awayCompetitor.brandColor,
        scheduledAt: matches.scheduledAt,
        status: matches.status,
        bestOf: matches.bestOf,
        liveScore: matches.liveScore,
        tournamentId: tournaments.id,
        tournamentName: tournaments.name,
        tournamentRiskTier: tournaments.riskTier,
        sportId: sports.id,
        sportSlug: sports.slug,
        sportName: sports.name,
        // Operator pin position, so the lobby / live / upcoming lists
        // group sports in the same order the sidebar rail shows them.
        // Carried per row because these lists span sports and the pages
        // rendering them don't fetch /catalog/sports.
        sportDisplayOrder: sports.displayOrder,
        // Needed for the competitor tier of the ZillaBoost cascade.
        homeCompetitorId: matches.homeCompetitorId,
        awayCompetitorId: matches.awayCompetitorId,
      })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .innerJoin(sports, eq(sports.id, categories.sportId))
      .leftJoin(homeCompetitor, eq(homeCompetitor.id, matches.homeCompetitorId))
      .leftJoin(awayCompetitor, eq(awayCompetitor.id, matches.awayCompetitorId))
      .where(
        and(
          cond,
          eq(sports.active, true),
          q.kind ? eq(sports.kind, q.kind) : undefined,
          hasActiveMarket,
          notHiddenTournament,
          // Unconditional here: this endpoint backs the lobby, /live and
          // /upcoming, none of which take a category filter. A bettor who
          // wants EA FC goes through the sport tree.
          notHiddenCategory,
        ),
      )
      .orderBy(...matchListOrder())
      .limit(q.limit);

    // Independent reads (match-winner odds, per-bettor cascade, Top-market
    // id list across the distinct sports in this page) run together — three
    // serial round trips on a high-QPS SSR endpoint otherwise. Per-bettor
    // adjustment is cross-sport here (every row has its own sportId);
    // anonymous resolves to EMPTY_CASCADE so the public path is unchanged.
    const distinctSportIds = Array.from(new Set(rows.map((r) => r.sportId)));
    const [oddsByMatch, cascade, topIdsBySport] = await Promise.all([
      loadMatchWinnerOdds(
        app.db,
        rows.map((r) => r.matchId),
      ),
      request.user
        ? loadBettorAdjustmentCascade(app.db, request.user.id)
        : Promise.resolve(EMPTY_CASCADE),
      loadTopMarketIdsBySport(app.db, distinctSportIds),
    ]);
    const bpByMatch = new Map<string, number>();
    if (!cascade.empty) {
      for (const r of rows) {
        bpByMatch.set(
          r.matchId.toString(),
          resolveBettorAdjustmentBp(cascade, {
            matchId: r.matchId,
            tournamentId: r.tournamentId,
            sportId: r.sportId,
          }),
        );
      }
    }
    const formatForMatch = (
      raw: string | null,
      probability: string | null,
      matchId: bigint,
    ): string | null => {
      const bp = bpByMatch.get(matchId.toString()) ?? 0;
      return applyBettorAdjustment(raw, probability, bp);
    };

    // ZillaBoost for the inline match-winner row — see the sport-page
    // handler for why the list prices this server-side.
    const boostCtxList: MatchBoostContext[] = rows.map((r) => ({
      matchId: r.matchId,
      tournamentId: r.tournamentId,
      sportId: r.sportId,
      homeCompetitorId: r.homeCompetitorId,
      awayCompetitorId: r.awayCompetitorId,
    }));
    // Inline Top markets per card. We fetch the curated id list per
    // sport once (typically a handful of distinct sports in any list
    // response), then resolve the first available Top market per match.
    const [viewerRiskScore, topMarkets] = await Promise.all([
      loadViewerRiskScore(app.db, request.user?.id),
      loadTopMarketsForMatches(
        app.db,
        rows.map((r) => ({ matchId: r.matchId, sportId: r.sportId })),
        topIdsBySport,
        formatForMatch,
      ),
    ]);
    const boosts = await loadBoostRulesForMatches(
      app.db,
      boostCtxList,
      Array.from(oddsByMatch.values()).map((o) => BigInt(o.homeMarketId)),
      viewerRiskScore,
    );
    const boostCtxByMatch = new Map(
      boostCtxList.map((c) => [c.matchId.toString(), c]),
    );
    const topConfiguredSports: Record<string, boolean> = {};
    for (const r of rows) {
      const slug = r.sportSlug;
      if (topConfiguredSports[slug] !== undefined) continue;
      topConfiguredSports[slug] = (topIdsBySport.get(r.sportId) ?? []).length > 0;
    }

    return {
      topConfiguredSports,
      matches: rows.map((r) => {
        const o = oddsByMatch.get(r.matchId.toString());
        const top = topMarkets.get(r.matchId.toString()) ?? null;
        const bp = bpByMatch.get(r.matchId.toString()) ?? 0;
        return {
          id: r.matchId.toString(),
          providerUrn: r.providerUrn,
          homeTeam: r.homeTeam,
          awayTeam: r.awayTeam,
          homeLogoUrl: r.homeLogoUrl,
          awayLogoUrl: r.awayLogoUrl,
          homeBrandColor: r.homeBrandColor,
          awayBrandColor: r.awayBrandColor,
          scheduledAt: r.scheduledAt?.toISOString() ?? null,
          status: r.status,
          bestOf: r.bestOf,
          liveScore: r.liveScore,
          tournament: {
            id: r.tournamentId,
            name: r.tournamentName,
            riskTier: r.tournamentRiskTier,
          },
          sport: {
            slug: r.sportSlug,
            name: r.sportName,
            displayOrder: r.sportDisplayOrder,
          },
          matchWinner: o
            ? (() => {
                // A boosted cell REPLACES the adjusted price outright:
                // placement prices a boosted leg from the raw published
                // odds and skips the per-bettor adjustment entirely
                // (bets/service.ts branches on boostedOddsRuleId before
                // the adjustment branch), so the card has to show the
                // number placement will re-derive — otherwise the
                // bettor is quoted one price and charged another.
                const bctx = boostCtxByMatch.get(r.matchId.toString());
                const bq = bctx ? quoteMatchWinnerBoost(o, bctx, boosts) : null;
                const cells = bq?.cells;
                const homeCell = cells?.get(o.homeOutcomeId);
                const awayCell = cells?.get(o.awayOutcomeId);
                const drawCell = o.drawOutcomeId
                  ? cells?.get(o.drawOutcomeId)
                  : undefined;
                return {
                  marketId: o.homeMarketId,
                  // Resolved boost inputs so the client can re-price this
                  // row from live WS ticks. Without them the first tick
                  // would replace the boosted price with the raw one and
                  // the boost would visibly flicker off — the same bug
                  // 32286a7 fixed on the match page.
                  boostRule: bq?.marketWide ?? null,
                  boostSelections: bq?.selections ?? null,
                  home: {
                    outcomeId: o.homeOutcomeId,
                    // Suspended (price null) stays null — a boost must
                    // never resurrect an unbettable outcome.
                    price:
                      o.homePrice !== null && homeCell
                        ? homeCell.boostedOdds
                        : applyBettorAdjustment(
                            o.homePrice,
                            o.homeProbability,
                            bp,
                          ),
                    probability: o.homeProbability,
                    boost: o.homePrice !== null ? boostDto(homeCell) : null,
                  },
                  away: {
                    outcomeId: o.awayOutcomeId,
                    price:
                      o.awayPrice !== null && awayCell
                        ? awayCell.boostedOdds
                        : applyBettorAdjustment(
                            o.awayPrice,
                            o.awayProbability,
                            bp,
                          ),
                    probability: o.awayProbability,
                    boost: o.awayPrice !== null ? boostDto(awayCell) : null,
                  },
                  // Present only when the match-winner market is 3-way
                  // (BO2 esports, 1X2 sports). Storefront list cards
                  // grow a "Draw" row between home and away when this
                  // field is non-null.
                  draw: o.drawOutcomeId
                    ? {
                        outcomeId: o.drawOutcomeId,
                        price:
                          o.drawPrice !== null && drawCell
                            ? drawCell.boostedOdds
                            : applyBettorAdjustment(
                                o.drawPrice,
                                o.drawProbability,
                                bp,
                              ),
                        probability: o.drawProbability,
                        boost: o.drawPrice !== null ? boostDto(drawCell) : null,
                      }
                    : null,
                };
              })()
            : null,
          topMarket: top,
        };
      }),
    };
    };
    if (!request.user) {
      const key = `catalog:matches:v1:${q.status}:${q.kind ?? "all"}:${q.limit}`;
      return cached(app.redis, key, ANON_LIST_CACHE_TTL_SECONDS, build);
    }
    return build();
  });

  // ── Tournaments under a sport (for sidebar expansion) ──────────────
  // Returns active tournaments under the sport with at least one
  // live/upcoming match that still has active markets — empty
  // tournaments (every match closed/cancelled or stale per the
  // `hasActiveMarket` predicate above) are filtered out so the
  // sidebar never lists a tournament that produces an empty page
  // when clicked. `matchCount` and `liveCount` use the same shared
  // predicate. Sort: risk_tier asc
  // so Oddin tier 1/2 (the featured ones with the gold star) float to
  // the top, NULLs last so unbackfilled rows don't crowd out the ones
  // we know about, then live-first, then more-matches-first, then
  // alphabetical.
  app.get(
    "/catalog/sports/:slug/tournaments",
    // Per-IP scraper friction — see the /catalog/sports/:slug note.
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
    const params = z.object({ slug: z.string().min(1).max(32) }).parse(request.params);
    const [sport] = await app.db
      .select()
      .from(sports)
      .where(and(eq(sports.slug, params.slug), eq(sports.active, true)))
      .limit(1);
    if (!sport) throw new NotFoundError("sport_not_found", "sport_not_found");

    // Fully public (no per-user shaping) and the sidebar auto-fetches it on
    // every sport-page render, but the aggregate LEFT JOINs every match
    // under the sport and evaluates the correlated hasActiveMarket EXISTS
    // per (tournament, match) row — hundreds of `markets` index probes per
    // call on a busy sport. Measured on production 2026-09-06: football
    // (291 tournaments over ~1 900 matches) takes ~1.3 s cold against
    // ~85 ms warm. The cheap sport lookup + 404 stay outside the cache so
    // unknown slugs never enter it.
    //
    // Stale-while-revalidate rather than a plain TTL, because the plain
    // TTL put that 1.3 s in front of a REAL bettor almost every time: at
    // this traffic level a 10 s window is nearly always expired when
    // someone expands the tree, so the person clicking was the person
    // paying for the refresh. Now 15 s of freshness (live counts stay
    // roughly as current as before — the sport row's own badge comes
    // from /catalog/live-counts at 5 s, so this list is a navigation aid,
    // not a scoreboard) and a 10 min stale window: within that window the
    // expand is instant and the refresh happens behind the response.
    return cachedSwr(
      app.redis,
      `catalog:tournaments:v1:${sport.id}`,
      15,
      600,
      async () => {

    const matchCountExpr = sql<string>`COUNT(DISTINCT ${matches.id}) FILTER (
      WHERE ${matches.status} IN ('not_started','live')
        AND ${hasActiveMarket}
    )::text`;
    const liveCountExpr = sql<string>`COUNT(DISTINCT ${matches.id}) FILTER (
      WHERE ${matches.status} = 'live'
        AND ${hasActiveMarket}
    )::text`;
    const rows = await app.db
      .select({
        id: tournaments.id,
        name: tournaments.name,
        riskTier: tournaments.riskTier,
        // Operator pin position within this tournament's category
        // (migration 0104). NULL leaves it in the tier/name tail.
        displayOrder: tournaments.displayOrder,
        logoUrl: tournaments.logoUrl,
        brandColor: tournaments.brandColor,
        // The category is what the storefront groups the sidebar list by
        // (England > Premier League, rather than 50 dotted names in a
        // flat column). `isDummy` matters: Oddin's auto-mapper files every
        // esports tournament under one synthetic "Auto-mapped" category,
        // so a header there would be noise on every esport - the client
        // renders those flat. Fonbet's are real (country / competition,
        // derived from the segment-name prefix).
        categoryId: categories.id,
        categoryName: categories.name,
        categorySlug: categories.slug,
        categoryIsDummy: categories.isDummy,
        // Operator pin position within this sport's tree (migration
        // 0103). NULL leaves the bucket in the alphabetical tail.
        categoryDisplayOrder: categories.displayOrder,
        // Surfaced so the sidebar can mark the bucket as list-excluded.
        // The tree itself is NOT filtered by it — a category kept out of
        // the lists still has to be reachable, and this is where from.
        categoryHiddenFromLists: categories.hiddenFromLists,
        matchCount: matchCountExpr,
        liveCount: liveCountExpr,
      })
      .from(tournaments)
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .leftJoin(matches, eq(matches.tournamentId, tournaments.id))
      .where(
        and(
          eq(categories.sportId, sport.id),
          eq(tournaments.active, true),
          notHiddenTournament,
        ),
      )
      .groupBy(
        tournaments.id,
        tournaments.name,
        tournaments.riskTier,
        tournaments.displayOrder,
        tournaments.logoUrl,
        tournaments.brandColor,
        categories.id,
        categories.name,
        categories.slug,
        categories.isDummy,
        categories.displayOrder,
        categories.hiddenFromLists,
      )
      .having(sql`${matchCountExpr}::int > 0`);

    const tournamentsOut = rows
      .map((r) => ({
        id: r.id,
        name: r.name,
        riskTier: r.riskTier,
        displayOrder: r.displayOrder,
        logoUrl: r.logoUrl,
        brandColor: r.brandColor,
        category:
          r.categoryIsDummy || !r.categoryName
            ? null
            : {
                id: r.categoryId,
                name: r.categoryName,
                slug: r.categorySlug,
                hiddenFromLists: r.categoryHiddenFromLists,
                displayOrder: r.categoryDisplayOrder,
              },
        matchCount: Number(r.matchCount),
        liveCount: Number(r.liveCount),
      }))
      .sort((a, b) => {
        // Operator pin first (migration 0104). Buckets are formed client
        // side and preserve this order within each one, so a pinned
        // tournament heads its own category even though the sort here is
        // across the whole sport.
        const ap = a.displayOrder ?? Number.MAX_SAFE_INTEGER;
        const bp = b.displayOrder ?? Number.MAX_SAFE_INTEGER;
        if (ap !== bp) return ap - bp;
        // Number.MAX_SAFE_INTEGER puts NULL-tier rows after every
        // tiered row when sorting ASC, matching the SQL "NULLS LAST"
        // convention without an extra branch.
        const at = a.riskTier ?? Number.MAX_SAFE_INTEGER;
        const bt = b.riskTier ?? Number.MAX_SAFE_INTEGER;
        if (at !== bt) return at - bt;
        if (a.liveCount !== b.liveCount) return b.liveCount - a.liveCount;
        if (a.matchCount !== b.matchCount) return b.matchCount - a.matchCount;
        return a.name.localeCompare(b.name);
      });

    return {
      sport: { id: sport.id, slug: sport.slug, name: sport.name },
      tournaments: tournamentsOut,
    };
      },
    );
  });

  // ── Sportradar reference for a tournament ──────────────────────────
  // The Live Table widget resolves a season from ANY id it is given —
  // matchId, tournamentId, uniqueTournamentId or seasonId (read from the
  // widget's own async-prop definition, chunk `season.liveTable`,
  // 2026-09-05). We hold none of Sportradar's tournament ids and there is
  // no feed that carries them, but migration 0100 already maps individual
  // MATCHES, so one confirmed fixture under the tournament is enough to
  // resolve its table — no second id space to map, review and keep true.
  //
  // Which fixture matters: a season table is per season, so pointing at
  // a match from a finished season renders last season's standings. Rows
  // are therefore ordered live/upcoming first (soonest kickoff), and only
  // then the most recent past fixture as a fallback.
  app.get(
    "/catalog/tournaments/:id/sportradar",
    // Per-IP scraper friction — same budget as the other catalog reads.
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
      const params = z
        .object({ id: z.coerce.number().int().positive() })
        .parse(request.params);
      // Anonymous, tiny, and polled by every tournament view; the mapping
      // itself only changes when an operator confirms one.
      return cached(
        app.redis,
        `catalog:tournament-sr:v1:${params.id}`,
        60,
        async () => {
          const rows = await app.db
            .select({
              srMatchId: matchSportradarIds.srMatchId,
              srSportId: matchSportradarIds.srSportId,
            })
            .from(matchSportradarIds)
            .innerJoin(matches, eq(matches.id, matchSportradarIds.matchId))
            .where(
              and(
                eq(matches.tournamentId, params.id),
                eq(matchSportradarIds.status, "confirmed"),
              ),
            )
            .orderBy(
              sql`(${matches.status} IN ('live','not_started')) DESC`,
              sql`CASE WHEN ${matches.status} IN ('live','not_started')
                    THEN ${matches.scheduledAt} END ASC NULLS LAST`,
              sql`${matches.scheduledAt} DESC NULLS LAST`,
            )
            .limit(1);
          const row = rows[0];
          return {
            sportradar: row
              ? {
                  srMatchId: Number(row.srMatchId),
                  srSportId: row.srSportId,
                }
              : null,
          };
        },
      );
    },
  );

  // ── Global search across sports, tournaments, teams, and matches ───
  // Case-insensitive substring match. Each facet is capped at `limit`
  // rows (default 6). Only active rows are returned, and matches are
  // restricted to not_started/live with at least one active market so
  // clicking through lands on a page where the user can place a bet.
  app.get(
    "/catalog/search",
    {
      // Anonymous and reachable directly from the browser (top-bar search).
      // The query runs leading-wildcard ILIKE scans across sports /
      // tournaments / teams / matches that cannot use an index, so an
      // unthrottled scraper could saturate the small (max 10) DB pool and
      // starve live storefront traffic. Per-IP cap (request.ip resolves to
      // the real client via Caddy's X-Forwarded-For + Fastify trustProxy).
      // The debounced search box never approaches 60/min for a real user.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
    const q = z
      .object({
        q: z.string().trim().min(1).max(64),
        limit: z.coerce.number().int().min(1).max(20).default(6),
      })
      .parse(request.query);

    // Escape ILIKE wildcards so a user typing "50%" doesn't match
    // everything. pg's default escape is "\", reinforced with ESCAPE '\'.
    const escaped = q.q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const needle = `%${escaped}%`;

    const [sportRows, tournamentRows, teamRows, matchRows] = await Promise.all([
      app.db
        .select({ slug: sports.slug, name: sports.name, kind: sports.kind })
        .from(sports)
        .where(
          and(
            eq(sports.active, true),
            or(ilike(sports.name, needle), ilike(sports.slug, needle)),
          ),
        )
        .orderBy(sports.name)
        .limit(q.limit),

      app.db
        .select({
          id: tournaments.id,
          name: tournaments.name,
          riskTier: tournaments.riskTier,
          sportSlug: sports.slug,
          sportName: sports.name,
        })
        .from(tournaments)
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(
          and(
            eq(tournaments.active, true),
            eq(sports.active, true),
            ilike(tournaments.name, needle),
            notHiddenTournament,
            // Empty tournaments (every match closed/phantom-stale) are
            // hidden so search results never lead to a zero-match page.
            // Same 6 h time gate as `hasActiveMarket` so a tournament
            // surviving only on wedged not_started matches drops out.
            sql`EXISTS (
              SELECT 1 FROM ${matches} mm
               WHERE mm.tournament_id = ${tournaments.id}
                 AND (
                   mm.status = 'live'
                   OR (mm.status = 'not_started'
                       AND mm.scheduled_at > NOW() - INTERVAL '6 hours')
                 )
                 AND EXISTS (
                   SELECT 1 FROM markets mk
                    WHERE mk.match_id = mm.id
                      AND mk.status = 1
                 )
            )`,
          ),
        )
        .orderBy(tournaments.name)
        .limit(q.limit),

      // Team search emits one row per (competitor, sport-with-active-matches).
      // The `competitors` table has a global UNIQUE on (provider, provider_urn),
      // so a team like "BetBoom Team" lives as a single row whose `sport_id`
      // is whichever sport saw the URN first — even though that team's
      // home_competitor_id / away_competitor_id is referenced by matches in
      // other sports. Surfacing (team, sport) pairs derived from actual
      // match data lets the user navigate to every sport the team is
      // currently playing in, not just the one its competitor row was first
      // pinned to. Filtered to active markets + non-hidden tournaments + the
      // same 6 h time gate as `hasActiveMarket` so a team only appears for
      // sports where it has something bettable right now.
      app.db
        .select({
          id: competitors.id,
          name: competitors.name,
          abbreviation: competitors.abbreviation,
          logoUrl: competitors.logoUrl,
          brandColor: competitors.brandColor,
          sportSlug: sports.slug,
          sportName: sports.name,
        })
        .from(competitors)
        .innerJoin(
          matches,
          or(
            eq(matches.homeCompetitorId, competitors.id),
            eq(matches.awayCompetitorId, competitors.id),
          ),
        )
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(
          and(
            eq(competitors.active, true),
            eq(sports.active, true),
            or(
              ilike(competitors.name, needle),
              ilike(competitors.abbreviation, needle),
            ),
            inArray(matches.status, ["not_started", "live"]),
            hasActiveMarket,
            notHiddenTournament,
          ),
        )
        .groupBy(
          competitors.id,
          competitors.name,
          competitors.abbreviation,
          competitors.logoUrl,
          competitors.brandColor,
          sports.slug,
          sports.name,
        )
        .orderBy(competitors.name, sports.name)
        .limit(q.limit),

      app.db
        .select({
          id: matches.id,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          homeLogoUrl: homeCompetitor.logoUrl,
          awayLogoUrl: awayCompetitor.logoUrl,
          scheduledAt: matches.scheduledAt,
          status: matches.status,
          tournamentId: tournaments.id,
          tournamentName: tournaments.name,
          tournamentRiskTier: tournaments.riskTier,
          sportSlug: sports.slug,
          sportName: sports.name,
        })
        .from(matches)
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .leftJoin(homeCompetitor, eq(homeCompetitor.id, matches.homeCompetitorId))
        .leftJoin(awayCompetitor, eq(awayCompetitor.id, matches.awayCompetitorId))
        .where(
          and(
            eq(sports.active, true),
            inArray(matches.status, ["not_started", "live"]),
            or(
              ilike(matches.homeTeam, needle),
              ilike(matches.awayTeam, needle),
            ),
            hasActiveMarket,
            notHiddenTournament,
          ),
        )
        .orderBy(desc(matches.status), matches.scheduledAt)
        .limit(q.limit),
    ]);

    return {
      query: q.q,
      sports: sportRows,
      tournaments: tournamentRows.map((t) => ({
        id: t.id,
        name: t.name,
        riskTier: t.riskTier,
        sport: { slug: t.sportSlug, name: t.sportName },
      })),
      teams: teamRows.map((t) => ({
        id: t.id,
        name: t.name,
        abbreviation: t.abbreviation,
        logoUrl: t.logoUrl,
        brandColor: t.brandColor,
        sport: { slug: t.sportSlug, name: t.sportName },
      })),
      matches: matchRows.map((m) => ({
        id: m.id.toString(),
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        homeLogoUrl: m.homeLogoUrl,
        awayLogoUrl: m.awayLogoUrl,
        scheduledAt: m.scheduledAt?.toISOString() ?? null,
        status: m.status,
        tournament: {
          id: m.tournamentId,
          name: m.tournamentName,
          riskTier: m.tournamentRiskTier,
        },
        sport: { slug: m.sportSlug, name: m.sportName },
      })),
    };
  });

  // ── Counts across sports (for homepage live badges) ────────────────
  // Counts only matches with at least one active market — a bare
  // status='live' match with no odds flow is not useful for a badge.
  // Cached 5s: this is a 4-way LEFT JOIN hit on every page render via
  // (main)/layout.tsx; a 5s TTL absorbs burst traffic while keeping the
  // badge tight to actual live/end transitions.
  app.get("/catalog/live-counts", async () => {
    return cached(
      app.redis,
      LIVE_COUNTS_CACHE_KEY,
      LIVE_COUNTS_CACHE_TTL_SECONDS,
      async () => {
        const rows = await app.db
          .select({
            slug: sports.slug,
            count: sql<string>`COUNT(${matches.id})::text`,
          })
          .from(sports)
          // The count has to agree with the list it labels. A "Football
          // 23" badge over a list of 13 real matches is worse than no
          // badge at all — so the same exclusion the lists apply is
          // applied here. This is the SPORT-level badge only; the per-category
          // and per-tournament counts in the sidebar tree deliberately
          // still count hidden rows, because that tree is where a bettor
          // goes to find them.
          .leftJoin(
            categories,
            and(eq(categories.sportId, sports.id), notHiddenCategory),
          )
          .leftJoin(
            tournaments,
            and(
              eq(tournaments.categoryId, categories.id),
              notHiddenTournament,
            ),
          )
          .leftJoin(
            matches,
            and(
              eq(matches.tournamentId, tournaments.id),
              eq(matches.status, "live"),
              hasActiveMarket,
            ),
          )
          .where(eq(sports.active, true))
          .groupBy(sports.slug);
        const counts: Record<string, number> = {};
        for (const r of rows) counts[r.slug] = Number(r.count);
        return counts;
      },
    );
  });
}
