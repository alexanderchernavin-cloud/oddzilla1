// Minimal OpenAI-compatible client for a local LM Studio server. LM Studio
// exposes /v1/models + /v1/chat/completions on (by default) :1234. We ask for
// JSON output via response_format; if the loaded model's server build rejects
// that (HTTP 400), we retry once without it and rely on defensive parsing.

import type { BotConfig } from "./config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

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
    const run = async (withJson: boolean): Promise<Response> => {
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
        if (withJson) payload.response_format = { type: "json_object" };
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
