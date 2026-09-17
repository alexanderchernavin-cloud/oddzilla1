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
// Each one returns `{ url, source, token }` — `url` is the value the
// iframe `src` should take; `source` is "issued" when api-disir handed it
// to us and "local" when we built it ourselves (below); `token` is the
// brand-token slot that served it, "primary" or "backup". The storefront
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
// an empty widget), the local fallback and the token failover.
//
// Local fallback (DISIR_LOCAL_URL_FALLBACK, default on): api-disir mints
// no token; it returns a deterministic URL whose every parameter we
// already hold (see disir-url.ts). When the REST is unreachable, times
// out, answers 5xx or returns a body that is not `{url}`, the same URL
// is built here from `matches` / `competitors` / `tournaments`
// `provider_urn` plus a per-sport table that the REST's own issued URLs
// keep teaching while it is up. A 404 never falls back: that is data
// absence, not an outage. Neither does a 401 (since 2026-09-17): that
// is the TOKEN being refused, and a URL carrying a refused token loads
// a widget that then fails on its data API — see token-health.ts for
// the record that turns a refusal into a 401 the storefront can act on.
// Verified from a real browser framed by oddzilla.cc that hand-built
// match, scoreboard and tournament URLs render identically to issued
// ones.
//
// Token failover (DISIR_BACKUP_BRAND_TOKEN, see token-health.ts): the
// fallback above cannot help when the TOKEN is refused, because that
// check runs on Oddin's widget host as the iframe loads. A second token
// can. The slot in use is read per request from Redis, written by a
// periodic probe of the widget host and by a 401 from api-disir seen
// here, and is part of every cache key below so a switch never serves a
// URL of the dead token from cache.
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
  disirWidgetHost,
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
import {
  credentialsFor,
  markRefused,
  readHealth,
  readSlot,
  runProbeRound,
  verdictFor,
  writeSlot,
  type TokenConfig,
  type TokenCredentials,
} from "./token-health.js";
import { buildBifrostEmbed } from "./bifrost-embed.js";
import {
  assetUpstreamUrl,
  fetchWidgetAsset,
  fetchWidgetDocument,
  proxyContentSecurityPolicy,
  rewriteWidgetDocument,
} from "./disir-proxy.js";

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
// The token probe waits this long after boot so a restart under load does
// not spend its first seconds on a diagnostic.
const PROBE_BOOT_DELAY_MS = 15_000;

