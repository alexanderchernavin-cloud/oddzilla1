// /v1/tickets/:id/cashout — quote + accept endpoints.
//
//   GET  /tickets/:id/cashout/quote   Issue a fresh offer
//   POST /tickets/:id/cashout         Accept a previously-issued quote

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CashoutService } from "./service.js";

const ticketParam = z.object({ id: z.string().uuid() });

const acceptBody = z.object({
  quoteId: z.string().uuid(),
  expectedOfferMicro: z.string().regex(/^\d+$/),
});

// Per-user rate-limit keys: many users can sit behind a single corporate
// or ISP NAT, so per-IP limits collide unfairly. After requireAuth() the
// userId is the right unit. Falls back to IP for the (impossible-here)
// case where preHandler hasn't decorated the request yet.
function userKey(request: FastifyRequest): string {
  return request.user?.id ?? request.ip ?? "anon";
}

// Quote calls poll on a 5s cadence with bursts at WS-driven re-renders.
// 240/min/user comfortably covers 1+ tabs and short retry storms.
const quoteRateLimit = {
  rateLimit: {
    max: 240,
    timeWindow: "1 minute",
    keyGenerator: userKey,
  },
};

// Accept is a deliberate user action — kept tighter, but per-user.
const acceptRateLimit = {
  rateLimit: {
    max: 30,
    timeWindow: "1 minute",
    keyGenerator: userKey,
  },
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
