// Tiny /healthz server so the compose healthcheck has something to
// probe (project hard limit: no service without a healthcheck). The
// process is healthy as long as its loop is alive — an unreachable
// image backend or an empty token is a WAITING state by design (the
// queue holds jobs), never an unhealthy one.

import { createServer } from "node:http";
import { log } from "./logger.js";

export interface HealthState {
  /** "running" | "parked" (missing required env — graceful idle). */
  mode: string;
  lastPollAt: string | null;
  backendUp: boolean | null;
}

export const healthState: HealthState = {
  mode: "starting",
  lastPollAt: null,
  backendUp: null,
};

export function startHealthServer(port: number): void {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...healthState }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, "0.0.0.0", () => {
    log.info({ port }, "health server listening");
  });
}
