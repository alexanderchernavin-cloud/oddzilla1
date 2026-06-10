// Per-viewer ZillaFlash filter inputs — the promo-visibility cascades +
// hidden-sports set — cached in-process.
//
// Why: the storefront polls /catalog/zillaflash every ~2 s for the whole
// session. For a signed-in viewer the route needs these two lookups to
// filter the shared offer payload, which used to mean two Postgres
// round trips per poll per viewer, forever — a steady ~1 query/s/user
// for data that changes only when an admin tags the bettor or the
// bettor edits their hidden sports. Both writers are in this same api
// process (single instance — only web has replicas), so a Map with
// explicit invalidation is exact, not best-effort; the TTL is just a
// backstop against a missed invalidation path added later.
//
// Scope guard: this cache backs the polled DISPLAY surface only.
// Placement-time checks (ZillaFlash leg rejection, combi-boost
// stripping) keep their live loadPromoVisibilityCascades reads — a
// stale read there would be a promo-grant bug, not a cosmetic lag.

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { users } from "@oddzilla/db";
import {
  loadPromoVisibilityCascades,
  type BettorPromoCascades,
} from "../../lib/bettor-promo-visibility.js";

export interface ZillaFlashViewerPrefs {
  cascades: BettorPromoCascades;
  hiddenSports: Set<string>;
}

const TTL_MS = 30_000;
// Backstop bound — at one entry per signed-in poller this is far above
// MVP concurrency; if it's ever hit we drop the oldest-inserted half
// rather than grow without limit.
const MAX_ENTRIES = 5_000;

const cache = new Map<string, { at: number; prefs: ZillaFlashViewerPrefs }>();

export async function loadZillaFlashViewerPrefs(
  app: FastifyInstance,
  userId: string,
): Promise<ZillaFlashViewerPrefs> {
  const hit = cache.get(userId);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.prefs;

  const [cascades, [userRow]] = await Promise.all([
    loadPromoVisibilityCascades(app.db, userId),
    app.db
      .select({ hiddenSports: users.hiddenSports })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  ]);
  const prefs: ZillaFlashViewerPrefs = {
    cascades,
    hiddenSports: new Set(userRow?.hiddenSports ?? []),
  };

  if (cache.size >= MAX_ENTRIES) {
    let toDrop = Math.floor(MAX_ENTRIES / 2);
    for (const key of cache.keys()) {
      if (toDrop-- <= 0) break;
      cache.delete(key);
    }
  }
  cache.set(userId, { at: now, prefs });
  return prefs;
}

/** Drop a viewer's cached prefs. Called by the writers: the admin
 * promo-visibility mutations and the bettor's own hidden-sports PUT. */
export function invalidateZillaFlashViewerPrefs(userId: string): void {
  cache.delete(userId);
}
