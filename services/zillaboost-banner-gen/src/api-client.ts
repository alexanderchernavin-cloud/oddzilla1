// Thin client for the server-side endpoints
// (/webhooks/banner-gen/:secret/*). All calls are outbound HTTPS from the
// PC; the server never connects back. The secret rides in the URL path
// (the route constant-time compares it). Reachable publicly through
// Caddy's /api/* proxy.

import type { BannerGenPendingResponse } from "@oddzilla/types";
import type { WorkerConfig } from "./config.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class WorkerApi {
  private readonly base: string;

  constructor(cfg: WorkerConfig) {
    this.base = `${cfg.apiBase}/webhooks/banner-gen/${encodeURIComponent(cfg.token)}`;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    };
    if (init?.body !== undefined && init?.body !== null) {
      headers["content-type"] = "application/json";
    }
    const res = await fetch(`${this.base}${path}`, { ...init, headers });
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
      throw new ApiError(res.status, code, message);
    }
    return (await res.json()) as T;
  }

  pending(limit: number): Promise<BannerGenPendingResponse> {
    return this.call(`/pending?limit=${limit}`, { method: "GET" });
  }

  complete(ruleId: string, imageBase64: string, mime: string): Promise<unknown> {
    return this.call(`/jobs/${ruleId}/complete`, {
      method: "POST",
      body: JSON.stringify({ imageBase64, mime }),
    });
  }

  fail(ruleId: string, error: string): Promise<unknown> {
    return this.call(`/jobs/${ruleId}/fail`, {
      method: "POST",
      body: JSON.stringify({ error: error.slice(0, 2000) }),
    });
  }
}
