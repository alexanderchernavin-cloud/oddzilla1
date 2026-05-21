// /catalog/zillaflash — the storefront polls this every couple of
// seconds. The engine itself runs a 1 s rotation timer in the
// background (registered separately in server.ts via
// startZillaFlashRotation); this handler just snapshots current state.
//
// Anonymous tolerated — no auth required. When the request IS authed,
// we additionally filter offers in two ways:
//   1. against the bettor's promo-visibility cascade (migration 0071)
//      so VIPs / sharps the operator has tagged hidden don't see
//      ZillaFlash on the storefront;
//   2. against the bettor's hidden_sports preference (migration 0072)
//      so a sport the user has hidden in the sidebar drops out of the
//      ZillaFlash row too — same surface, same hide intent.
// Anonymous browsers keep seeing the full offer set. Cache-Control:
// no-store because the payload changes every second AND varies per
// user.
//
// Filter strategy: at most 4 offers per response × one (matchId →
// sportId, sportSlug, tournamentId) lookup. Trivial overhead and the
// metadata join already happens whenever either filter is active.

import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import {
  matches,
  sports,
  tournaments,
  categories,
  users,
} from "@oddzilla/db";
import type { ZillaFlashOffer } from "@oddzilla/types";
import {
  loadPromoVisibilityCascades,
  resolveVisible,
} from "../../lib/bettor-promo-visibility.js";
import { getActiveOffers } from "./engine.js";

export default async function zillaflashRoutes(app: FastifyInstance) {
  app.get("/catalog/zillaflash", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const response = await getActiveOffers(app);

    // Anonymous → public payload unchanged.
    if (!request.user) return response;
    const [cascades, [userRow]] = await Promise.all([
      loadPromoVisibilityCascades(app.db, request.user.id),
      app.db
        .select({ hiddenSports: users.hiddenSports })
        .from(users)
        .where(eq(users.id, request.user.id))
        .limit(1),
    ]);
    const hiddenSet = new Set(userRow?.hiddenSports ?? []);
    // Fast path: nothing to filter for this bettor — visibility
    // cascade is empty AND no hidden sports — return the public
    // payload unchanged. Saves a metadata round-trip for the long
    // tail of users who never opened the customisation panel.
    if (cascades.zillaflash.empty && hiddenSet.size === 0) return response;

    // Lookup each offer's (sportSlug, sportId, tournamentId) so both
    // filters resolve from a single round-trip per request.
    const allOffers = [...response.prematch, ...response.live];
    if (allOffers.length === 0) return response;
    const matchIds = Array.from(
      new Set(allOffers.map((o) => BigInt(o.matchId))),
    );
    const metaRows = await app.db
      .select({
        id: matches.id,
        tournamentId: tournaments.id,
        sportId: categories.sportId,
        sportSlug: sports.slug,
      })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .innerJoin(sports, eq(sports.id, categories.sportId))
      .where(inArray(matches.id, matchIds));
    const metaByMatch = new Map(
      metaRows.map((r) => [
        r.id.toString(),
        { sportId: r.sportId, sportSlug: r.sportSlug, tournamentId: r.tournamentId },
      ]),
    );

    const isVisible = (o: ZillaFlashOffer): boolean => {
      const meta = metaByMatch.get(o.matchId);
      if (!meta) return true; // safe default — match metadata missing, don't hide
      // Bettor's hidden_sports first — same intent as filtering the
      // match out of /upcoming etc.
      if (hiddenSet.has(meta.sportSlug)) return false;
      return resolveVisible(cascades, "zillaflash", {
        matchId: BigInt(o.matchId),
        tournamentId: meta.tournamentId,
        sportId: meta.sportId,
      });
    };
    const prematch = response.prematch.filter(isVisible);
    const live = response.live.filter(isVisible);
    return {
      prematch,
      live,
      // `empty` mirrors the engine: true when BOTH rotations are empty
      // for this viewer (post-filter).
      empty: prematch.length === 0 && live.length === 0,
    };
  });
}
