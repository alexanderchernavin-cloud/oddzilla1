// Browser fetch wrapper. Client components call this; server components use
// lib/auth.ts (which forwards cookies via next/headers).

const BROWSER_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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
