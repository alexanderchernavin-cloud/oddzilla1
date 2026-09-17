// Local construction of Oddin Disir widget URLs.
//
// Measured on 2026-09-16 (see docs/ODDIN.md "Disir widgets"): the REST
// endpoint our /widgets/* proxy calls (`api-disir.oddin.gg`) mints no
// token and signs nothing. It answers with a fully deterministic URL on
// the widget host, whose every parameter we already hold:
//
//   https://disir.integration.oddin.gg/csgo/match
//     ?id=base64("match/od:match:N")
//     &homeTeamId=base64("team/od:competitor:N")
//     &awayTeamId=base64("team/od:competitor:N")
//     &tournamentId=base64("tournament/od:tournament:N")
//     &brandToken=<DISIR_BRAND_TOKEN>
//     &availableData=tournament&availableData=teams&availableData=players
//     &darkMode=true&theme=dark&lang=en&layout=default
//     &timeframe=THREE_MONTHS&type=teams&t=<random>
//
// The URNs are `matches.provider_urn`, `matches.home_team_urn` /
// `away_team_urn` (or `competitors.provider_urn`) and
// `tournaments.provider_urn`; the brand token is our own env value; `t`
// is a cache-buster; the rest is a per-sport constant. Hand-built URLs
// that the REST never issued render on the storefront exactly like
// issued ones (verified from a real browser framed by oddzilla.cc for a
// match widget, a live scoreboard, a tournament widget and a light-theme
// players tab). So when api-disir is down, the proxy can build the URL
// itself — that is the fallback this module exists for.
//
// What the REST adds and this module cannot: it answers 404 "entity not
// found" when Disir has no data for a match, and it knows the per-sport
// constants. The first is why the fallback only runs on failures that
// mean "the issuer is down", never on a 404. The second is why
// DISIR_SPORT_PARAMS exists and why `inspectIssuedUrl` learns the same
// facts from every URL the REST does issue while it is up.
//
// Two things about the widget host, both load-bearing for the design:
// the brand token is REQUIRED in the URL (dropping it is a 403), and it
// is the same value as DISIR_BRAND_TOKEN — so the token is in every
// visitor's iframe `src` already and is a publishable client key in
// Oddin's model, not a secret this proxy protects. Omitting
// `availableData` and the team ids renders "Something went wrong", so a
// match widget is only built when every id is present.
//
// Pure: no Fastify, no DB, no Redis. Everything here is unit-tested in
// disir-url.test.ts against URLs captured from the REST, byte for byte
// except the cache-buster.

export type DisirEnv = "integration" | "main";
export type DisirTheme = "dark" | "light" | "auto";
export type DisirWidgetKind = "match" | "scoreboard" | "tournament";

// Per-sport constants. `segment` is the widget host's path prefix (Disir
// still calls CS2 "csgo" and the eSims "rush_*") and is all a live
// scoreboard or a tournament widget needs. The prematch match widget
// additionally needs `availableData` (its tab set) and the `timeframe` /
// `type` defaults the REST picks when the caller passes neither
// `timeframe` nor `tab`.
export interface DisirPrematchParams {
  availableData: readonly string[];
  timeframe: string;
  type: string;
}

// What `buildMatchWidgetUrl` takes: a segment plus the prematch set.
export interface DisirSportParams extends DisirPrematchParams {
  segment: string;
}

// One row of the table: every sport Disir serves at all has a segment;
// only those with a prematch widget have `prematch`. eCricket is the
// case that forces the split — it has a live scoreboard and no prematch
// widget, so a table keyed on prematch constants alone could never
// cover its live widget.
export interface DisirSportEntry {
  segment: string;
  prematch: DisirPrematchParams | null;
}

// Keyed by OUR sport slug. Read off the REST on 2026-09-16 for every
// esport we carry — the prematch endpoint for the six that have one,
// the live scoreboard endpoint for cs2 / efootball / ebasketball /
// ecricket (dota2, lol and valorant had no live match answering at the
// time; their scoreboard segment is taken to equal the prematch one, as
// it does for every sport where both were observed). The slugs missing
// here (crossfire, etouchdown, kog, ml, r6, rocketleague) answered 404
// "entity not found" on both endpoints for every match tried, so there
// is nothing to build for them.
const ESPORT_PREMATCH: DisirPrematchParams = {
  availableData: ["tournament", "teams", "players"],
  timeframe: "THREE_MONTHS",
  type: "teams",
};
const ESIM_PREMATCH: DisirPrematchParams = {
  availableData: ["stats", "ranking"],
  timeframe: "TWO_MONTHS",
  type: "stats",
};

export const DISIR_SPORTS: Readonly<Record<string, DisirSportEntry>> = {
  cs2: { segment: "csgo", prematch: ESPORT_PREMATCH },
  dota2: { segment: "dota2", prematch: ESPORT_PREMATCH },
  lol: { segment: "lol", prematch: ESPORT_PREMATCH },
  valorant: { segment: "valorant", prematch: ESPORT_PREMATCH },
  efootball: { segment: "rush_soccer", prematch: ESIM_PREMATCH },
  ebasketball: { segment: "rush_basketball", prematch: ESIM_PREMATCH },
  ecricket: { segment: "rush_cricket", prematch: null },
};

