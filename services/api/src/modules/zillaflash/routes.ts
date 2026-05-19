// /catalog/zillaflash — the storefront polls this every couple of
// seconds. The engine itself runs a 1 s rotation timer in the
// background (registered separately in server.ts via
// startZillaFlashRotation); this handler just snapshots current state.
//
// Anonymous tolerated — no auth required. When the request IS authed,
// we additionally filter offers against the bettor's promo-visibility
// cascade (migration 0071) so VIPs / sharps the operator has tagged
// hidden don't see ZillaFlash on the storefront. Anonymous browsers
// keep seeing the full offer set. Cache-Control: no-store because the
// payload changes every second AND now varies per user.
//
// Filter strategy: at most 4 offers per response × one (matchId →
// sportId, tournamentId) lookup. Trivial overhead and only fires when
// the user has at least one zillaflash override row.

import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import {
  matches,
  tournaments,
  categories,
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
    const cascades = await loadPromoVisibilityCascades(app.db, request.user.id);
    if (cascades.zillaflash.empty) return response;

    // Lookup each visible match's (sportId, tournamentId) so the
    // cascade can resolve sport / tournament / match overrides. One
    // round-trip for the whole response.
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
      })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .where(inArray(matches.id, matchIds));
    const metaByMatch = new Map(
      metaRows.map((r) => [r.id.toString(), { sportId: r.sportId, tournamentId: r.tournamentId }]),
    );

    const isVisible = (o: ZillaFlashOffer): boolean => {
      const meta = metaByMatch.get(o.matchId);
      if (!meta) return true; // safe default — match metadata missing, don't hide
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
