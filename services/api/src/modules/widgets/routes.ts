// /widgets/* — server-side proxy for Oddin Disir widget URL endpoints.
//
// Routes (all GET, public — widgets are visible to anonymous bettors):
//   GET /widgets/match/:matchId/prematch
//        ?theme=dark|light&tab=teams|players|tournament|stats|ranking
//        &timeframe=ONE_MONTH|TWO_MONTHS|THREE_MONTHS&allowClose=bool
//        &language=en
//   GET /widgets/tournament/:tournamentId/prematch
//        ?theme=&allowClose=&language=
//   GET /widgets/match/:matchId/live
//        ?theme=&language=
//
// Each one returns `{ url, source }` — `url` is the value the iframe
// `src` should take; `source` is "issued" when api-disir handed it to
// us and "local" when we built it ourselves (below). The storefront
// reads only `url`.
//
// What this proxy is and is not protecting. The `x-brand-token` header
// is sent from here, but the SAME value comes back inside every URL
// Disir issues (`brandToken=`) and therefore sits in every visitor's
// iframe `src`; the widget's own data API also accepts it as
// `X-Api-Key`. It is a publishable client key in Oddin's model, exactly
// like the video api-key, not a secret this hop hides. What the proxy
// earns its place for: rotating the token without a storefront rebuild,
// the REST's 404 "entity not found" (the only signal that Disir has no
// data for a match, which lets the storefront render nothing instead of
// an empty widget), and — since 2026-09-16 — the local fallback.
//
// Local fallback (DISIR_LOCAL_URL_FALLBACK, default on): api-disir mints
// no token; it returns a deterministic URL whose every parameter we
// already hold (see disir-url.ts). When the REST is unreachable, times
// out, answers 5xx / 401 or returns a body that is not `{url}`, the same
// URL is built here from `matches` / `competitors` / `tournaments`
// `provider_urn` plus a per-sport table that the REST's own issued URLs
// keep teaching while it is up. A 404 never falls back: that is data
// absence, not an outage. Verified from a real browser framed by
// oddzilla.cc that hand-built match, scoreboard and tournament URLs
// render identically to issued ones.
//
// Caching: `cachedSwr`, 120 s fresh then up to 6 h stale. Widget URLs
// do not expire — nothing in them is time-bound except a cache-buster —
// so a URL issued before an outage keeps serving through it, and the
// background refresh picks the REST back up the moment it answers.
//
// When DISIR_BRAND_TOKEN is empty the routes 503 with `widget_disabled`
// — the storefront skips rendering. Same shape as the wallet-watcher
// degrades-when-creds-absent pattern used elsewhere in the codebase.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadEnv } from "@oddzilla/config";
import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { categories, competitors, matches, sports, tournaments } from "@oddzilla/db";
import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../lib/errors.js";
import { cachedSwr } from "../../lib/cache.js";
import {
  COMPETITOR_URN_RE,
  MATCH_URN_RE,
  TOURNAMENT_URN_RE,
  buildMatchWidgetUrl,
  buildScoreboardWidgetUrl,
  buildTournamentWidgetUrl,
  inspectIssuedUrl,
  parseLearnedSegment,
  parseSportParams,
  reasonAllowsLocalFallback,
  staticSegment,
  staticSportParams,
  type DisirEnv,
  type DisirSportParams,
  type IssuerFailureReason,
} from "./disir-url.js";

// Match the doc table for prematch — esports vs eSims accept different
// timeframes/tabs. The proxy passes whatever the client sends; Disir
// returns its own 405 if the combo is invalid for the match's sport.
//
// Theme is restricted to the documented Disir values. The frontend
// only emits "dark" / "light" today; "auto" is reserved. Previously a
// free-form string up to 64 chars, which let an attacker flood the
// per-query Redis cache with garbage variants.
const themeSchema = z.enum(["dark", "light", "auto"]).optional();
const languageSchema = z
  .string()
  .regex(/^[a-z]{2}$/, "language must be a 2-letter ISO 639-1 code")
  .optional();
const allowCloseSchema = z
  .preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean())
  .optional();

