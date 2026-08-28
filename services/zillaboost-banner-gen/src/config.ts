// Worker config — read entirely from process.env. This service runs on an
// operator PC (NOT in the docker stack), so it has no DATABASE_URL /
// REDIS_URL and deliberately does not import @oddzilla/config. It needs to
// reach three things: the public API webhook endpoints, a local LLM
// (LM Studio, for research summarisation + image-prompt authoring), and a
// local image-generation server.
//
// The image backend speaks the AUTOMATIC1111/Forge-compatible
// `/sdapi/v1/txt2img` JSON API by default (SD WebUI, Forge, and SD.Next
// all expose it). If the local setup runs something else, point
// IMAGE_API_BASE at any server that accepts the same shape — the whole
// exchange lives in imagegen.ts, one file to swap.

export interface WorkerConfig {
  /** Public API base, including the /api prefix, e.g. https://oddzilla.cc/api */
  apiBase: string;
  /** Shared secret — must equal BANNER_GEN_TOKEN on the server. */
  token: string;

  /** LM Studio OpenAI-compatible server base, e.g. http://192.168.50.37:1234 */
  lmStudioBaseUrl: string;
  /** Model id; null = auto-discover the loaded model via /v1/models. */
  lmStudioModel: string | null;

  /** A1111-compatible image server base, e.g. http://192.168.50.37:7860 */
  imageApiBase: string;
  /** Optional checkpoint override (sent as override_settings). */
  imageModel: string | null;
  imageWidth: number;
  imageHeight: number;
  imageSteps: number;
  imageCfgScale: number;
  imageSampler: string;
  /** Extra negative-prompt terms appended to the built-in set. */
  imageNegativeExtra: string;

  /** Poll cadence while everything is reachable. */
  pollIntervalMs: number;
  /**
   * Backoff when the LOCAL image backend is unreachable — the operator's
   * "retry once per hour" requirement. While backed off the worker does
   * not claim jobs, so the server-side queue keeps them and no attempts
   * are burned.
   */
  backendRetryMs: number;
  /** Per-request timeout against the local services. */
  requestTimeoutMs: number;
  /** txt2img can legitimately run minutes on a big model. */
  imageTimeoutMs: number;
  /** Wikipedia Action API endpoint backing entity research. */
  wikipediaApiBase: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    // eslint-disable-next-line no-console
    console.error(`[zillaboost-banner-gen] missing required env ${name}`);
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
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): WorkerConfig {
  return {
    apiBase: req("ODDZILLA_API_BASE").replace(/\/+$/, ""),
    token: req("BANNER_GEN_TOKEN"),
    lmStudioBaseUrl: opt("LM_STUDIO_BASE_URL", "http://localhost:1234").replace(
      /\/+$/,
      "",
    ),
    lmStudioModel: process.env.LM_STUDIO_MODEL?.trim() || null,
    imageApiBase: opt("IMAGE_API_BASE", "http://localhost:7860").replace(
      /\/+$/,
      "",
    ),
    imageModel: process.env.IMAGE_MODEL?.trim() || null,
    // 3:1 landscape — the storefront renders wide banner strips.
    // 1152x384 divides by 64 (SDXL-friendly) and reads well downscaled.
    imageWidth: num("IMAGE_WIDTH", 1152),
    imageHeight: num("IMAGE_HEIGHT", 384),
    imageSteps: num("IMAGE_STEPS", 28),
    imageCfgScale: num("IMAGE_CFG_SCALE", 6),
    imageSampler: opt("IMAGE_SAMPLER", "Euler a"),
    imageNegativeExtra: opt("IMAGE_NEGATIVE_EXTRA", ""),
    pollIntervalMs: num("POLL_INTERVAL_MS", 30_000),
    backendRetryMs: num("BACKEND_RETRY_MS", 60 * 60 * 1000),
    requestTimeoutMs: num("REQUEST_TIMEOUT_MS", 60_000),
    imageTimeoutMs: num("IMAGE_TIMEOUT_MS", 10 * 60 * 1000),
    wikipediaApiBase: opt(
      "WIKIPEDIA_API_BASE",
      "https://en.wikipedia.org/w/api.php",
    ),
  };
}
