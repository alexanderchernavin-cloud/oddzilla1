import "dotenv/config";
import { loadConfig } from "./config.js";
import { healthState, startHealthServer } from "./health.js";
import { log } from "./logger.js";
import { runWorker } from "./worker.js";

const healthPort = Number(process.env.HEALTH_PORT ?? "9091");
startHealthServer(Number.isFinite(healthPort) ? healthPort : 9091);

const cfg = loadConfig();
if (!cfg) {
  // Graceful idle — same convention every credential-gated service in
  // the stack follows: boot cleanly, warn, serve health only. The
  // container stays green and starts working after the env is filled
  // and the service is recreated.
  healthState.mode = "parked";
  log.warn(
    "ODDZILLA_API_BASE / BANNER_GEN_TOKEN not set — parked (health only)",
  );
  // Keep the process alive without busy-waiting.
  setInterval(() => {}, 1 << 30);
} else {
  await runWorker(cfg);
}
