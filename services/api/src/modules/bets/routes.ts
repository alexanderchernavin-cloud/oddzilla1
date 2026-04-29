// /bets endpoints. All require authentication.
//
//   POST /bets                 Place a bet (single or combo; up to 20 legs)
//   GET  /bets                 List current user's tickets, newest first
//   GET  /bets/:id             Fetch one ticket by id (must belong to user)

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SUPPORTED_CURRENCIES } from "@oddzilla/types";
import { BetsService } from "./service.js";
import { NotFoundError } from "../../lib/errors.js";

const placeBody = z.object({
  stakeMicro: z.string().regex(/^\d+$/, "stake must be a positive integer string"),
  idempotencyKey: z.string().min(8).max(64),
  currency: z.enum(SUPPORTED_CURRENCIES).optional(),
  // Optional explicit product. Server still validates leg-count against
  // bet_product_config (tiple ≥ 2, tippot ≥ 3) — see service.place().
  betType: z.enum(["single", "combo", "tiple", "tippot"]).optional(),
  selections: z
    .array(
      z.object({
        marketId: z.string().regex(/^\d+$/),
        outcomeId: z.string().min(1).max(64),
        odds: z.string().regex(/^\d+(\.\d+)?$/),
      }),
    )
    .min(1)
    .max(30), // tippot allows up to 30; cascade limit enforced server-side
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
    const ticket = await svc.place(body, {
      userId: u.id,
      ip: request.ip ?? null,
      userAgent: request.headers["user-agent"] ?? null,
    });
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
