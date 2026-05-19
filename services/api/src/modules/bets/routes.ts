// /bets endpoints. All require authentication.
//
//   POST /bets                 Place a bet (single or combo; up to 20 legs)
//   GET  /bets                 List current user's tickets, newest first
//   GET  /bets/:id             Fetch one ticket by id (must belong to user)

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { SUPPORTED_CURRENCIES } from "@oddzilla/types";
import { markets, matches, tournaments, categories } from "@oddzilla/db";
import { BetsService } from "./service.js";
import { NotFoundError } from "../../lib/errors.js";
import { validateOfferForBet } from "../zillaflash/engine.js";
import { BadRequestError } from "../../lib/errors.js";
import { nudgeBetPlaced } from "../zillapass/writer.js";
import {
  loadPromoVisibilityCascades,
  resolveVisible,
} from "../../lib/bettor-promo-visibility.js";

const placeBody = z.object({
  stakeMicro: z.string().regex(/^\d+$/, "stake must be a positive integer string"),
  idempotencyKey: z.string().min(8).max(64),
  currency: z.enum(SUPPORTED_CURRENCIES).optional(),
  // Optional explicit product. Server still validates leg-count against
  // bet_product_config (tiple ≥ 2, tippot ≥ 3) — see service.place().
  // betbuilder requires the betBuilder block to also be present.
  betType: z.enum(["single", "combo", "tiple", "tippot", "betbuilder"]).optional(),
  selections: z
    .array(
      z.object({
        marketId: z.string().regex(/^\d+$/),
        outcomeId: z.string().min(1).max(64),
        odds: z.string().regex(/^\d+(\.\d+)?$/),
        // Optional ZillaFlash offer id. When present the server replaces
        // the client-supplied `odds` with the engine's authoritative
        // boosted odds for this leg and applies a -2 s shave to the
        // effective live-bet acceptance delay if the offer was live.
        zillaFlashOfferId: z.string().uuid().optional(),
      }),
    )
    .min(1)
    .max(30), // tippot allows up to 30; cascade limit enforced server-side
  betBuilder: z
    .object({
      sessionId: z.string().min(1).max(128),
      expectedOddsX10000: z.number().int().positive(),
      selectionIds: z.array(z.string().min(3).max(256)).min(1).max(20),
    })
    .optional(),
  // Bettor opt-in for the live-bet acceptance delay window. When true,
  // the bet-delay worker re-prices the ticket at the current odds
  // instead of rejecting on drift. Server-side gating in service.place()
  // restricts the effect to single + combo; the flag is accepted but
  // ignored for other products so the client UX can stay product-agnostic.
  acceptOddsChanges: z.boolean().optional(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const placeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

export default async function betsRoutes(app: FastifyInstance) {
  const svc = new BetsService(app.db, app.redis);

  app.post("/bets", { config: placeRateLimit }, async (request) => {
    const u = request.requireAuth();
    const body = placeBody.parse(request.body);

    // ── ZillaFlash boost re-validation ────────────────────────────────
    // Resolve any boost offer ids BEFORE handing the placement off to
    // the BetsService. We re-validate against the in-memory engine
    // (id present, not expired, leg identity matches, boosted odds
    // within ±0.01 of what the client quoted). On success we OVERWRITE
    // the client-supplied `odds` with the engine's authoritative
    // boosted value so downstream code (RiskZilla, payout math,
    // ticket_selections.odds_at_placement) all see the same number.
    //
    // -2 s live delay shave: we surface a `hasLiveZillaFlash` flag the
    // service uses to subtract from the computed effective delay.
    let zillaFlashLiveBoost = false;
    const zillaFlashMarketIds: bigint[] = [];
    for (const s of body.selections) {
      if (!s.zillaFlashOfferId) continue;
      const v = await validateOfferForBet(app, {
        offerId: s.zillaFlashOfferId,
        marketId: s.marketId,
        outcomeId: s.outcomeId,
        quotedOdds: s.odds,
      });
      if (!v.ok) {
        // 400 carries enough detail for the slip to refresh the offer
        // and re-quote. We don't expose the engine's `authoritative
        // Odds` here — the slip will poll /catalog/zillaflash next.
        throw new BadRequestError(
          v.reason ?? "zillaflash_unknown_offer",
          v.reason ?? "zillaflash_unknown_offer",
        );
      }
      // Lock in the engine's authoritative odds for downstream math.
      s.odds = v.authoritativeOdds!;
      if (v.kind === "live") zillaFlashLiveBoost = true;
      zillaFlashMarketIds.push(BigInt(s.marketId));
    }

    // Per-bettor promo visibility cascade (migration 0071). If the
    // bettor has zillaflash hidden for any of these offers' matches /
    // tournaments / sports, reject placement rather than let them
    // claim a promo they can't see. Defense in depth — the storefront
    // already filters /catalog/zillaflash per the same cascade, but a
    // stale client or a direct API call must also bounce.
    if (zillaFlashMarketIds.length > 0) {
      const cascades = await loadPromoVisibilityCascades(app.db, u.id);
      if (!cascades.zillaflash.empty) {
        // Resolve each leg's market → match → tournament → sport so
        // the cascade can resolve. One round-trip for the whole bet.
        const metaRows = await app.db
          .select({
            marketId: markets.id,
            matchId: matches.id,
            tournamentId: tournaments.id,
            sportId: categories.sportId,
          })
          .from(markets)
          .innerJoin(matches, eq(matches.id, markets.matchId))
          .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
          .innerJoin(categories, eq(categories.id, tournaments.categoryId))
          .where(inArray(markets.id, zillaFlashMarketIds));
        const metaByMarket = new Map(
          metaRows.map((r) => [
            r.marketId.toString(),
            { matchId: r.matchId, tournamentId: r.tournamentId, sportId: r.sportId },
          ]),
        );
        for (const marketIdBig of zillaFlashMarketIds) {
          const meta = metaByMarket.get(marketIdBig.toString());
          if (!meta) continue; // already-rejected upstream by validateOfferForBet
          const visible = resolveVisible(cascades, "zillaflash", {
            matchId: meta.matchId,
            tournamentId: meta.tournamentId,
            sportId: meta.sportId,
          });
          if (!visible) {
            throw new BadRequestError(
              "zillaflash_offer_unavailable",
              "zillaflash_offer_unavailable",
            );
          }
        }
      }
    }

    const ticket = await svc.place(body, {
      userId: u.id,
      ip: request.ip ?? null,
      userAgent: request.headers["user-agent"] ?? null,
      zillaFlashLiveBoost,
    });
    // Best-effort engagement nudge — bumps the right `bets_prematch`
    // or `bets_live` ZillaPass task based on the ticket's leg
    // statuses. Errors are caught + logged inside the writer.
    await nudgeBetPlaced(app, u.id, ticket.id);
    return { ticket };
  });

  app.get("/bets", async (request) => {
    const u = request.requireAuth();
    const q = listQuery.parse(request.query);
    const list = await svc.listForUser(u.id, q.limit);
    return { tickets: list };
  });

  app.get("/bets/:id", async (request) => {
    const u = request.requireAuth();
    const params = z
      .object({ id: z.string().uuid() })
      .parse(request.params);
    const ticket = await svc.getOne(u.id, params.id);
    if (!ticket) throw new NotFoundError("ticket_not_found", "ticket_not_found");
    return { ticket };
  });
}
