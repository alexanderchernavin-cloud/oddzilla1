// /catalog/zillaflash — the storefront polls this every couple of
// seconds. The engine itself runs a 1 s rotation timer in the
// background (registered separately in server.ts via
// startZillaFlashRotation); this handler just snapshots current state.
//
// Anonymous, no auth, no rate limit configured here — Caddy already
// caps the per-IP rate at the front door, and the response is tiny
// (≤4 offers × outcome snapshot). Cache-Control: no-store because the
// payload changes every second.

import type { FastifyInstance } from "fastify";
import { getActiveOffers } from "./engine.js";

export default async function zillaflashRoutes(app: FastifyInstance) {
  app.get("/catalog/zillaflash", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return getActiveOffers(app);
  });
}