// The prematch view of the table, in the shape the match builder takes.
export const DISIR_SPORT_PARAMS: Readonly<Record<string, DisirSportParams>> =
  Object.fromEntries(
    Object.entries(DISIR_SPORTS)
      .filter(([, e]) => e.prematch !== null)
      .map(([slug, e]) => [slug, { segment: e.segment, ...e.prematch! }]),
  );

export function staticSegment(sportSlug: string): string | null {
  return DISIR_SPORTS[sportSlug]?.segment ?? null;
}

export function staticSportParams(sportSlug: string): DisirSportParams | null {
  return DISIR_SPORT_PARAMS[sportSlug] ?? null;
}

const SEGMENT_RE = /^[a-z0-9_]+$/;

// The two widget hosts. BOTH check the Referer's registrable domain
// against a per-token registry and refuse a missing Referer (measured
// with a fresh cache-buster per request — CloudFront caches a 200 and
// will serve it to any referer for minutes, which is what made the
// integration host look open on first measurement). Our token is
// registered for oddzilla.cc on the integration host only, and prod runs
// DISIR_ENV=integration.
export function disirWidgetHost(env: DisirEnv): string {
  return env === "main"
    ? "https://disir.oddin.gg"
    : "https://disir.integration.oddin.gg";
}

// Disir ids are plain base64 of `<kind>/<urn>` — the same id shape
// Bifrost uses (docs/BIFROST_BACKUP_FEED.md "Ids are Oddin URNs").
export function encodeDisirId(
  kind: "match" | "team" | "tournament",
  urn: string,
): string {
  return Buffer.from(`${kind}/${urn}`, "utf8").toString("base64");
}

// The REST's `t` is a random uint32 — a cache-buster, nothing else.
export function randomCacheBuster(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}

interface CommonInput {
  env: DisirEnv;
  brandToken: string;
  // "auto" is accepted by the proxy's schema but the storefront never
  // sends it; the REST's own default is dark, so auto maps to dark.
  theme?: DisirTheme;
  language?: string;
  // Fixed only by tests; callers leave it undefined.
  t?: number;
}

export interface MatchWidgetInput extends CommonInput {
  sport: DisirSportParams;
  matchUrn: string;
  homeTeamUrn: string;
  awayTeamUrn: string;
  tournamentUrn: string;
  allowClose?: boolean;
  // Caller overrides for the REST's `tab` and `timeframe` query params.
  tab?: string;
  timeframe?: string;
}

export interface TournamentWidgetInput extends CommonInput {
  segment: string;
  tournamentUrn: string;
  allowClose?: boolean;
}

export interface ScoreboardWidgetInput extends CommonInput {
  segment: string;
  matchUrn: string;
}

function applyCommon(
  qs: URLSearchParams,
  input: CommonInput,
  layout: string,
): void {
  const light = input.theme === "light";
  qs.set("brandToken", input.brandToken);
  qs.set("darkMode", light ? "false" : "true");
  qs.set("lang", input.language ?? "en");
  qs.set("layout", layout);
  qs.set("t", String(input.t ?? randomCacheBuster()));
  qs.set("theme", light ? "light" : "dark");
}

// The REST emits its query keys in code-unit order (allowClose,
// availableData, awayTeamId, brandToken, ...). URLSearchParams.sort() is
// that order and is stable, so the repeated availableData keys keep the
// sequence the sport table gives them.
function finish(
  env: DisirEnv,
  segment: string,
  kind: DisirWidgetKind,
  qs: URLSearchParams,
): string {
  qs.sort();
  return `${disirWidgetHost(env)}/${segment}/${kind}?${qs.toString()}`;
}

export function buildMatchWidgetUrl(input: MatchWidgetInput): string {
  const qs = new URLSearchParams();
  if (input.allowClose) qs.set("allowClose", "true");
  for (const tab of input.sport.availableData) qs.append("availableData", tab);
  qs.set("awayTeamId", encodeDisirId("team", input.awayTeamUrn));
  qs.set("homeTeamId", encodeDisirId("team", input.homeTeamUrn));
  qs.set("id", encodeDisirId("match", input.matchUrn));
  qs.set("tournamentId", encodeDisirId("tournament", input.tournamentUrn));
  qs.set("timeframe", input.timeframe ?? input.sport.timeframe);
  qs.set("type", input.tab ?? input.sport.type);
  applyCommon(qs, input, "default");
  return finish(input.env, input.sport.segment, "match", qs);
}

export function buildTournamentWidgetUrl(input: TournamentWidgetInput): string {
  const qs = new URLSearchParams();
  if (input.allowClose) qs.set("allowClose", "true");
  qs.append("availableData", "tournament");
  qs.set("id", encodeDisirId("tournament", input.tournamentUrn));
  applyCommon(qs, input, "default");
  return finish(input.env, input.segment, "tournament", qs);
}

