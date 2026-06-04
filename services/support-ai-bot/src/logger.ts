import { pino } from "pino";

// Structured JSON logs, matching the rest of the stack (service + event
// fields). Override level with LOG_LEVEL=debug while tuning prompts.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "support-ai-bot" },
});
