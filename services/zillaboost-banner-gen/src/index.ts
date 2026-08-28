import "dotenv/config";
import { loadConfig } from "./config.js";
import { runWorker } from "./worker.js";

await runWorker(loadConfig());
