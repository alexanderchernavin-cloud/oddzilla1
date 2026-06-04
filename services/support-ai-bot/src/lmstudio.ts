// Minimal OpenAI-compatible client for a local LM Studio server. LM Studio
// exposes /v1/models + /v1/chat/completions on (by default) :1234. We request
// structured output via response_format json_schema (LM Studio's supported
// form — note `json_object` is rejected by some models, e.g. gemma-4). The
// strict schema both guarantees parseable JSON and stops chatty / reasoning
// models from rambling into prose. If a model's server build rejects
// json_schema (HTTP 400) we retry once without it and lean on defensive parsing.

import type { BotConfig } from "./config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Constrains the model to exactly our decision shape: {action, message, reason?}.
const DECISION_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "support_decision",
    strict: true,
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["reply", "escalate"] },
        message: { type: "string" },
        reason: { type: "string" },
      },
      required: ["action", "message"],
      additionalProperties: false,
    },
  },
} as const;

export class LmStudio {
  constructor(private readonly cfg: BotConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.lmStudioApiKey) {
      h.authorization = `Bearer ${this.cfg.lmStudioApiKey}`;
    }
    return h;
  }

  /** Configured model id, or the first model the server reports as loaded. */
  async discoverModel(): Promise<string | null> {
    if (this.cfg.lmStudioModel) return this.cfg.lmStudioModel;
    try {
      const res = await fetch(`${this.cfg.lmStudioBaseUrl}/v1/models`, {
        headers: this.headers(),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      return body.data?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    const run = async (withSchema: boolean): Promise<Response> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.cfg.requestTimeoutMs);
      try {
        const payload: Record<string, unknown> = {
          model,
          messages,
          temperature: this.cfg.temperature,
          max_tokens: this.cfg.maxTokens,
          stream: false,
        };
        if (withSchema) payload.response_format = DECISION_SCHEMA;
        return await fetch(`${this.cfg.lmStudioBaseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          signal: ctrl.signal,
          body: JSON.stringify(payload),
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let res = await run(true);
    if (!res.ok && res.status === 400) {
      // Some model server builds don't accept response_format — fall back.
      res = await run(false);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`lm_studio_http_${res.status}: ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return body.choices?.[0]?.message?.content ?? "";
  }
}