// Restrict tab/timeframe to Disir's documented enum values. Previously
// these were free-form strings; the proxy keys its Redis cache on the
// query string, so unbounded values let an attacker flood the cache.
const prematchMatchQuery = z.object({
  theme: themeSchema,
  language: languageSchema,
  allowClose: allowCloseSchema,
  tab: z.enum(["teams", "players", "tournament", "stats", "ranking"]).optional(),
  timeframe: z.enum(["ONE_MONTH", "TWO_MONTHS", "THREE_MONTHS"]).optional(),
});

const prematchTournamentQuery = z.object({
  theme: themeSchema,
  language: languageSchema,
  allowClose: allowCloseSchema,
});

const liveMatchQuery = z.object({
  theme: themeSchema,
  language: languageSchema,
});

interface DisirOk {
  url: string;
}

interface DisirErr {
  code: number;
  message?: string;
}

// Fresh window: unchanged from the original 120 s hard TTL. Stale
// window: long enough to ride out a multi-hour api-disir outage on URLs
// already issued; a key that outlives it is a cold miss and the local
// builder takes over. Production Redis is allkeys-lru, so either can be
// evicted early — that only costs a rebuild.
const FRESH_SECONDS = 120;
const STALE_SECONDS = 6 * 3600;
// Learned per-sport constants (see disir-url.ts `inspectIssuedUrl`).
const LEARNED_SPORT_TTL_SECONDS = 30 * 24 * 3600;

interface ResolvedWidgetUrl {
  url: string;
  source: "issued" | "local";
}

type IssueResult =
  | { ok: true; url: string }
  | { ok: false; reason: IssuerFailureReason; status?: number; message?: string };

// One REST call to api-disir, classified rather than thrown so the
// caller can decide whether the failure is one the local builder may
// cover. 8 s upstream budget — Disir is regional EU, p99 well under.
async function issueFromDisir(
  app: FastifyInstance,
  url: string,
  brandToken: string,
): Promise<IssueResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-brand-token": brandToken,
      },
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    app.log.warn({ err, url }, aborted ? "disir upstream timed out" : "disir upstream fetch failed");
    return { ok: false, reason: aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let body: DisirErr | null = null;
    try {
      body = (await res.json()) as DisirErr;
    } catch {
      // ignore — non-JSON 5xx
    }
    if (res.status === 401) return { ok: false, reason: "unauthorized", status: 401 };
    if (res.status === 404) {
      return { ok: false, reason: "not_found", status: 404, message: body?.message };
    }
    if (res.status === 405) {
      return { ok: false, reason: "invalid_params", status: 405, message: body?.message };
    }
    return { ok: false, reason: "upstream_error", status: res.status };
  }

  let payload: DisirOk;
  try {
    payload = (await res.json()) as DisirOk;
  } catch {
    return { ok: false, reason: "malformed", status: res.status };
  }
  if (!payload.url || typeof payload.url !== "string") {
    return { ok: false, reason: "missing_url", status: res.status };
  }
  return { ok: true, url: payload.url };
}

// Pass through 401/404/405 with the stable codes the frontend branches
// on; everything else is a 503 with a code that names what went wrong.
function issueFailureToError(failure: Extract<IssueResult, { ok: false }>): Error {
  switch (failure.reason) {
    case "unauthorized":
      return new ServiceUnavailableError(
        "Widget provider rejected our credentials",
        "widget_provider_unauthorized",
      );
    case "not_found":
      return new NotFoundError(
        failure.message ?? "Widget not available for this resource",
        "widget_not_available",
      );
    case "invalid_params":
      return new BadRequestError(
        failure.message ?? "Invalid widget parameters",
        "widget_invalid_parameters",
      );
    case "network":
    case "timeout":
      return new ServiceUnavailableError(
        "Widget provider unavailable",
        "widget_provider_unavailable",
      );
    case "malformed":
      return new ServiceUnavailableError(
        "Widget provider returned malformed response",
        "widget_provider_malformed",
      );
    case "missing_url":
      return new ServiceUnavailableError(
        "Widget provider returned no URL",
        "widget_provider_missing_url",
      );
    case "upstream_error":
      return new ServiceUnavailableError("Widget provider error", "widget_provider_error");
  }
}

interface ResolveArgs {
  cacheKey: string;
  // The REST call.
  issue: () => Promise<IssueResult>;
  // Builds the same URL from our own data; null when a precondition is
  // missing (no competitor URN, unknown sport) and the caller should
  // surface the upstream failure as before.
  fallback: (() => Promise<string | null>) | null;
  // Runs after a successful issue; used to learn per-sport constants.
  onIssued?: (url: string) => Promise<void>;
  log: Record<string, string>;
}

