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

export interface CompletionUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  /** Hidden reasoning tokens, when the endpoint reports them (GLM does). */
  reasoningTokens: number | null;
}

export interface Completion {
  content: string;
  toolCalls: ToolCall[];
  /** "stop" | "tool_calls" | "length" | ... as reported by the endpoint.
   * "length" means the reply was cut off by max_tokens. On a reasoning
   * model that usually surfaces as EMPTY content, because the internal
   * reasoning pass consumed the whole budget before any text was emitted. */
  finishReason: string | null;
  usage: CompletionUsage;
}

interface RawCompletion {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
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
      const choice = body.choices?.[0];
      const msg = choice?.message;
      const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "{}",
      }));
      return {
        content: msg?.content ?? "",
        toolCalls,
        finishReason: choice?.finish_reason ?? null,
        usage: {
          promptTokens: numOrNull(body.usage?.prompt_tokens),
          completionTokens: numOrNull(body.usage?.completion_tokens),
          reasoningTokens: numOrNull(
            body.usage?.completion_tokens_details?.reasoning_tokens,
          ),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
