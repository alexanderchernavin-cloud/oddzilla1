// /catalog/matches/:matchId/zillabuild — pre-built BetBuilder cards the
// storefront overlays on the PREMATCH match page. The heavy lifting (OBB
// generation / persistence / re-quote) lives in engine.ts and is shared
// across viewers + Redis-cached; this handler just applies the per-bettor
// visibility gate on top.
//
// Anonymous tolerated. When authed, ZillaBuild participates in the
// per-bettor promo-visibility cascade (migration 0071, kind "zillabuild")
// — match > tournament > sport > global, first explicit row wins, default
// visible. Because every card belongs to the SAME match, one cascade
// resolve decides the whole section. The gate is display-only: a card just
// pre-loads the standard BetBuilder slip, so there's nothing to police at
// placement. Cache-Control: no-store because odds are live-ish and the
// payload varies per user.

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { matches, tournaments, categories } from "@oddzilla/db";
import {
  loadPromoVisibilityCascades,
  resolveVisible,
} from "../../lib/bettor-promo-visibility.js";
import { getZillaBuildForMatch } from "./engine.js";

export default async function zillabuildRoutes(app: FastifyInstance) {
  app.get(
    "/catalog/matches/:matchId/zillabuild",
    // Per-IP scraper friction (2026-09-03) — one call per prematch
    // match-page mount. See the /catalog/sports/:slug note for how
    // request.ip stays the real visitor.
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
    reply.header("cache-control", "no-store");
    const { matchId } = z
      .object({ matchId: z.coerce.bigint() })
      .parse(request.params);

    const response = await getZillaBuildForMatch(app, matchId);

    // Nothing to gate: anonymous, feature off, or no cards.
    if (!request.user || !response.enabled || response.cards.length === 0) {
      return response;
    }

    const cascades = await loadPromoVisibilityCascades(app.db, request.user.id);
    // Fast path — this bettor has no zillabuild overrides at all.
    if (cascades.zillabuild.empty) return response;

    const [meta] = await app.db
      .select({ tournamentId: tournaments.id, sportId: categories.sportId })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .where(eq(matches.id, matchId))
      .limit(1);

    const visible = resolveVisible(cascades, "zillabuild", {
      matchId,
      tournamentId: meta?.tournamentId ?? null,
      sportId: meta?.sportId ?? null,
    });
    return visible ? response : { ...response, cards: [] };
  });
}