async function resolveWidgetUrl(
  app: FastifyInstance,
  args: ResolveArgs,
): Promise<ResolvedWidgetUrl> {
  return cachedSwr<ResolvedWidgetUrl>(
    app.redis,
    args.cacheKey,
    FRESH_SECONDS,
    STALE_SECONDS,
    async () => {
      const issued = await args.issue();
      if (issued.ok) {
        if (args.onIssued) {
          await args
            .onIssued(issued.url)
            .catch((err: unknown) => app.log.debug({ err }, "disir learn step failed"));
        }
        return { url: issued.url, source: "issued" };
      }
      if (issued.reason === "unauthorized") {
        app.log.error({ ...args.log }, "disir brand token rejected");
      }
      if (args.fallback && reasonAllowsLocalFallback(issued.reason)) {
        let local: string | null = null;
        try {
          local = await args.fallback();
        } catch (err) {
          app.log.warn({ err, ...args.log }, "disir local url fallback threw");
        }
        if (local) {
          app.log.warn(
            { reason: issued.reason, status: issued.status, ...args.log },
            "disir issuer unavailable, serving locally built widget url",
          );
          return { url: local, source: "local" };
        }
      }
      throw issueFailureToError(issued);
    },
  );
}

// ── Per-sport constants: learned from issued URLs, floored by the table ─
//
// Two records per (env, sport slug). The SEGMENT is learned from every
// kind of issue — a live scoreboard for a sport with no prematch widget
// (ecricket) is covered this way. The PREMATCH constants are learned
// only from a match issue whose request overrode neither tab nor
// timeframe. Both fall back to the static table in disir-url.ts.

function learnedSegmentKey(env: DisirEnv, sportSlug: string): string {
  return `disir:segment:v1:${env}:${sportSlug}`;
}

function learnedPrematchKey(env: DisirEnv, sportSlug: string): string {
  return `disir:prematch:v1:${env}:${sportSlug}`;
}

async function resolveSegment(
  app: FastifyInstance,
  env: DisirEnv,
  sportSlug: string,
): Promise<string | null> {
  const raw = await app.redis.get(learnedSegmentKey(env, sportSlug)).catch(() => null);
  return parseLearnedSegment(raw) ?? staticSegment(sportSlug);
}

async function resolveSportParams(
  app: FastifyInstance,
  env: DisirEnv,
  sportSlug: string,
): Promise<DisirSportParams | null> {
  const raw = await app.redis.get(learnedPrematchKey(env, sportSlug)).catch(() => null);
  return parseSportParams(raw) ?? staticSportParams(sportSlug);
}

async function learnFromIssuedUrl(
  app: FastifyInstance,
  env: DisirEnv,
  sportSlug: string,
  issuedUrl: string,
  opts: { requestHadTab: boolean; requestHadTimeframe: boolean },
): Promise<void> {
  const facts = inspectIssuedUrl(issuedUrl, opts);
  if (!facts) return;
  const writes: Array<Promise<unknown>> = [
    app.redis.set(
      learnedSegmentKey(env, sportSlug),
      facts.segment,
      "EX",
      LEARNED_SPORT_TTL_SECONDS,
    ),
  ];
  if (facts.sport) {
    writes.push(
      app.redis.set(
        learnedPrematchKey(env, sportSlug),
        JSON.stringify(facts.sport),
        "EX",
        LEARNED_SPORT_TTL_SECONDS,
      ),
    );
  }
  await Promise.all(writes).catch(() => null);
}

const NO_OVERRIDES = { requestHadTab: false, requestHadTimeframe: false };

// ── DB context the local builder needs ─────────────────────────────────

const homeCompetitor = alias(competitors, "disir_home_competitor");
const awayCompetitor = alias(competitors, "disir_away_competitor");

interface MatchWidgetContext {
  sportSlug: string;
  matchUrn: string;
  homeTeamUrn: string | null;
  awayTeamUrn: string | null;
  tournamentUrn: string;
}

function firstCompetitorUrn(...candidates: Array<string | null>): string | null {
  for (const c of candidates) {
    if (c && COMPETITOR_URN_RE.test(c)) return c;
  }
  return null;
}

