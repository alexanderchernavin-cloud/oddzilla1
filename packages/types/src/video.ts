// Oddin video (Havik player SDK) — shared wire types between services/api
// and apps/web.
//
// The storefront needs three facts before it can mount a player, and gets
// all of them from one GET /video/match/:matchId round trip:
//   1. Does this match have a first-party Oddin stream at all?
//   2. Which API base URL + match URN identify it?
//   3. The publishable api-key the browser SDK authenticates with.
//
// On (3): `pk_test_…` / `pk_live_…` are PUBLISHABLE credentials. Oddin's
// threat model is "designed to live in browser JavaScript, protected by a
// server-side allowed-origin list" — the key is useless from an origin that
// isn't on the list, so shipping it to the browser is the intended posture,
// not a leak. We serve it from the api at runtime instead of baking a
// NEXT_PUBLIC_* var into the web bundle for two reasons: rotating it becomes
// an .env edit + `make recreate api` rather than a full storefront rebuild,
// and the web tier keeps its no-env-secrets shape (see the docker-compose
// *web-base anchor rule in CLAUDE.md).
//
// On (1): availability is resolved from Oddin's /v1/catalog, never by
// probing /v1/playback/{urn}. A URN with no stream answers that probe with
// `503 UNAVAILABLE` — indistinguishable from a real transient outage — so a
// probe-based check would render a broken player for every match Oddin
// doesn't carry. The catalog answers definitively for every match at once.

/** Oddin's catalog lifecycle for a streamed match. */
export type OddinVideoStatus = "upcoming" | "live" | "ended";

/**
 * Answer to "can this match be watched, and with what?".
 *
 * When `available` is false the credential fields are null — the storefront
 * renders no player. Callers must not treat a non-null `apiKey` as
 * permission to play: the SDK still resolves playback itself and can come
 * back TOO_EARLY / GONE independently of what the catalog said.
 *
 * `signInRequired` is the one case where `available` is false but there IS
 * something behind the door: the match has a stream and the viewer is
 * anonymous. Watching is restricted to signed-in bettors, so the api
 * withholds the api-key — that withholding IS the gate, since the key is
 * what lets the SDK resolve playback and sign licence requests. The flag
 * exists so the storefront can offer a sign-in prompt rather than silently
 * hiding a stream that a logged-out bettor may have just been watching.
 */
export interface OddinVideoAvailability {
  available: boolean;
  /** A stream exists, but only signed-in bettors may watch it. */
  signInRequired: boolean;
  /** Oddin match URN, e.g. `od:match:3089416`. */
  matchUrn: string | null;
  /** Feed API base, e.g. `https://feed-dev.oddin-video.gg`. */
  baseUrl: string | null;
  /** Publishable api-key (`pk_test_…` / `pk_live_…`). */
  apiKey: string | null;
  /** Catalog status when resolved. Advisory — the SDK re-checks. */
  status: OddinVideoStatus | null;
  /** Scheduled start (ISO 8601) when the catalog carried one. */
  startsAt: string | null;
}
