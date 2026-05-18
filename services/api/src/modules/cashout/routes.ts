// /v1/tickets/:id/cashout — quote + accept endpoints.
//
//   GET  /tickets/:id/cashout/quote   Issue a fresh offer
//   POST /tickets/:id/cashout         Accept a previously-issued quote

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { tickets, ticketSelections } from "@oddzilla/db";
import { sql } from "drizzle-orm";
import { CashoutService } from "./service.js";
import { emitNotification } from "../community/notifications.js";
import type { BetCashedOutPayload } from "@oddzilla/types";

const ticketParam = z.object({ id: z.string().uuid() });

const acceptBody = z.object({
  quoteId: z.string().uuid(),
  expectedOfferMicro: z.string().regex(/^\d+$/),
});

// Per-user rate-limit keys: many users can sit behind a single corporate
// or ISP NAT, so per-IP limits collide unfairly. The auth plugin's
// preHandler populates request.user before the handler runs; for the
// (registration-order-dependent) case where keyGenerator fires before
// the auth hook, fall back to IP rather than failing closed — the
// requireAuth() call inside the handler is the real authn gate.
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

      // Fire-and-forget in-app bell notification for the cashout.
      // Mirrors what services/settlement (Go) writes for bet_won via
      // EnqueueBetWonBellNotification — the cashout path is TS-side so
      // we use the existing emitNotification helper directly. Best-
      // effort: the cashout is durably committed; a bell-write failure
      // must not fail the request. Migration 0059 added the
      // bet_cashed_out enum value and the prefBetSettlements gate.
      void (async () => {
        const [t] = await app.db
          .select({
            betType: tickets.betType,
            currency: tickets.currency,
            stakeMicro: tickets.stakeMicro,
          })
          .from(tickets)
          .where(eq(tickets.id, params.id))
          .limit(1);
        if (!t) return;
        const legRows = await app.db
          .select({ legCount: sql<number>`COUNT(*)::int` })
          .from(ticketSelections)
          .where(eq(ticketSelections.ticketId, params.id));
        const legCount = legRows[0]?.legCount ?? 1;
        const payload: BetCashedOutPayload = {
          ticketId: params.id,
          betType: t.betType,
          currency: t.currency,
          stakeMicro: t.stakeMicro.toString(),
          actualPayoutMicro: result.payoutMicro.toString(),
          numLegs: legCount,
        };
        await emitNotification(app, {
          userId: u.id,
          type: "bet_cashed_out",
          // System emit — no actor. Mirrors competition_deadline.
          actorId: null,
          payload,
          // Apply-once within 24h on (user, type, ticket_id). A
          // double-tap on accept can't happen (cashouts has a
          // accepted-status guard) but a manual replay tool could.
          groupKey: `bet_cashed_out:${params.id}`,
          deepLink: "/bets",
        });
      })().catch((err: unknown) => {
        app.log.warn(
          { err, ticketId: params.id },
          "bet_cashed_out bell emit failed; cashout already committed",
        );
      });

      reply.code(200);
      return {
        ticketId: params.id,
        payoutMicro: result.payoutMicro.toString(),
        cashedOutAt: result.cashedOutAt.toISOString(),
      };
    },
  );
}