// `matches.home_team_urn` / `away_team_urn` are what the fixture carried;
// the competitors rows are the auto-mapper's resolution of the same. Take
// whichever holds a well-formed URN — the placeholder path can leave one
// side empty, and a URL missing a team id renders an error state, so the
// caller refuses to build when either is null.
async function loadMatchWidgetContext(
  app: FastifyInstance,
  matchUrn: string,
): Promise<MatchWidgetContext | null> {
  const rows = await app.db
    .select({
      matchUrn: matches.providerUrn,
      homeTeamUrn: matches.homeTeamUrn,
      awayTeamUrn: matches.awayTeamUrn,
      homeCompetitorUrn: homeCompetitor.providerUrn,
      awayCompetitorUrn: awayCompetitor.providerUrn,
      tournamentUrn: tournaments.providerUrn,
      sportSlug: sports.slug,
    })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .innerJoin(categories, eq(categories.id, tournaments.categoryId))
    .innerJoin(sports, eq(sports.id, categories.sportId))
    .leftJoin(homeCompetitor, eq(homeCompetitor.id, matches.homeCompetitorId))
    .leftJoin(awayCompetitor, eq(awayCompetitor.id, matches.awayCompetitorId))
    .where(eq(matches.providerUrn, matchUrn))
    .limit(1);
  const r = rows[0];
  if (!r || !TOURNAMENT_URN_RE.test(r.tournamentUrn)) return null;
  return {
    sportSlug: r.sportSlug,
    matchUrn: r.matchUrn,
    homeTeamUrn: firstCompetitorUrn(r.homeTeamUrn, r.homeCompetitorUrn),
    awayTeamUrn: firstCompetitorUrn(r.awayTeamUrn, r.awayCompetitorUrn),
    tournamentUrn: r.tournamentUrn,
  };
}

async function loadTournamentSportSlug(
  app: FastifyInstance,
  tournamentUrn: string,
): Promise<string | null> {
  const rows = await app.db
    .select({ sportSlug: sports.slug })
    .from(tournaments)
    .innerJoin(categories, eq(categories.id, tournaments.categoryId))
    .innerJoin(sports, eq(sports.id, categories.sportId))
    .where(eq(tournaments.providerUrn, tournamentUrn))
    .limit(1);
  return rows[0]?.sportSlug ?? null;
}

// Memoise a per-request loader so the learn step and the fallback share
// one DB round trip when both run on the same cold load.
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

function appendIfPresent(
  qs: URLSearchParams,
  key: string,
  value: string | boolean | undefined,
): void {
  if (value === undefined) return;
  if (typeof value === "boolean") {
    qs.append(key, value ? "true" : "false");
  } else {
    qs.append(key, value);
  }
}

const widgetReadRateLimit = {
  rateLimit: { max: 60, timeWindow: "1 minute" },
};

