// Entry point.
//
// Loads .env from the package directory for a PC-side run; in the docker
// stack compose supplies the environment and there is no .env to find,
// which dotenv treats as a no-op.
//
// Graceful idle: when the required credentials are absent the worker PARKS
// — logs a warning, keeps the liveness file fresh, and never starts the
// loop — rather than exiting. That is the convention every credential-gated
// service in this repo follows, and here it is load-bearing: the compose
// service runs with `restart: unless-stopped`, so an exit would crashloop
// the container on any box where SUPPORT_AI_BOT_TOKEN is not yet set.
//
// worker.ts resolves its config at module scope, so the check has to happen
// BEFORE it is imported — hence the dynamic import below.

import "dotenv/config";
import { touchLiveness } from "./liveness.js";

const REQUIRED = ["ODDZILLA_API_BASE", "SUPPORT_AI_BOT_TOKEN"] as const;
const missing = REQUIRED.filter((name) => !process.env[name]?.trim());

// Keep the healthcheck green on both paths. Parked is a correct state, not
// a broken one, so a credential-less container should read healthy.
touchLiveness();
const beat = setInterval(touchLiveness, 30_000);

if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(
    `[support-ai-bot] disabled: missing ${missing.join(", ")} — parking. ` +
      `Set them and restart to enable the assistant; support threads fall ` +
      `back to humans in the meantime.`,
  );
} else {
  clearInterval(beat);
  const { run } = await import("./worker.js");
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
