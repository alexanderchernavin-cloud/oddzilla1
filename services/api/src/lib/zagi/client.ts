// ZillaAGI — the in-house language model, reached over an
// OpenAI-compatible chat-completions endpoint.
//
// One thin client so every ZAGI caller inherits the same three lessons
// this codebase has already paid for once (see the support-ai-bot notes
// in CLAUDE.md):
//
//   1. The base URL INCLUDES the `/v1`. We post to `<base>/chat/completions`
//      directly rather than through a client that appends a version
//      segment, so a base of `https://llm.oddin.gg` silently 404s.
//   2. The model must be PINNED. `/v1/models` lists more than one and
//      auto-discovery takes an arbitrary first entry.
//   3. Reasoning models spend most of `max_tokens` on an internal pass
//      before emitting a single character of `content`. A cap that looks
//      generous for the visible answer returns an EMPTY string with
//      `finish_reason: "length"` — which is indistinguishable from "the
//      model had nothing to say" unless the caller is told. So
//      `complete()` surfaces `finishReason` and `usage`, and callers
//      treat empty-plus-length as a budget error rather than a verdict.
//
// Graceful-idle: `zagiConfigFromEnv()` returns null with no API key and
// every feature built on this is expected to no-op rather than fail.

export interface ZagiConfig {
  /** Chat-completions base, INCLUDING the `/v1` segment. */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ZagiCompletion {
  text: string;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
}

export interface ZagiClient {
  model: string;
  complete(opts: {
    system: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<ZagiCompletion>;
}

/**
 * Read ZAGI config from env, or null when it is not set up.
 *
 * `SPORTRADAR_LLM_*` is honoured as a fallback because it names the same
 * in-house gateway and shipped first — an operator who configured it
 * gets ZAGI without touching `.env` again. `ZAGI_*` wins when both are
 * present, so pointing one somewhere else stays possible.
 */
export function zagiConfigFromEnv(): ZagiConfig | null {
  const apiKey =
    (process.env.ZAGI_API_KEY ?? "").trim() ||
    (process.env.SPORTRADAR_LLM_API_KEY ?? "").trim();
  if (!apiKey) return null;

  const baseUrl =
    (process.env.ZAGI_BASE_URL ?? "").trim() ||
    (process.env.SPORTRADAR_LLM_BASE_URL ?? "").trim();
  if (!baseUrl) return null;

  const model =
    (process.env.ZAGI_MODEL ?? "").trim() ||
    (process.env.SPORTRADAR_LLM_MODEL ?? "").trim() ||
    "glm-5.3-flash";

  return { baseUrl, apiKey, model };
}

export class ZagiEmptyReplyError extends Error {
  constructor(readonly finishReason: string | null) {
    super(
      finishReason === "length"
        ? "zagi returned an empty reply after exhausting max_tokens on reasoning"
        : `zagi returned an empty reply (finish_reason=${finishReason ?? "unknown"})`,
    );
    this.name = "ZagiEmptyReplyError";
  }
}

export function createZagiClient(cfg: ZagiConfig): ZagiClient {
  const baseUrl = cfg.baseUrl.replace(/\/+$/u, "");
  const doFetch = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 180_000;

  return {
    model: cfg.model,
    async complete({ system, user, maxTokens = 16_000, temperature = 0 }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            max_tokens: maxTokens,
            temperature,
          }),
        });
        if (!res.ok) {
          throw new Error(`zagi returned HTTP ${res.status}`);
        }
        const body = (await res.json()) as {
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
          };
        };
        const choice = body.choices?.[0];
        const text = choice?.message?.content ?? "";
        const finishReason = choice?.finish_reason ?? null;
        if (!text.trim()) {
          // Never a silent "no answer": an exhausted budget and a model
          // with nothing to say need different operator responses.
          throw new ZagiEmptyReplyError(finishReason);
        }
        return {
          text,
          finishReason,
          promptTokens: body.usage?.prompt_tokens ?? null,
          completionTokens: body.usage?.completion_tokens ?? null,
          reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? null,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
