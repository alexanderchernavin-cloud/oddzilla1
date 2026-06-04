// Entry point. Load .env from the package directory first (this service runs
// on an operator PC, not in docker, so there's no compose env), then start.
import "dotenv/config";
import { run } from "./worker.js";

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