export default async function widgetsRoutes(app: FastifyInstance) {
  const env = loadEnv();
  const baseUrl = env.DISIR_BASE_URL.replace(/\/$/, "");
  const disirEnv: DisirEnv = env.DISIR_ENV;
  const fallbackEnabled = env.DISIR_LOCAL_URL_FALLBACK === "true";

  function requireToken(): string {
    if (!env.DISIR_BRAND_TOKEN) {
      throw new ServiceUnavailableError(
        "Widgets are not configured for this environment",
        "widget_disabled",
      );
    }
    return env.DISIR_BRAND_TOKEN;
  }

  // ── Prematch: match-level (Team / Player / Tournament tabs) ────────────
  app.get<{
    Params: { matchId: string };
    Querystring: z.input<typeof prematchMatchQuery>;
  }>(
    "/widgets/match/:matchId/prematch",
    { config: widgetReadRateLimit },
    async (req) => {
      const token = requireToken();
      // Resolve the bare numeric/uuid form to the `od:match:N` URN Disir
      // expects. We accept both shapes so the frontend can pass either
      // the numeric matches.id row or the provider URN directly.
      const urn = await resolveMatchUrn(app, req.params.matchId);
      const q = prematchMatchQuery.parse(req.query);

      const qs = new URLSearchParams();
      appendIfPresent(qs, "theme", q.theme);
      appendIfPresent(qs, "language", q.language);
      appendIfPresent(qs, "allowClose", q.allowClose);
      appendIfPresent(qs, "tab", q.tab);
      appendIfPresent(qs, "timeframe", q.timeframe);
      const query = qs.toString();

      const ctx = once(() => loadMatchWidgetContext(app, urn));
      const learnOpts = {
        requestHadTab: q.tab !== undefined,
        requestHadTimeframe: q.timeframe !== undefined,
      };

      return resolveWidgetUrl(app, {
        cacheKey: `disir:url:v2:prematch:match:${disirEnv}:${urn}:${query}`,
        issue: () =>
          issueFromDisir(
            app,
            `${baseUrl}/statistics/${disirEnv}/match/${urn}${query ? `?${query}` : ""}`,
            token,
          ),
        onIssued: async (url) => {
          const c = await ctx();
          if (c) await learnFromIssuedUrl(app, disirEnv, c.sportSlug, url, learnOpts);
        },
        fallback: fallbackEnabled
          ? async () => {
              const c = await ctx();
              if (!c || !c.homeTeamUrn || !c.awayTeamUrn) return null;
              const sport = await resolveSportParams(app, disirEnv, c.sportSlug);
              if (!sport) return null;
              return buildMatchWidgetUrl({
                env: disirEnv,
                brandToken: token,
                sport,
                matchUrn: c.matchUrn,
                homeTeamUrn: c.homeTeamUrn,
                awayTeamUrn: c.awayTeamUrn,
                tournamentUrn: c.tournamentUrn,
                theme: q.theme,
                language: q.language,
                allowClose: q.allowClose,
                tab: q.tab,
                timeframe: q.timeframe,
              });
            }
          : null,
        log: { widget: "prematch-match", urn },
      });
    },
  );

  // ── Prematch: tournament-level (standings + roster) ────────────────────
  app.get<{
    Params: { tournamentId: string };
    Querystring: z.input<typeof prematchTournamentQuery>;
  }>(
    "/widgets/tournament/:tournamentId/prematch",
    { config: widgetReadRateLimit },
    async (req) => {
      const token = requireToken();
      const urn = await resolveTournamentUrn(app, req.params.tournamentId);
      const q = prematchTournamentQuery.parse(req.query);

      const qs = new URLSearchParams();
      appendIfPresent(qs, "theme", q.theme);
      appendIfPresent(qs, "language", q.language);
      appendIfPresent(qs, "allowClose", q.allowClose);
      const query = qs.toString();
      const sportSlug = once(() => loadTournamentSportSlug(app, urn));

      return resolveWidgetUrl(app, {
        cacheKey: `disir:url:v2:prematch:tour:${disirEnv}:${urn}:${query}`,
        issue: () =>
          issueFromDisir(
            app,
            `${baseUrl}/statistics/${disirEnv}/tournament/${urn}${query ? `?${query}` : ""}`,
            token,
          ),
        onIssued: async (url) => {
          const slug = await sportSlug();
          if (slug) await learnFromIssuedUrl(app, disirEnv, slug, url, NO_OVERRIDES);
        },
        fallback: fallbackEnabled
          ? async () => {
              const slug = await sportSlug();
              if (!slug) return null;
              const segment = await resolveSegment(app, disirEnv, slug);
              if (!segment) return null;
              return buildTournamentWidgetUrl({
                env: disirEnv,
                brandToken: token,
                segment,
                tournamentUrn: urn,
                theme: q.theme,
                language: q.language,
                allowClose: q.allowClose,
              });
            }
          : null,
        log: { widget: "prematch-tournament", urn },
      });
    },
  );

  // ── Live: scoreboard for an in-progress match ─────────────────────────
  app.get<{
    Params: { matchId: string };
    Querystring: z.input<typeof liveMatchQuery>;
  }>(
    "/widgets/match/:matchId/live",
    { config: widgetReadRateLimit },
    async (req) => {
      const token = requireToken();
      const urn = await resolveMatchUrn(app, req.params.matchId);
      const q = liveMatchQuery.parse(req.query);

      const qs = new URLSearchParams();
      appendIfPresent(qs, "theme", q.theme);
      appendIfPresent(qs, "language", q.language);
      const query = qs.toString();
      const ctx = once(() => loadMatchWidgetContext(app, urn));

      return resolveWidgetUrl(app, {
        cacheKey: `disir:url:v2:live:match:${disirEnv}:${urn}:${query}`,
        issue: () =>
          issueFromDisir(
            app,
            `${baseUrl}/live/${disirEnv}/scoreboard/${urn}${query ? `?${query}` : ""}`,
            token,
          ),
        onIssued: async (url) => {
          const c = await ctx();
          if (c) await learnFromIssuedUrl(app, disirEnv, c.sportSlug, url, NO_OVERRIDES);
        },
        fallback: fallbackEnabled
          ? async () => {
              const c = await ctx();
              if (!c) return null;
              const segment = await resolveSegment(app, disirEnv, c.sportSlug);
              if (!segment) return null;
              return buildScoreboardWidgetUrl({
                env: disirEnv,
                brandToken: token,
                segment,
                matchUrn: c.matchUrn,
                theme: q.theme,
                language: q.language,
              });
            }
          : null,
        log: { widget: "live-scoreboard", urn },
      });
    },
  );
}

