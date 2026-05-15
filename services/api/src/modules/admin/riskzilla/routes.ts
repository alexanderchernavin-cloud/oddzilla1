// Aggregator for /admin/riskzilla/* — wires every sub-module under
// one Fastify register so server.ts stays clean.

import type { FastifyInstance } from "fastify";
import settingsRoutes from "./settings.js";
import bankRoutes from "./bank.js";
import bettorsRoutes from "./bettors.js";
import eventsRoutes from "./events.js";
import dashboardRoutes from "./dashboard.js";
import liveDelayRoutes from "./live-delay.js";

export default async function riskzillaRoutes(app: FastifyInstance) {
  await app.register(settingsRoutes);
  await app.register(bankRoutes);
  await app.register(bettorsRoutes);
  await app.register(eventsRoutes);
  await app.register(dashboardRoutes);
  await app.register(liveDelayRoutes);
}
