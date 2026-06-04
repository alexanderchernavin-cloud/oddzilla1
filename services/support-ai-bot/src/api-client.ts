// Thin client for the server-side bot endpoints
// (/webhooks/support-ai/:secret/*). All calls are outbound HTTPS from the PC;
// the server never connects back. The secret rides in the URL path (the
// route constant-time compares it). Reachable publicly through Caddy's
// /api/* proxy, which strips /api so the API sees /webhooks/support-ai/...

import type { SupportBotPendingResponse } from "@oddzilla/types";
import type { BotConfig } from "./config.js";

export class BotApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BotApiError";
  }
}

export class BotApi {
  private readonly base: string;

  constructor(cfg: BotConfig) {
    this.base = `${cfg.apiBase}/webhooks/support-ai/${encodeURIComponent(cfg.botToken)}`;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      let code = "http_error";
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        code = body.error ?? code;
        message = body.message ?? message;
      } catch {
        // non-JSON error body
      }
      throw new BotApiError(res.status, code, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  heartbeat(): Promise<{ ok: boolean; lastSeen: string }> {
    return this.call("/heartbeat", { method: "POST" });
  }

  pending(limit: number): Promise<SupportBotPendingResponse> {
    return this.call(`/pending?limit=${limit}`, { method: "GET" });
  }

  reply(threadId: string, text: string): Promise<unknown> {
    return this.call(`/threads/${threadId}/reply`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  escalate(
    threadId: string,
    reason?: string,
    holdingMessage?: string,
  ): Promise<unknown> {
    return this.call(`/threads/${threadId}/escalate`, {
      method: "POST",
      body: JSON.stringify({ reason, holdingMessage }),
    });
  }
}
