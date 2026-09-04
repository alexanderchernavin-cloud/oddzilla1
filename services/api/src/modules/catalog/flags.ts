// Country-flag byte-serve for the sidebar's category headers.
//
// The Fonbet line groups its tournaments by country ("Spain. Primera
// Division. Season 26/27" → category "Spain"), and Fonbet's own static
// CDN carries a circle-flag set keyed by exactly that English country
// name: /ContentCommon/NewFlags/Circle/png/<Country-Name>.png. So the
// mapping from our `categories.name` to a flag is a pure string
// transform — no migration, no per-category asset upload.
//
// This route proxies + caches those bytes instead of letting the
// browser hot-link Fonbet's CDN directly. Three reasons:
//   - Fonbet is a scraped public line, not a data partner: pointing
//     every visitor's browser at their CDN puts our whole audience in
//     their logs and one referer rule away from broken flags.
//   - It keeps the CDN host configurable in one place (FONBET_LOGO_CDN,
//     the same var fonbet-ingester uses for team crests) so moving
//     estates (fon.bet ↔ fonbet.kz) doesn't need a storefront rebuild.
//   - Cached bytes mean the fan-out is one upstream fetch per country
//     per cache lifetime, not one per page view.
//
// Redis is the byte cache. It's `allkeys-lru` in production, so an
// eviction just costs a refetch — see the "Redis is a cache, not
// state" rule; nothing here is authoritative.

import type { FastifyInstance } from "fastify";
import { NotFoundError } from "../../lib/errors.js";

// Country names arrive from the storefront already normalised to
// Fonbet's file-name convention: ASCII letters, digits, and hyphens or
// underscores for spaces ("Bosnia_and_Herzegovina", "United-States",
// and "South-Korea-2", which is why digits are in the class). The shape
// check is the SSRF guard — the upstream path is a fixed prefix plus
// this value, so no traversal or host injection is reachable.
const FLAG_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,48}$/;

const DEFAULT_LOGO_CDN = "https://cdn-ec.bk6bba-resources.com";
const FLAG_PATH_PREFIX = "/ContentCommon/NewFlags/Circle/png/";

const CACHE_PREFIX = "catalog:flag:v1:";
// A flag is ~4-8 KB and never changes. 30 days keeps the upstream
// fetch count negligible without pinning bytes forever.
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
// Negative caching matters more than positive here: every non-country
// category ("NBA 2K26", "Friendly games", "WC 2026") that slips past
// the client-side allowlist would otherwise re-probe upstream on each
// render. Short enough that a genuinely new flag appears within a day.
const MISS_TTL_SECONDS = 60 * 60 * 24;
const MISS_MARKER = "0";

const MAX_FLAG_BYTES = 256 * 1024;
const UPSTREAM_TIMEOUT_MS = 6_000;

function cdnBase(): string {
  const raw = (process.env.FONBET_LOGO_CDN ?? "").trim();
  const base = raw === "" ? DEFAULT_LOGO_CDN : raw;
  return base.replace(/\/+$/, "");
}

export default async function catalogFlagRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string } }>(
    "/catalog/flags/:name",
    // Same per-IP friction as the other odds-free catalog reads. A
    // sidebar render asks for one flag per visible category, and the
    // immutable cache header means a warm browser asks once ever.
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const raw = request.params.name.replace(/\.png$/i, "");
      if (!FLAG_NAME_RE.test(raw)) throw new NotFoundError();

      const key = `${CACHE_PREFIX}${raw.toLowerCase()}`;
      const hit = await app.redis.getBuffer(key).catch(() => null);
      if (hit) {
        if (hit.length === 1 && hit.toString() === MISS_MARKER) {
          throw new NotFoundError();
        }
        return reply
          .header("content-type", "image/png")
          .header("cache-control", "public, max-age=31536000, immutable")
          .send(hit);
      }

      let bytes: Buffer | null = null;
      try {
        const res = await fetch(`${cdnBase()}${FLAG_PATH_PREFIX}${raw}.png`, {
          // Fonbet's CDN answers a bare request fine, but sending the
          // site Origin keeps us consistent with the ingester's client
          // (see services/fonbet-ingester/internal/fonbet/client.go).
          headers: { origin: "https://fon.bet" },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 0 && buf.length <= MAX_FLAG_BYTES) bytes = buf;
        }
      } catch (err) {
        // Upstream unreachable is not a miss — do NOT negative-cache it,
        // or a transient blip blanks the flags for a day. Fall through
        // to a 404 and let the storefront's monogram fallback render;
        // the next request retries.
        app.log.warn(
          { event: "catalog_flag_fetch_failed", flag: raw, err: String(err) },
          "country flag fetch failed",
        );
        throw new NotFoundError();
      }

      if (!bytes) {
        await app.redis
          .set(key, MISS_MARKER, "EX", MISS_TTL_SECONDS)
          .catch(() => {});
        throw new NotFoundError();
      }

      await app.redis.set(key, bytes, "EX", CACHE_TTL_SECONDS).catch(() => {});
      return reply
        .header("content-type", "image/png")
        .header("cache-control", "public, max-age=31536000, immutable")
        .send(bytes);
    },
  );
}
