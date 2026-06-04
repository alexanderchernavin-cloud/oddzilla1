// Worker config — read entirely from process.env. This service runs on an
// operator PC (NOT in the docker stack), so it has no DATABASE_URL / REDIS_URL
// and deliberately does not import @oddzilla/config. It only needs to reach
// the public API webhook endpoints + a local LM Studio server.

export interface BotConfig {
  /** Public API base, including the /api prefix, e.g. https://oddzilla.cc/api */
  apiBase: string;
  /** Shared secret — must equal SUPPORT_AI_BOT_TOKEN on the server. */
  botToken: string;
  /** LM Studio OpenAI-compatible server base, e.g. http://localhost:1234 */
  lmStudioBaseUrl: string;
  /** Model id; null = auto-discover the loaded model via /v1/models. */
  lmStudioModel: string | null;
  /** Optional bearer for LM Studio (most local setups ignore it). */
  lmStudioApiKey: string | null;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  pendingBatch: number;
  maxReplyChars: number;
  temperature: number;
  maxTokens: number;
  requestTimeoutMs: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    // eslint-disable-next-line no-console
    console.error(`[support-ai-bot] missing required env ${name}`);
    process.exit(1);
  }
  return v.trim();
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(): BotConfig {
  return {
    apiBase: req("ODDZILLA_API_BASE").replace(/\/+$/, ""),
    botToken: req("SUPPORT_AI_BOT_TOKEN"),
    lmStudioBaseUrl: opt("LM_STUDIO_BASE_URL", "http://localhost:1234").replace(
      /\/+$/,
      "",
    ),
    lmStudioModel: process.env.LM_STUDIO_MODEL?.trim() || null,
    lmStudioApiKey: process.env.LM_STUDIO_API_KEY?.trim() || null,
    pollIntervalMs: num("BOT_POLL_INTERVAL_MS", 4000),
    heartbeatIntervalMs: num("BOT_HEARTBEAT_INTERVAL_MS", 15000),
    pendingBatch: num("BOT_PENDING_BATCH", 8),
    maxReplyChars: num("BOT_MAX_REPLY_CHARS", 1500),
    temperature: num("BOT_TEMPERATURE", 0.3),
    maxTokens: num("BOT_MAX_TOKENS", 512),
    requestTimeoutMs: num("BOT_LM_TIMEOUT_MS", 60000),
  };
}
