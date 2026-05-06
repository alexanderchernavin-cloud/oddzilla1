// /widgets/* — server-side proxy for Oddin Disir widget URL endpoints.
// The frontend never sees the brand token; only the resulting iframe
// URL is forwarded.
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
// Each one returns `{ url: string }` — the value the iframe `src` should
// take. Disir's URLs are short-lived but stable enough to cache for the
// duration of a page view; we add a tiny Redis TTL cache so the same
// match opened by 50 users in 5 minutes hits Disir once.
//
// When DISIR_BRAND_TOKEN is empty the routes 503 with `widget_disabled`
// — the storefront skips rendering. Same shape as the wallet-watcher
// degrades-when-creds-absent pattern used elsewhere in the codebase.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadEnv } from "@oddzilla/config";
import { eq } from "drizzle-orm";
import { matches, tournaments } from "@oddzilla/db";
import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../lib/errors.js";

// Match the doc table for prematch — esports vs eSims accept different
// timeframes/tabs. The proxy passes whatever the client sends; Disir
// returns its own 405 if the combo is invalid for the match's sport.
const themeSchema = z.string().min(1).max(64).optional();
const languageSchema = z
  .string()
  .regex(/^[a-z]{2}$/, "language must be a 2-letter ISO 639-1 code")
  .optional();
const allowCloseSchema = z
  .preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean())
  .optional();

const prematchMatchQuery = z.object({
  theme: themeSchema,
  language: languageSchema,
  allowClose: allowCloseSchema,
  tab: z.string().max(64).optional(),
  timeframe: z.string().max(64).optional(),
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

// Cache the upstream `{url}` for a short window keyed on (env + path +
// query). Disir docs say the match widget URL itself does not expire,
// but bookmaker-side feeds may refresh tokens — keep it short so a stale
// URL never lingers more than a couple of minutes.
const CACHE_TTL_SECONDS = 120;

async function fetchDisirUrl(
  app: FastifyInstance,
  cacheKey: string,
  upstreamPath: string,
  query: URLSearchParams,
  brandToken: string,
  baseUrl: string,
): Promise<string> {
  const cached = await app.redis.get(cacheKey).catch(() => null);
  if (cached) return cached;

  const qs = query.toString();
  const url = qs.length > 0 ? `${baseUrl}${upstreamPath}?${qs}` : `${baseUrl}${upstreamPath}`;

  // 8s upstream budget — Disir is regional EU, p99 latency well under that.
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
    app.log.warn({ err, url }, "disir upstream fetch failed");
    throw new ServiceUnavailableError(
      "Widget provider unavailable",
      "widget_provider_unavailable",
    );
  } finally {
    clearTimeout(timer);
  }

  // Pass through 401/404/405 with stable codes the frontend can branch on.
  if (!res.ok) {
    let body: DisirErr | null = null;
    try {
      body = (await res.json()) as DisirErr;
    } catch {
      // ignore — non-JSON 5xx
    }
    if (res.status === 401) {
      app.log.error({ url }, "disir brand token rejected");
      throw new ServiceUnavailableError(
        "Widget provider rejected our credentials",
        "widget_provider_unauthorized",
      );
    }
    if (res.status === 404) {
      throw new NotFoundError(
        body?.message ?? "Widget not available for this resource",
        "widget_not_available",
      );
    }
    if (res.status === 405) {
      throw new BadRequestError(
        body?.message ?? "Invalid widget parameters",
        "widget_invalid_parameters",
      );
    }
    throw new ServiceUnavailableError(
      "Widget provider error",
      "widget_provider_error",
    );
  }

  let payload: DisirOk;
  try {
    payload = (await res.json()) as DisirOk;
  } catch {
    throw new ServiceUnavailableError(
      "Widget provider returned malformed response",
      "widget_provider_malformed",
    );
  }
  if (!payload.url || typeof payload.url !== "string") {
    throw new ServiceUnavailableError(
      "Widget provider returned no URL",
      "widget_provider_missing_url",
    );
  }

  await app.redis
    .set(cacheKey, payload.url, "EX", CACHE_TTL_SECONDS)
    .catch(() => null);
  return payload.url;
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
  const disirEnv = env.DISIR_ENV;

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
      const matchId = req.params.matchId;
      // Resolve the bare numeric/uuid form to the `od:match:N` URN Disir
      // expects. We accept both shapes so the frontend can pass either
      // the numeric matches.id row or the provider URN directly.
      const urn = await resolveMatchUrn(app, matchId);
      const q = prematchMatchQuery.parse(req.query);

      const qs = new URLSearchParams();
      appendIfPresent(qs, "theme", q.theme);
      appendIfPresent(qs, "language", q.language);
      appendIfPresent(qs, "allowClose", q.allowClose);
      appendIfPresent(qs, "tab", q.tab);
      appendIfPresent(qs, "timeframe", q.timeframe);

      const cacheKey = `disir:url:prematch:match:${disirEnv}:${urn}:${qs.toString()}`;
      const url = await fetchDisirUrl(
        app,
        cacheKey,
        `/statistics/${disirEnv}/match/${urn}`,
        qs,
        token,
        baseUrl,
      );
      return { url };
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

      const cacheKey = `disir:url:prematch:tour:${disirEnv}:${urn}:${qs.toString()}`;
      const url = await fetchDisirUrl(
        app,
        cacheKey,
        `/statistics/${disirEnv}/tournament/${urn}`,
        qs,
        token,
        baseUrl,
      );
      return { url };
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

      const cacheKey = `disir:url:live:match:${disirEnv}:${urn}:${qs.toString()}`;
      const url = await fetchDisirUrl(
        app,
        cacheKey,
        `/live/${disirEnv}/scoreboard/${urn}`,
        qs,
        token,
        baseUrl,
      );
      return { url };
    },
  );
}

// Disir's path parser does NOT decode percent-escaped colons — passing
// `od%3Amatch%3AN` returns 405. So URNs must be interpolated literally
// into the upstream path. These regexes guard against any character
// outside the legitimate URN shape so the literal interpolation can't
// be turned into path traversal or a host-swap with a crafted input.
const MATCH_URN_RE = /^od:match:\d+$/;
const TOURNAMENT_URN_RE = /^od:tournament:\d+$/;

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
    // Defence in depth: every row in matches.provider_urn we've seen
    // matches od:match:N, but a future provider could store something
    // exotic. Bail out before interpolating it into the upstream path.
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