// The scoreboard URL carries an EMPTY `layout=` — that is what the REST
// issues, and it is kept rather than tidied because the widget host is
// the only party that knows whether the key's presence matters.
export function buildScoreboardWidgetUrl(input: ScoreboardWidgetInput): string {
  const qs = new URLSearchParams();
  qs.set("id", encodeDisirId("match", input.matchUrn));
  applyCommon(qs, input, "");
  return finish(input.env, input.segment, "scoreboard", qs);
}

// ── Learning from issued URLs ──────────────────────────────────────────
//
// While the REST is up, every URL it issues restates the per-sport
// constants. The proxy records them per (env, sport slug) so the static
// table above is a floor, not the ceiling: if Oddin renames a segment,
// adds a live scoreboard for a sport that has none today, or changes a
// default timeframe, the next issued URL teaches the fallback. Every
// kind of issue teaches the SEGMENT (a scoreboard issue is how a
// live-only sport gets covered); only a match issue whose request passed
// neither `tab` nor `timeframe` teaches the prematch constants — the
// REST echoes a caller's `tab` back as `type`, and learning that would
// turn one bettor's Players tab into everyone's default.

export interface IssuedUrlFacts {
  kind: DisirWidgetKind;
  segment: string;
  // Present only for a match widget issued with no tab / timeframe
  // override and carrying every field the table needs.
  sport: DisirSportParams | null;
}

const KINDS: ReadonlySet<string> = new Set<DisirWidgetKind>([
  "match",
  "scoreboard",
  "tournament",
]);

export function inspectIssuedUrl(
  url: string,
  opts: { requestHadTab: boolean; requestHadTimeframe: boolean },
): IssuedUrlFacts | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const parts = parsed.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length !== 2) return null;
  const [segment, kind] = parts;
  if (!segment || !kind || !KINDS.has(kind) || !SEGMENT_RE.test(segment)) {
    return null;
  }
  let sport: DisirSportParams | null = null;
  if (kind === "match" && !opts.requestHadTab && !opts.requestHadTimeframe) {
    const availableData = parsed.searchParams.getAll("availableData");
    const timeframe = parsed.searchParams.get("timeframe");
    const type = parsed.searchParams.get("type");
    if (availableData.length > 0 && timeframe && type) {
      sport = { segment, availableData, timeframe, type };
    }
  }
  return { kind: kind as DisirWidgetKind, segment, sport };
}

// Shape checks for learned records read back from Redis: production
// Redis is allkeys-lru, so a key may be missing, and a corrupt or
// foreign value must read as "nothing learned" rather than throw.
export function parseLearnedSegment(raw: string | null): string | null {
  if (raw === null) return null;
  return SEGMENT_RE.test(raw) ? raw : null;
}

export function parseSportParams(raw: string | null): DisirSportParams | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<DisirSportParams> | null;
    if (
      v &&
      typeof v.segment === "string" &&
      SEGMENT_RE.test(v.segment) &&
      Array.isArray(v.availableData) &&
      v.availableData.length > 0 &&
      v.availableData.every((x) => typeof x === "string") &&
      typeof v.timeframe === "string" &&
      typeof v.type === "string"
    ) {
      return {
        segment: v.segment,
        availableData: v.availableData,
        timeframe: v.timeframe,
        type: v.type,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

// ── Which REST failures the fallback may cover ─────────────────────────
//
// `not_found` is Disir saying "no data for this match" — a hand-built
// URL would render the widget's own empty state where the storefront
// today renders nothing, so it is never covered. `invalid_params` is our
// bug, not their outage. Everything else — the socket refused, the 8 s
// budget spent, a 5xx, a body that is not the documented `{url}` — is
// the issuer being unavailable, which is exactly the case the fallback
// exists for. `unauthorized` was covered too until 2026-09-17, on the
// reasoning that a token store that cannot answer looks like a 401 from
// the outside. Measured that morning, the opposite case is what happens:
// api-disir and the widget's own data API share one auth verdict (both
// 401 for our token, both 200 for MaxBet's at the same minute), the
// widget host serves the app shell on the domain registry alone, and a
// hand-built URL carrying a refused token therefore renders "Something
// went wrong" AFTER posting LOADED — which defeats the storefront's 20 s
// timeout and keeps it from its Bifrost fallback. A 401 is now surfaced
// as `widget_provider_unauthorized`, which is what the storefront falls
// back on (token-health.ts explains the record that short-circuits it).
export type IssuerFailureReason =
  | "network"
  | "timeout"
  | "unauthorized"
  | "not_found"
  | "invalid_params"
  | "upstream_error"
  | "malformed"
  | "missing_url";

export function reasonAllowsLocalFallback(reason: IssuerFailureReason): boolean {
  return reason !== "not_found" && reason !== "invalid_params" && reason !== "unauthorized";
}

// URN shapes the builder accepts. Every value is interpolated into a URL
// we then hand to a browser, so anything outside these shapes is refused
// rather than encoded — same defence the routes apply before they put a
// URN into the upstream REST path.
export const MATCH_URN_RE = /^od:match:\d+$/;
export const TOURNAMENT_URN_RE = /^od:tournament:\d+$/;
export const COMPETITOR_URN_RE = /^od:competitor:\d+$/;