interface ResolvedWidgetUrl {
  url: string;
  source: "issued" | "local";
  token: TokenCredentials["slot"];
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

// What a route knows how to do with a given set of credentials. Built
// per (request, credentials) because the cache key, the upstream path
// and the local builder all depend on the token and its environment.
interface WidgetPlan {
  cacheKey: string;
  // The REST call.
  issue: () => Promise<IssueResult>;
  // Builds the same URL from our own data; null when a precondition is
  // missing (no competitor URN, unknown sport) and the caller should
  // surface the upstream failure as before.
  fallback: (() => Promise<string | null>) | null;
  // Runs after a successful issue; used to learn per-sport constants.
  onIssued?: (url: string) => Promise<void>;
}

interface ResolveContext {
  tokens: TokenConfig;
  // TTL of the "this token is refused" record a request-side 401 writes.
  healthTtlSeconds: number;
  log: Record<string, string>;
}

async function resolveWidgetUrl(
  app: FastifyInstance,
  ctx: ResolveContext,
  creds: TokenCredentials,
  plan: (creds: TokenCredentials) => WidgetPlan,
): Promise<ResolvedWidgetUrl> {
  // A token the probe (or an earlier request's 401) found refused by
  // Oddin's auth layer is not handed to a browser in any form — not from
  // the cache, not freshly issued, not built locally. The widget host
  // serves the app shell for it regardless (its check is the domain
  // registry), so a URL carrying it renders the widget's own "Something
  // went wrong" AFTER posting LOADED, and the storefront never reaches
  // its Bifrost fallback (measured 2026-09-17). Answering 401 here is
  // what gets it there. The record lapses on its own (token-health.ts),
  // and the probe clears it the round the token is accepted again.
  const health = await readHealth(app.redis);
  if (verdictFor(health, creds.slot) === "refused") {
    app.log.debug({ ...ctx.log, token: creds.slot }, "disir token known refused, not issuing");
    throw new ServiceUnavailableError(
      "Widget provider rejected our credentials",
      "widget_provider_unauthorized",
    );
  }

  const first = plan(creds);
  return cachedSwr<ResolvedWidgetUrl>(
    app.redis,
    first.cacheKey,
    FRESH_SECONDS,
    STALE_SECONDS,
    async () => {
      let active = creds;
      let p = first;
      let issued = await p.issue();

      // api-disir refusing the PRIMARY token is one of the two signals the
      // failover reads (token-health.ts). Retry at once with the backup
      // rather than waiting for the next probe; a success moves the slot.
      if (
        !issued.ok &&
        issued.reason === "unauthorized" &&
        active.slot === "primary" &&
        ctx.tokens.backup
      ) {
        app.log.error({ ...ctx.log }, "disir brand token rejected by api-disir");
        const backup = credentialsFor(ctx.tokens, "backup");
        const p2 = plan(backup);
        const retry = await p2.issue();
        if (retry.ok) {
          await writeSlot(app.redis, {
            slot: "backup",
            since: Date.now(),
            reason: "api-disir 401 on primary, backup issued",
          });
          app.log.warn({ ...ctx.log }, "disir token failover: switched to backup token after 401");
          active = backup;
          p = p2;
          issued = retry;
        }
      }

      if (issued.ok) {
        if (p.onIssued) {
          await p
            .onIssued(issued.url)
            .catch((err: unknown) => app.log.debug({ err }, "disir learn step failed"));
        }
        return { url: issued.url, source: "issued", token: active.slot };
      }
      if (issued.reason === "unauthorized") {
        app.log.error({ ...ctx.log, token: active.slot }, "disir brand token rejected");
        // Remember it, so the next request (and a cached URL carrying
        // this token) does not reach a browser before the probe runs.
        await markRefused(app.redis, active.slot, ctx.healthTtlSeconds);
      }
      if (p.fallback && reasonAllowsLocalFallback(issued.reason)) {
        let local: string | null = null;
        try {
          local = await p.fallback();
        } catch (err) {
          app.log.warn({ err, ...ctx.log }, "disir local url fallback threw");
        }
        if (local) {
          app.log.warn(
            { reason: issued.reason, status: issued.status, token: active.slot, ...ctx.log },
            "disir issuer unavailable, serving locally built widget url",
          );
          return { url: local, source: "local", token: active.slot };
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
  const fallbackEnabled = env.DISIR_LOCAL_URL_FALLBACK === "true";

  // Whitelisting-independent proxy (disir-proxy.ts): MaxBet's Disir token,
  // fetched with the Oddin-authorised bifrost.oddin.gg referer, on the
  // widget host the token is registered on (defaults to DISIR_ENV).
  const proxyCfg = env.DISIR_PROXY_BRAND_TOKEN
    ? {
        token: env.DISIR_PROXY_BRAND_TOKEN,
        env: env.DISIR_PROXY_ENV ?? env.DISIR_ENV,
        referer: env.DISIR_PROXY_REFERER,
      }
    : null;

  // The browser reaches the api under /api (Caddy mount; the storefront's
  // apiAssetBase falls back to the same), so the proxied document's assets
  // must resolve to an absolute path under /api. Dev with a direct
  // NEXT_PUBLIC_API_URL is the one setup this constant does not fit; the
  // proxy is a production path, so that is acceptable.
  const PUBLIC_API_PREFIX = "/api";
  const assetBaseFor = (upstreamEnv: DisirEnv): string =>
    `${PUBLIC_API_PREFIX}/widgets/disir-asset/${upstreamEnv}`;

  // Turn an upstream widget URL into the same-origin document HTML the
  // storefront iframes: fetch it with the authorised referer, rewrite its
  // build-prefixed asset refs to our asset-proxy, and cache the result
  // like every other widget URL. Throws a typed 503 the storefront reads
  // as "no widget" (it then collapses / uses Bifrost).
  async function serveProxiedDocument(
    cacheKey: string,
    upstreamEnv: DisirEnv,
    upstreamUrl: string,
  ): Promise<string> {
    if (!proxyCfg) {
      throw new ServiceUnavailableError(
        "Disir widget proxy is not configured for this environment",
        "disir_proxy_disabled",
      );
    }
    return cachedSwr<string>(
      app.redis,
      cacheKey,
      FRESH_SECONDS,
      STALE_SECONDS,
      async () => {
        const res = await fetchWidgetDocument(upstreamUrl, proxyCfg.referer);
        const rewritten = res.html
          ? rewriteWidgetDocument(res.html, assetBaseFor(upstreamEnv))
          : null;
        if (!rewritten) {
          app.log.warn(
            { status: res.status, url: upstreamUrl.split("?")[0] },
            "disir proxy: upstream document unavailable",
          );
          throw new ServiceUnavailableError(
            "Widget provider document unavailable",
            "disir_proxy_unavailable",
          );
        }
        return rewritten.html;
      },
    );
  }

  // Bounded in-process cache for proxied asset bytes. Chunk names are
  // content-hashed, so an entry never goes stale; the cap keeps one build
  // (~2 MB across ~20 chunks) resident without competing with Redis for
  // the 256 MB hot set. A deploy clears it, which just re-fetches.
  const ASSET_CACHE_MAX_BYTES = 32 * 1024 * 1024;
  const assetCache = new Map<string, { body: Uint8Array; contentType: string }>();
  let assetCacheBytes = 0;
  function assetCacheGet(key: string): { body: Uint8Array; contentType: string } | undefined {
    const v = assetCache.get(key);
    if (v) {
      assetCache.delete(key);
      assetCache.set(key, v);
    }
    return v;
  }
  function assetCachePut(key: string, body: Uint8Array, contentType: string): void {
    if (body.byteLength > ASSET_CACHE_MAX_BYTES) return;
    while (assetCacheBytes + body.byteLength > ASSET_CACHE_MAX_BYTES && assetCache.size > 0) {
      const oldest = assetCache.keys().next().value as string;
      const ev = assetCache.get(oldest);
      assetCache.delete(oldest);
      if (ev) assetCacheBytes -= ev.body.byteLength;
    }
    assetCache.set(key, { body, contentType });
    assetCacheBytes += body.byteLength;
  }

  const tokens: TokenConfig | null = env.DISIR_BRAND_TOKEN
    ? {
        primary: { brandToken: env.DISIR_BRAND_TOKEN, env: env.DISIR_ENV },
        backup: env.DISIR_BACKUP_BRAND_TOKEN
          ? {
              brandToken: env.DISIR_BACKUP_BRAND_TOKEN,
              env: env.DISIR_BACKUP_ENV ?? env.DISIR_ENV,
            }
          : null,
      }
    : null;

  function requireTokens(): TokenConfig {
    if (!tokens) {
      throw new ServiceUnavailableError(
        "Widgets are not configured for this environment",
        "widget_disabled",
      );
    }
    return tokens;
  }

  // How long a request-side "refused" record stands on its own: a few
  // probe rounds, so a probe that has stopped cannot pin the site to its
  // fallback, and never under five minutes so a burst of requests during
  // a refusal does not each pay the upstream round trip.
  const healthTtlSeconds = Math.max(300, env.DISIR_TOKEN_PROBE_SECONDS * 3);

  // Which token serves this request: the slot the probe (or a 401) last
  // wrote, primary on a lost or absent key.
  async function currentCredentials(cfg: TokenConfig): Promise<TokenCredentials> {
    if (!cfg.backup) return credentialsFor(cfg, "primary");
    const state = await readSlot(app.redis);
    return credentialsFor(cfg, state.slot);
  }

  // ── Token probe ─────────────────────────────────────────────────────
  // Runs whenever widgets are configured, backup or not: with a backup it
  // decides the slot, and either way it keeps the health record that
  // makes a refused token answer 401 (and so reach the Bifrost fallback)
  // instead of a URL the widget cannot use. The storefront origin is
  // what the widget host has (or has not) registered for each token.
  if (tokens && env.DISIR_TOKEN_PROBE_SECONDS > 0) {
    const cfg = tokens;
    const intervalMs = env.DISIR_TOKEN_PROBE_SECONDS * 1000;
    const refererOrigin = `https://${env.FRONTEND_HOST}`;
    let inFlight = false;
    const probe = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        // NX lock so a second api process would not double-probe; the
        // lock lives shorter than the interval so a crashed holder frees it.
        const locked = await app.redis
          .set("disir:token:probe:lock", "1", "EX", Math.max(10, env.DISIR_TOKEN_PROBE_SECONDS - 5), "NX")
          .catch(() => null);
        if (!locked) return;
        const r = await runProbeRound(app.redis, cfg, refererOrigin, undefined, healthTtlSeconds);
        const fields = {
          slot: r.after.slot,
          primary: r.primary.verdict,
          primaryStatus: r.primary.status,
          primaryDetail: r.primary.detail ?? null,
          backup: r.backup?.verdict ?? null,
          backupStatus: r.backup?.status ?? null,
        };
        if (r.after.slot !== r.before.slot) {
          if (r.after.slot === "backup") {
            app.log.warn(fields, "disir token failover: switched to backup token");
          } else {
            app.log.info(fields, "disir token failover: primary accepted again, switched back");
          }
        } else if (r.primary.verdict !== "ok") {
          app.log.warn(fields, "disir token probe: primary not accepted");
        } else {
          app.log.debug(fields, "disir token probe ok");
        }
      } catch (err) {
        app.log.warn({ err }, "disir token probe failed");
      } finally {
        inFlight = false;
      }
    };
    const boot = setTimeout(() => void probe(), PROBE_BOOT_DELAY_MS);
    const timer = setInterval(() => void probe(), intervalMs);
    app.addHook("onClose", async () => {
      clearTimeout(boot);
      clearInterval(timer);
    });
  }

  // ── Last resort: Bifrost's non-betting match page ──────────────────────
  // Served regardless of the Disir token's health; the STOREFRONT decides
  // when to use it (DisirWidget swaps to it when the widget host refuses
  // our token — no LOADED within 20 s — or api-disir answers 401 with no
  // backup). See bifrost-embed.ts for what it renders and why it works.
  app.get<{
    Params: { matchId: string };
    Querystring: z.input<typeof liveMatchQuery>;
  }>(
    "/widgets/match/:matchId/bifrost",
    { config: widgetReadRateLimit },
    async (req) => {
      // Both halves are needed: the key to load Bifrost at all, and the
      // storefront host because Bifrost only trusts postMessages from the
      // `customDomain` it was given — the CONFIG message that switches it
      // to non-betting mode would be ignored without it.
      const storefrontHost = env.FRONTEND_HOST;
      if (!env.BIFROST_API_KEY || !storefrontHost) {
        throw new ServiceUnavailableError(
          "Bifrost embed is not configured for this environment",
          "bifrost_embed_disabled",
        );
      }
      const urn = await resolveMatchUrn(app, req.params.matchId);
      const q = liveMatchQuery.parse(req.query);
      // Numeric id or URN, whichever the caller sent, becomes the referer
      // Bifrost builds its outbound links from; it is informational.
      const refererUrl = `https://${storefrontHost}/match/${encodeURIComponent(req.params.matchId)}`;
      return buildBifrostEmbed({
        apiKey: env.BIFROST_API_KEY,
        matchUrn: urn,
        refererUrl,
        storefrontHost,
        language: q.language,
        theme: q.theme,
      });
    },
  );

  // ── Whitelisting-independent widget proxy (2026-09-17) ─────────────────
  // Two halves. A JSON endpoint (like the normal widget endpoints) returns
  // a SAME-ORIGIN document URL carrying the full widget query — including
  // MaxBet's Disir token and the ids — because the widget app reads those
  // from window.location.search at hydration, so they must sit on the URL
  // the browser actually loads. The document route then fetches that
  // widget document from Oddin with the authorised referer, rewrites its
  // asset refs to absolute upstream, and serves it from our origin. See
  // disir-proxy.ts for why each piece is where it is.

  const KIND_SEG_RE = /^[a-z_]+$/;

  // Turn a built upstream widget URL (`${host}/${seg}/${kind}?${q}`) into
  // the same-origin path the storefront iframes. The client prefixes it
  // with the api base; the token + ids ride in the query so the app has
  // them at hydration.
  function toProxyDocUrl(upstreamEnv: DisirEnv, upstreamUrl: string): string {
    const u = new URL(upstreamUrl);
    // u.pathname is `/<seg>/<kind>`.
    return `/widgets/disir-app/${upstreamEnv}${u.pathname}${u.search}`;
  }

  // The asset route: same-origin proxy for the widget app's static
  // chunks/styles so turbopack's runtime, which fetches its dynamic chunks
  // and would fail cross-origin (no CORS), loads them from us. `rest` is
  // everything after the env — `<buildid>/_next/...` or `<buildid>/static/
  // ...`. Guarded to the hashed build path so it cannot be steered to an
  // arbitrary upstream file; bytes are content-hashed, hence immutable.
  const ASSET_REST_RE = /^[0-9a-f]{32}\/(?:_next\/|static\/)[A-Za-z0-9._/-]+$/;
  app.get<{
    Params: { env: string; "*": string };
  }>("/widgets/disir-asset/:env/*", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!proxyCfg) {
      throw new ServiceUnavailableError(
        "Disir widget proxy is not configured for this environment",
        "disir_proxy_disabled",
      );
    }
    const pEnv = req.params.env;
    const rest = req.params["*"];
    if ((pEnv !== "integration" && pEnv !== "main") || !ASSET_REST_RE.test(rest)) {
      throw new BadRequestError("Invalid widget asset reference", "disir_proxy_bad_asset");
    }
    const upstreamEnv = pEnv as DisirEnv;
    const cacheKey = `${upstreamEnv}/${rest}`;
    const cached = assetCacheGet(cacheKey);
    const asset =
      cached ??
      (await (async () => {
        const res = await fetchWidgetAsset(assetUpstreamUrl(upstreamEnv, rest), proxyCfg.referer);
        if (!res.body) return null;
        assetCachePut(cacheKey, res.body, res.contentType);
        return { body: res.body, contentType: res.contentType };
      })());
    if (!asset) {
      throw new ServiceUnavailableError(
        "Widget provider asset unavailable",
        "disir_proxy_asset_unavailable",
      );
    }
    return reply
      .header("content-type", asset.contentType)
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .send(Buffer.from(asset.body));
  });

  // The document route. `env/seg/kind` name the upstream widget page and
  // the query carries everything the app needs. Guards keep this from
  // being a general fetch-with-our-referer relay: env/seg/kind are shape
  // checked and the brandToken MUST be the proxy token we would have put
  // there ourselves, so a caller cannot make us fetch an arbitrary page.
  app.get<{
    Params: { env: string; seg: string; kind: string };
  }>("/widgets/disir-app/:env/:seg/:kind", { config: widgetReadRateLimit }, async (req, reply) => {
    if (!proxyCfg) {
      throw new ServiceUnavailableError(
        "Disir widget proxy is not configured for this environment",
        "disir_proxy_disabled",
      );
    }
    const { env: pEnv, seg, kind } = req.params;
    if (
      (pEnv !== "integration" && pEnv !== "main") ||
      !KIND_SEG_RE.test(seg) ||
      (kind !== "match" && kind !== "scoreboard" && kind !== "tournament")
    ) {
      throw new BadRequestError("Invalid widget document reference", "disir_proxy_bad_ref");
    }
    const q = (req.query ?? {}) as Record<string, unknown>;
    if (q.brandToken !== proxyCfg.token) {
      // Only a URL we minted (via the JSON endpoint) carries our token;
      // anything else is an attempt to steer the proxy fetch.
      throw new BadRequestError("Invalid widget document token", "disir_proxy_bad_token");
    }
    const upstreamEnv = pEnv as DisirEnv;
    const rawQuery = (req.raw.url ?? "").split("?")[1] ?? "";
    const upstreamUrl = `${disirWidgetHost(upstreamEnv)}/${seg}/${kind}?${rawQuery}`;
    const cacheKey = `disir:proxy:v1:${upstreamEnv}:${seg}:${kind}:${rawQuery}`;
    const html = await serveProxiedDocument(cacheKey, upstreamEnv, upstreamUrl);
    return reply
      .header("content-security-policy", proxyContentSecurityPolicy())
      // The document embeds MaxBet's publishable token in its asset-less
      // query only; it is per-viewer nothing and safe to cache briefly in
      // the browser, but keep it private (not shared caches) to be tidy.
      .header("cache-control", "private, max-age=60")
      .header("x-content-type-options", "nosniff")
      .type("text/html; charset=utf-8")
      .send(html);
  });

  // JSON: the storefront's entry point for a proxied MATCH widget
  // (prematch by default, or the live scoreboard with ?kind=live).
  app.get<{
    Params: { matchId: string };
    Querystring: z.input<typeof prematchMatchQuery> & { kind?: string };
  }>("/widgets/match/:matchId/disir-proxy", { config: widgetReadRateLimit }, async (req) => {
    if (!proxyCfg) {
      throw new ServiceUnavailableError(
        "Disir widget proxy is not configured for this environment",
        "disir_proxy_disabled",
      );
    }
    const urn = await resolveMatchUrn(app, req.params.matchId);
    const live = (req.query as { kind?: string }).kind === "live";
    const q = prematchMatchQuery.parse(req.query);
    const c = await loadMatchWidgetContext(app, urn);
    if (!c) {
      throw new NotFoundError("Widget not available for this match", "widget_not_available");
    }
    let upstreamUrl: string;
    if (live) {
      const segment = await resolveSegment(app, proxyCfg.env, c.sportSlug);
      if (!segment) {
        throw new NotFoundError("Widget not available for this match", "widget_not_available");
      }
      upstreamUrl = buildScoreboardWidgetUrl({
        env: proxyCfg.env,
        brandToken: proxyCfg.token,
        segment,
        matchUrn: c.matchUrn,
        theme: q.theme,
        language: q.language,
      });
    } else {
      if (!c.homeTeamUrn || !c.awayTeamUrn) {
        throw new NotFoundError("Widget not available for this match", "widget_not_available");
      }
      const sport = await resolveSportParams(app, proxyCfg.env, c.sportSlug);
      if (!sport) {
        throw new NotFoundError("Widget not available for this match", "widget_not_available");
      }
      upstreamUrl = buildMatchWidgetUrl({
        env: proxyCfg.env,
        brandToken: proxyCfg.token,
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
    return { url: toProxyDocUrl(proxyCfg.env, upstreamUrl) };
  });

  // JSON: the storefront's entry point for a proxied TOURNAMENT widget.
  app.get<{
    Params: { tournamentId: string };
    Querystring: z.input<typeof prematchTournamentQuery>;
  }>("/widgets/tournament/:tournamentId/disir-proxy", { config: widgetReadRateLimit }, async (req) => {
    if (!proxyCfg) {
      throw new ServiceUnavailableError(
        "Disir widget proxy is not configured for this environment",
        "disir_proxy_disabled",
      );
    }
    const urn = await resolveTournamentUrn(app, req.params.tournamentId);
    const q = prematchTournamentQuery.parse(req.query);
    const slug = await loadTournamentSportSlug(app, urn);
    if (!slug) {
      throw new NotFoundError("Widget not available for this tournament", "widget_not_available");
    }
    const segment = await resolveSegment(app, proxyCfg.env, slug);
    if (!segment) {
      throw new NotFoundError("Widget not available for this tournament", "widget_not_available");
    }
    const upstreamUrl = buildTournamentWidgetUrl({
      env: proxyCfg.env,
      brandToken: proxyCfg.token,
      segment,
      tournamentUrn: urn,
      theme: q.theme,
      language: q.language,
      allowClose: q.allowClose,
    });
    return { url: toProxyDocUrl(proxyCfg.env, upstreamUrl) };
  });

  // ── Prematch: match-level (Team / Player / Tournament tabs) ────────────
  app.get<{
    Params: { matchId: string };
    Querystring: z.input<typeof prematchMatchQuery>;
  }>(
    "/widgets/match/:matchId/prematch",
    { config: widgetReadRateLimit },
    async (req) => {
      const cfg = requireTokens();
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

      return resolveWidgetUrl(
        app,
        { tokens: cfg, healthTtlSeconds, log: { widget: "prematch-match", urn } },
        await currentCredentials(cfg),
        (creds) => ({
          cacheKey: `disir:url:v2:${creds.slot}:prematch:match:${creds.env}:${urn}:${query}`,
          issue: () =>
            issueFromDisir(
              app,
              `${baseUrl}/statistics/${creds.env}/match/${urn}${query ? `?${query}` : ""}`,
              creds.brandToken,
            ),
          onIssued: async (url) => {
            const c = await ctx();
            if (c) await learnFromIssuedUrl(app, creds.env, c.sportSlug, url, learnOpts);
          },
          fallback: fallbackEnabled
            ? async () => {
                const c = await ctx();
                if (!c || !c.homeTeamUrn || !c.awayTeamUrn) return null;
                const sport = await resolveSportParams(app, creds.env, c.sportSlug);
                if (!sport) return null;
                return buildMatchWidgetUrl({
                  env: creds.env,
                  brandToken: creds.brandToken,
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
        }),
      );
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
      const cfg = requireTokens();
      const urn = await resolveTournamentUrn(app, req.params.tournamentId);
      const q = prematchTournamentQuery.parse(req.query);

      const qs = new URLSearchParams();
      appendIfPresent(qs, "theme", q.theme);
      appendIfPresent(qs, "language", q.language);
      appendIfPresent(qs, "allowClose", q.allowClose);
      const query = qs.toString();
      const sportSlug = once(() => loadTournamentSportSlug(app, urn));

      return resolveWidgetUrl(
        app,
        { tokens: cfg, healthTtlSeconds, log: { widget: "prematch-tournament", urn } },
        await currentCredentials(cfg),
        (creds) => ({
          cacheKey: `disir:url:v2:${creds.slot}:prematch:tour:${creds.env}:${urn}:${query}`,
          issue: () =>
            issueFromDisir(
              app,
              `${baseUrl}/statistics/${creds.env}/tournament/${urn}${query ? `?${query}` : ""}`,
              creds.brandToken,
            ),
          onIssued: async (url) => {
            const slug = await sportSlug();
            if (slug) await learnFromIssuedUrl(app, creds.env, slug, url, NO_OVERRIDES);
          },
          fallback: fallbackEnabled
            ? async () => {
                const slug = await sportSlug();
                if (!slug) return null;
                const segment = await resolveSegment(app, creds.env, slug);
                if (!segment) return null;
                return buildTournamentWidgetUrl({
                  env: creds.env,
                  brandToken: creds.brandToken,
                  segment,
                  tournamentUrn: urn,
                  theme: q.theme,
                  language: q.language,
                  allowClose: q.allowClose,
                });
              }
            : null,
        }),
      );
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
      const cfg = requireTokens();
      const urn = await resolveMatchUrn(app, req.params.matchId);
      const q = liveMatchQuery.parse(req.query);

      const qs = new URLSearchParams();
      appendIfPresent(qs, "theme", q.theme);
      appendIfPresent(qs, "language", q.language);
      const query = qs.toString();
      const ctx = once(() => loadMatchWidgetContext(app, urn));

      return resolveWidgetUrl(
        app,
        { tokens: cfg, healthTtlSeconds, log: { widget: "live-scoreboard", urn } },
        await currentCredentials(cfg),
        (creds) => ({
          cacheKey: `disir:url:v2:${creds.slot}:live:match:${creds.env}:${urn}:${query}`,
          issue: () =>
            issueFromDisir(
              app,
              `${baseUrl}/live/${creds.env}/scoreboard/${urn}${query ? `?${query}` : ""}`,
              creds.brandToken,
            ),
          onIssued: async (url) => {
            const c = await ctx();
            if (c) await learnFromIssuedUrl(app, creds.env, c.sportSlug, url, NO_OVERRIDES);
          },
          fallback: fallbackEnabled
            ? async () => {
                const c = await ctx();
                if (!c) return null;
                const segment = await resolveSegment(app, creds.env, c.sportSlug);
                if (!segment) return null;
                return buildScoreboardWidgetUrl({
                  env: creds.env,
                  brandToken: creds.brandToken,
                  segment,
                  matchUrn: c.matchUrn,
                  theme: q.theme,
                  language: q.language,
                });
              }
            : null,
        }),
      );
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