// Disir's path parser does NOT decode percent-escaped colons — passing
// `od%3Amatch%3AN` returns 405. So URNs must be interpolated literally
// into the upstream path. These regexes guard against any character
// outside the legitimate URN shape so the literal interpolation can't
// be turned into path traversal or a host-swap with a crafted input.
// (The regexes themselves live in disir-url.ts so the local builder
// applies the same shapes.)

// resolveMatchUrn accepts either a numeric matches.id (the form the
// catalog routes return on the storefront) or a provider URN
// (`od:match:N`) and yields the URN — the only form Disir accepts.
async function resolveMatchUrn(
  app: FastifyInstance,
  matchIdOrUrn: string,
): Promise<string> {
  if (matchIdOrUrn.startsWith("od:match:")) {
    if (!MATCH_URN_RE.test(matchIdOrUrn)) {
      throw new BadRequestError(
        "Match URN must match od:match:<digits>",
        "invalid_match_id",
      );
    }
    return matchIdOrUrn;
  }
  let asBigint: bigint;
  try {
    asBigint = BigInt(matchIdOrUrn);
  } catch {
    throw new BadRequestError(
      "Match id must be a positive integer or od:match URN",
      "invalid_match_id",
    );
  }
  if (asBigint <= 0n) {
    throw new BadRequestError(
      "Match id must be a positive integer or od:match URN",
      "invalid_match_id",
    );
  }
  const row = await app.db
    .select({ urn: matches.providerUrn })
    .from(matches)
    .where(eq(matches.id, asBigint))
    .limit(1);
  const urn = row[0]?.urn ?? null;
  if (!urn) throw new NotFoundError("Match not found", "match_not_found");
  if (!MATCH_URN_RE.test(urn)) {
    // Defence in depth: Fonbet (`fb:`), custom (`cu:`) and demo rows share
    // this table, and none of them has a Disir counterpart. Bail out
    // before interpolating anything into the upstream path.
    throw new NotFoundError("Match URN unsupported by widget proxy", "match_urn_unsupported");
  }
  return urn;
}

async function resolveTournamentUrn(
  app: FastifyInstance,
  tournamentIdOrUrn: string,
): Promise<string> {
  if (tournamentIdOrUrn.startsWith("od:tournament:")) {
    if (!TOURNAMENT_URN_RE.test(tournamentIdOrUrn)) {
      throw new BadRequestError(
        "Tournament URN must match od:tournament:<digits>",
        "invalid_tournament_id",
      );
    }
    return tournamentIdOrUrn;
  }
  const numeric = Number.parseInt(tournamentIdOrUrn, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new BadRequestError(
      "Tournament id must be a positive integer or od:tournament URN",
      "invalid_tournament_id",
    );
  }
  const row = await app.db
    .select({ urn: tournaments.providerUrn })
    .from(tournaments)
    .where(eq(tournaments.id, numeric))
    .limit(1);
  const urn = row[0]?.urn ?? null;
  if (urn && !TOURNAMENT_URN_RE.test(urn)) {
    throw new NotFoundError(
      "Tournament URN unsupported by widget proxy",
      "tournament_urn_unsupported",
    );
  }
  if (!urn) throw new NotFoundError("Tournament not found", "tournament_not_found");
  return urn;
}
