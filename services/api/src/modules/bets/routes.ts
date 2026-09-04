// /bets endpoints. All require authentication.
//
//   POST /bets                 Place a bet (single or combo; up to 20 legs)
//   GET  /bets                 List current user's tickets, newest first
//   GET  /bets/:id             Fetch one ticket by id (must belong to user)

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { SUPPORTED_CURRENCIES, type BetIntentResponse } from "@oddzilla/types";
import { loadAuthEnv } from "@oddzilla/config";
import { markets, matches, tournaments, categories } from "@oddzilla/db";
import { BetsService } from "./service.js";
import {
  checkIntent,
  deriveIntentKey,
  newIntentClaims,
  signIntent,
} from "./intent.js";
import { loadBotControls } from "../../lib/riskzilla/bot-controls.js";
import { NotFoundError } from "../../lib/errors.js";
import { validateOfferForBet } from "../zillaflash/engine.js";
import {
  loadViewerRiskScore,
  validateCustomBoostForBet,
} from "../../lib/boosted-odds.js";
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
        // Optional Custom Boosted Odds rule id (migration 0085). The
        // server re-validates the rule (active, covers this market,
        // bettor passes the Min Risk Score gate), recomputes the
        // boosted price from current published_odds, and replaces the
        // client-supplied `odds` with the authoritative value. Ignored
        // when zillaFlashOfferId is also present (the offer wins).
        boostedOddsRuleId: z.string().uuid().optional(),
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
  // Placement intent token from POST /bets/intent (migration 0097).
  // Required when riskzilla_bot_controls.intent_required is on.
  intentToken: z.string().min(16).max(2048).optional(),
});

const intentBody = z.object({
  selections: z
    .array(
      z.object({
        marketId: z.string().regex(/^\d+$/),
        outcomeId: z.string().min(1).max(64),
      }),
    )
    .min(1)
    .max(30),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const placeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

export default async function betsRoutes(app: FastifyInstance) {
  const svc = new BetsService(app.db, app.redis);
  // Dedicated HMAC key for placement intent tokens, derived from the JWT
  // secret so an intent can never be confused with an access token.
  const intentKey = deriveIntentKey(loadAuthEnv().jwtSecret);

  // ── Placement intent (migration 0097) ─────────────────────────────
  // The slip calls this whenever its selection SET changes (not on price
  // ticks) and hands the token to POST /bets. Stateless HMAC claims bound
  // to (user, selection set, issued-at); the placement route measures the
  // quote -> place gap against riskzilla_bot_controls.min_human_ms and
  // burns the nonce so a token can't be spent twice.
  app.post(
    "/bets/intent",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request): Promise<BetIntentResponse> => {
      const u = request.requireAuth();
      const body = intentBody.parse(request.body);
      const controls = await loadBotControls(app.db);
      const now = Date.now();
      const claims = newIntentClaims(u.id, body.selections, now);
      return {
        token: signIntent(claims, intentKey),
        issuedAt: now,
        expiresAt: now + controls.intentTtlSeconds * 1000,
        minHumanMs: controls.minHumanMs,
        required: controls.intentRequired,
      };
    },
  );

  // Best-effort single-use: burn the token nonce in Redis for its TTL,
  // keyed to the placement's idempotency key so a network retry of the
  // SAME placement passes while a second ticket on the same token does
  // not. Redis is a cache here — if it is unavailable the signature +
  // TTL + human-time checks still hold and we let the placement through
  // rather than take the sportsbook down with the cache.
  async function consumeIntentNonce(
    nonce: string,
    idempotencyKey: string,
    ttlSeconds: number,
  ): Promise<void> {
    const key = `bet:intent:used:${nonce}`;
    try {
      const set = await app.redis.set(key, idempotencyKey, "EX", ttlSeconds + 60, "NX");
      if (set) return;
      const holder = await app.redis.get(key);
      if (holder === idempotencyKey) return;
    } catch (err) {
      app.log.warn({ err, component: "bet-intent" }, "intent nonce check skipped (redis)");
      return;
    }
    throw new BadRequestError("intent_replayed", "intent_replayed");
  }

  app.post("/bets", { config: placeRateLimit }, async (request) => {
    const u = request.requireAuth();
    const body = placeBody.parse(request.body);

    // ── Placement intent gate ─────────────────────────────────────────
    // Cheapest check first: one HMAC, no I/O. `intent_required` is the
    // operator's emergency off-switch — when off we still read a valid
    // token for the confirm-time measurement but never reject on it.
    const controls = await loadBotControls(app.db);
    let quoteIssuedAtMs: number | null = null;
    if (body.intentToken) {
      const check = checkIntent(body.intentToken, intentKey, {
        userId: u.id,
        selections: body.selections,
        nowMs: Date.now(),
        ttlMs: controls.intentTtlSeconds * 1000,
        minHumanMs: controls.minHumanMs,
      });
      if (check.claims) quoteIssuedAtMs = check.claims.t;
      if (check.ok) {
        if (controls.intentRequired) {
          await consumeIntentNonce(
            check.claims.n,
            body.idempotencyKey,
            controls.intentTtlSeconds,
          );
        }
      } else if (controls.intentRequired) {
        throw new BadRequestError(check.reason, check.reason);
      }
    } else if (controls.intentRequired) {
      throw new BadRequestError("intent_required", "intent_required");
    }

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

    // ── Custom Boosted Odds re-validation (migration 0085) ───────────
    // Same shape as the ZillaFlash block: validate the rule against the
    // live catalog, then OVERWRITE the client-supplied `odds` with the
    // recomputed boosted value so downstream math (RiskZilla, payout,
    // ticket_selections.odds_at_placement) all see the same number.
    // A leg carrying both ids keeps the ZillaFlash offer (its odds were
    // already locked above) and drops the custom rule.
    const hasCustomBoost = body.selections.some(
      (s) => s.boostedOddsRuleId && !s.zillaFlashOfferId,
    );
    if (hasCustomBoost) {
      const riskScore = await loadViewerRiskScore(app.db, u.id);
      for (const s of body.selections) {
        if (!s.boostedOddsRuleId) continue;
        if (s.zillaFlashOfferId) {
          delete s.boostedOddsRuleId;
          continue;
        }
        const v = await validateCustomBoostForBet(app, {
          ruleId: s.boostedOddsRuleId,
          marketId: s.marketId,
          outcomeId: s.outcomeId,
          quotedOdds: s.odds,
          riskScore,
        });
        if (!v.ok) {
          // 400 carries the reason; the slip drops the boost tag and
          // re-fetches /catalog/matches/:id/boosted-odds for a fresh
          // quote.
          throw new BadRequestError(v.reason, v.reason);
        }
        s.odds = v.authoritativeOdds;
      }
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
      quoteIssuedAtMs,
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
