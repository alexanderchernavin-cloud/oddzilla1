// /v1/tickets/:id/cashout — quote + accept endpoints.
//
//   GET  /tickets/:id/cashout/quote   Issue a fresh offer (10s TTL)
//   POST /tickets/:id/cashout         Accept a previously-issued quote

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CashoutService } from "./service.js";

const ticketParam = z.object({ id: z.string().uuid() });

const acceptBody = z.object({
  quoteId: z.string().uuid(),
  expectedOfferMicro: z.string().regex(/^\d+$/),
});

// Rate-limit cashout quotes — they hit several joined tables per call so a
// runaway client could spike DB load. 60/min/user is plenty for a UI that
// repolls every 1-2 seconds.
const quoteRateLimit = {
  rateLimit: { max: 60, timeWindow: "1 minute" },
};

const acceptRateLimit = {
  rateLimit: { max: 20, timeWindow: "1 minute" },
};

export default async function cashoutRoutes(app: FastifyInstance) {
  const svc = new CashoutService(app.db, app.redis);

  app.get(
    "/tickets/:id/cashout/quote",
    { config: quoteRateLimit },
    async (request) => {
      const u = request.requireAuth();
      const params = ticketParam.parse(request.params);
      const quote = await svc.quote(u.id, params.id);
      return { quote };
    },
  );

  app.post(
    "/tickets/:id/cashout",
    { config: acceptRateLimit },
    async (request, reply) => {
      const u = request.requireAuth();
      const params = ticketParam.parse(request.params);
      const body = acceptBody.parse(request.body);
      const result = await svc.accept(
        u.id,
        params.id,
        body.quoteId,
        BigInt(body.expectedOfferMicro),
      );
      reply.code(200);
      return {
        ticketId: params.id,
        payoutMicro: result.payoutMicro.toString(),
        cashedOutAt: result.cashedOutAt.toISOString(),
      };
    },
  );
}
