// /video/* — Oddin video (Havik player) availability + browser credentials.
//
//   GET /video/match/:matchId  ->  OddinVideoAvailability
//
// `:matchId` accepts either the numeric `matches.id` the storefront carries
// or an `od:match:N` provider URN, mirroring /widgets/*.
//
// **Watching is restricted to signed-in bettors.** The route stays reachable
// anonymously — it has to, since the storefront asks about every match page
// including logged-out ones — but for an anonymous viewer it reports
// `signInRequired` and withholds the credential. Withholding is the whole
// gate: without the api-key the SDK cannot resolve playback or sign a DRM
// licence request, so there is nothing a logged-out client can replay. This
// is deliberately not a 401: a 401 would be indistinguishable from "no
// stream" at the call site and would cost us the sign-in prompt.
//
// The response carries the PUBLISHABLE api-key (`pk_test_…` / `pk_live_…`).
// That is Oddin's intended posture — the key is origin-locked server-side and
// the browser SDK needs it directly, because it signs its own DRM license
// POSTs from the page. Serving it here rather than baking a NEXT_PUBLIC_* var
// into the web bundle means rotating the key is an .env edit plus
// `make recreate api`, with no storefront rebuild, and keeps the web tier's
// env free of provider credentials. See packages/types/src/video.ts.
//
// When ODDIN_VIDEO_API_KEY is empty the route 503s `video_disabled` and the
// storefront renders no player and no stream tab — the same graceful-idle
// contract Disir (`widget_disabled`) and OBB (`betbuilder_disabled`) use.

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { loadEnv } from "@oddzilla/config";
import { matches } from "@oddzilla/db";
import type { OddinVideoAvailability } from "@oddzilla/types/video";
import { BadRequestError, NotFoundError, ServiceUnavailableError } from "../../lib/errors.js";
import { loadVideoCatalog } from "./catalog.js";

// Same guard /widgets/* applies: every provider_urn we have seen is
// `od:match:<digits>`, and anything else must not reach an upstream path.
const MATCH_URN_RE = /^od:match:\d+$/;

const videoReadRateLimit = {
  rateLimit: { max: 60, timeWindow: "1 minute" },
};

/** The shape returned whenever there is nothing to play. */
const UNAVAILABLE: OddinVideoAvailability = {
  available: false,
  signInRequired: false,
  matchUrn: null,
  baseUrl: null,
  apiKey: null,
  status: null,
  startsAt: null,
};

export default async function videoRoutes(app: FastifyInstance) {
  const env = loadEnv();
  const baseUrl = env.ODDIN_VIDEO_BASE_URL.replace(/\/$/, "");

  // Oddin gates the api-key on an allowed-origin list enforced SERVER-side,
  // and a request carrying no Origin is refused outright ("origin not
  // allowed"), so our own catalog fetch has to name an allow-listed origin.
  // The storefront origin is exactly the one Oddin has on file, so derive it
  // from FRONTEND_HOST and fall back to the first configured CORS origin for
  // local dev (which Oddin won't know — video degrades to unavailable there,
  // which is the right outcome).
  const catalogOrigin = env.FRONTEND_HOST
    ? `https://${env.FRONTEND_HOST}`
    : (env.CORS_ORIGINS.split(",")[0]?.trim() ?? "");

  function requireKey(): string {
    if (!env.ODDIN_VIDEO_API_KEY) {
      throw new ServiceUnavailableError(
        "Video is not configured for this environment",
        "video_disabled",
      );
    }
    return env.ODDIN_VIDEO_API_KEY;
  }

  app.get<{ Params: { matchId: string } }>(
    "/video/match/:matchId",
    { config: videoReadRateLimit },
    async (req, reply): Promise<OddinVideoAvailability> => {
      // The success payload carries a credential and varies per viewer
      // (signed-in vs not). Nothing between here and the browser may hold
      // on to it — a shared cache serving one bettor's response to an
      // anonymous visitor would hand out the key and defeat the gate.
      reply.header("cache-control", "private, no-store");

      const apiKey = requireKey();
      const urn = await resolveMatchUrn(app, req.params.matchId);

      const catalog = await loadVideoCatalog(app, baseUrl, apiKey, catalogOrigin);
      // Catalog unreachable — report "no video" rather than an error. The
      // storefront's stream tab strip simply doesn't gain an Oddin entry.
      if (!catalog) return UNAVAILABLE;

      const entry = catalog[urn];
      // Oddin carries no stream for this match, or already dropped it from
      // the catalog. `ended` is deliberately treated as unavailable: there
      // is nothing to watch, and the SDK would answer GONE anyway.
      if (!entry || entry.status === "ended") return UNAVAILABLE;

      // Signed-in bettors only. An anonymous viewer learns a stream exists
      // (public catalog information, and it drives the sign-in prompt) but
      // gets no credential, no URN and no base URL — nothing that would let
      // a client reach Oddin on its own.
      if (!req.user) {
        return {
          ...UNAVAILABLE,
          signInRequired: true,
          status: entry.status,
          startsAt: entry.startsAt,
        };
      }

      return {
        available: true,
        signInRequired: false,
        matchUrn: urn,
        baseUrl,
        apiKey,
        status: entry.status,
        startsAt: entry.startsAt,
      };
    },
  );
}

/**
 * Accept a numeric `matches.id` or an `od:match:N` URN and yield the URN.
 * A match we don't have is a 404; a match whose stored URN isn't the shape
 * Oddin uses is treated the same way, since we can't address it upstream.
 */
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
    throw new NotFoundError(
      "Match URN unsupported by the video provider",
      "match_urn_unsupported",
    );
  }
  return urn;
}
