// Browser fetch wrapper. Client components call this; server components use
// lib/auth.ts (which forwards cookies via next/headers).

// Empty NEXT_PUBLIC_API_URL means "same origin"; in prod Caddy reverse-proxies
// /api/* to the api container. In dev we hit http://localhost:3001 directly.
const RAW_API_URL = process.env.NEXT_PUBLIC_API_URL;
const BROWSER_API_URL =
  RAW_API_URL && RAW_API_URL.length > 0 ? RAW_API_URL : "/api";

export interface ApiErrorBody {
  error: string;
  message: string;
  issues?: Array<{ path: string; code: string; message: string }>;
}

export class ApiFetchError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = "ApiFetchError";
  }
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let body: ApiErrorBody = { error: "error", message: res.statusText };
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    // non-JSON error — fall back to statusText
  }
  throw new ApiFetchError(res.status, body);
}

export async function clientApi<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BROWSER_API_URL}${path}`, {
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    ...init,
  });
  return parseOrThrow<T>(res);
}
