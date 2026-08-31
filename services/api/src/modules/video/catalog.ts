// Oddin video availability — a cached snapshot of Oddin's stream catalog.
//
// Why a catalog snapshot instead of probing playback per match:
// `GET /v1/playback/{urn}` answers `503 UNAVAILABLE` for a URN Oddin
// carries no stream for — the same status a genuine transient outage
// returns. There is no way to tell "no stream for this match, ever" from
// "try again in a moment" at that endpoint, so a probe-driven check would
// mount a broken player on every match Oddin doesn't cover. `GET /v1/catalog`
// answers definitively, and answers for every match in one request: at the
// time of writing it carries ~800 matches across 8 sports in ~100 KB.
//
// So we fetch it once per CACHE_TTL_SECONDS, flatten it to
// `urn -> { status, startsAt }`, and let every match page read that map.
// Two layers keep the upstream load at one request per TTL regardless of
// traffic: a Redis cache shared across api restarts / future replicas, and
// an in-process promise dedupe so a burst of concurrent requests that all
// miss Redis still produces a single fetch.
//
// Failure is soft and quiet. When the catalog is unreachable we cache the
// miss briefly (NEGATIVE_TTL_SECONDS) and report every match as
// unavailable, so the storefront renders no player rather than an error —
// same posture as Disir's `widget_disabled`. The negative cache is the part
// that matters: without it an upstream outage turns every match-page view
// into an 8-second upstream timeout.

import type { FastifyInstance } from "fastify";
import type { OddinVideoStatus } from "@oddzilla/types/video";

/** One catalog entry, trimmed to what the storefront actually needs. */
export interface OddinVideoCatalogEntry {
  status: OddinVideoStatus;
  startsAt: string | null;
}

type CatalogMap = Record<string, OddinVideoCatalogEntry>;

// Oddin sets `Cache-Control: public, max-age=10` on the catalog. 60s trades
// a little staleness for a 6x cut in upstream calls; the consequence of
// being stale is bounded and self-correcting — a match that just went live
// shows its player up to a minute late, and the SDK's own `waitForLive`
// covers the reverse case (catalog says upcoming, stream is already up).
const CACHE_TTL_SECONDS = 60;
const NEGATIVE_TTL_SECONDS = 15;
const CACHE_KEY = "oddinvideo:catalog:v1";
const NEGATIVE_KEY = "oddinvideo:catalog:v1:down";
const UPSTREAM_TIMEOUT_MS = 8000;

// Shape of the slice of /v1/catalog we read. Everything is optional because
// this is untrusted upstream JSON: a field that changes type must degrade to
// "no entry", never throw inside a match-page render.
interface RawCatalogMatch {
  matchUrn?: unknown;
  status?: unknown;
  datePlannedStart?: unknown;
}
interface RawCatalogTournament {
  matches?: unknown;
}
interface RawCatalog {
  tournaments?: unknown;
}

function isOddinVideoStatus(v: unknown): v is OddinVideoStatus {
  return v === "upcoming" || v === "live" || v === "ended";
}

/** Flatten the nested tournament/match tree into a flat URN map. */
function flatten(raw: RawCatalog): CatalogMap {
  const out: CatalogMap = {};
  const tournaments = Array.isArray(raw.tournaments) ? raw.tournaments : [];
  for (const t of tournaments as RawCatalogTournament[]) {
    const matches = Array.isArray(t?.matches) ? t.matches : [];
    for (const m of matches as RawCatalogMatch[]) {
      const urn = typeof m?.matchUrn === "string" ? m.matchUrn : null;
      if (!urn) continue;
      if (!isOddinVideoStatus(m?.status)) continue;
      out[urn] = {
        status: m.status,
        startsAt:
          typeof m?.datePlannedStart === "string" ? m.datePlannedStart : null,
      };
    }
  }
  return out;
}

// In-process single-flight. Keyed by nothing — there is exactly one catalog
// — so a concurrent burst shares one promise. Cleared in `finally` so a
// failed fetch doesn't pin a rejected promise for the process lifetime.
let inFlight: Promise<CatalogMap | null> | null = null;

async function fetchCatalog(
  app: FastifyInstance,
  baseUrl: string,
  apiKey: string,
  origin: string,
): Promise<CatalogMap | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/v1/catalog`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-api-key": apiKey,
        // Oddin enforces the api-key's allowed-origin list SERVER-side, and
        // a request with no Origin at all counts as not-allowed: a bare
        // server-to-server call gets `403 {"code":"FORBIDDEN","message":
        // "origin not allowed"}`. This is not CORS — no browser is involved
        // — so we must state the origin explicitly. Node's fetch permits
        // setting Origin (browsers do not), which is what makes this work.
        origin,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // 401 means the key is wrong or the origin list rejected us — worth
      // an error-level line, since it's a config problem an operator must
      // fix, not a blip that will heal on its own.
      if (res.status === 401 || res.status === 403) {
        // 403 is usually `origin not allowed`: either the origin we sent
        // isn't on Oddin's list for this key, or FRONTEND_HOST is unset and
        // we fell back to something they don't recognise. Log the origin —
        // it's the one field that makes this diagnosable from the logs.
        app.log.error(
          { status: res.status, origin },
          "oddin video: catalog rejected our api key or origin",
        );
      } else {
        app.log.warn({ status: res.status }, "oddin video: catalog fetch failed");
      }
      return null;
    }
    const body = (await res.json()) as RawCatalog;
    return flatten(body);
  } catch (err) {
    app.log.warn({ err }, "oddin video: catalog fetch threw");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Current catalog map, from Redis when warm and upstream when not.
 * Returns null only when the catalog is unreachable AND uncached — callers
 * should treat that as "no video", not as an error to surface.
 */
export async function loadVideoCatalog(
  app: FastifyInstance,
  baseUrl: string,
  apiKey: string,
  origin: string,
): Promise<CatalogMap | null> {
  const cached = await app.redis.get(CACHE_KEY).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as CatalogMap;
    } catch {
      // Corrupt cache entry — fall through and refetch rather than 500.
    }
  }

  // Recent upstream failure: don't retry on every request.
  const down = await app.redis.get(NEGATIVE_KEY).catch(() => null);
  if (down) return null;

  if (inFlight) return inFlight;

  inFlight = (async () => {
    const map = await fetchCatalog(app, baseUrl, apiKey, origin);
    if (map === null) {
      await app.redis
        .set(NEGATIVE_KEY, "1", "EX", NEGATIVE_TTL_SECONDS)
        .catch(() => null);
      return null;
    }
    await app.redis
      .set(CACHE_KEY, JSON.stringify(map), "EX", CACHE_TTL_SECONDS)
      .catch(() => null);
    return map;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
