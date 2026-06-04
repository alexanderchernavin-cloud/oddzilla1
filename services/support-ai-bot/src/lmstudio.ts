// Minimal OpenAI-compatible client for a local LM Studio server (/v1/models +
// /v1/chat/completions, default :1234). Supports tool / function calling so the
// assistant can fetch read-only platform data on demand. `complete` returns the
// raw assistant turn (text content and/or tool calls); the worker drives the
// tool loop and feeds results back as role:"tool" messages.

import type { BotConfig } from "./config.js";

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on an assistant turn that requested tools. */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /** Present on a role:"tool" result, linking it to the assistant's call. */
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Completion {
  content: string;
  toolCalls: ToolCall[];
}

interface RawCompletion {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
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

  async complete(
    model: string,
    messages: ChatMessage[],
    tools?: ToolSpec[],
  ): Promise<Completion> {
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
      if (tools && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = "auto";
      }
      const res = await fetch(`${this.cfg.lmStudioBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        signal: ctrl.signal,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`lm_studio_http_${res.status}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as RawCompletion;
      const msg = body.choices?.[0]?.message;
      const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "{}",
      }));
      return { content: msg?.content ?? "", toolCalls };
    } finally {
      clearTimeout(timer);
    }
  }
}
