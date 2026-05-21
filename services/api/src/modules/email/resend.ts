// Resend HTTP client. https://resend.com/docs/api-reference/emails/send-email
//
// Why a hand-rolled fetch and not the `resend` npm package: their SDK
// pulls in `react` / `react-dom` peers for React Email rendering even
// when we render templates ourselves. The HTTP surface is one POST
// with a simple JSON body — coding it directly keeps the dependency
// graph small and the failure modes obvious.
//
// Resend's response shape on success is `{id: "..."}`; on failure it's
// `{name: "...", message: "..."}` with the HTTP status carrying the
// category. 4xx errors are permanent (bad recipient, malformed body);
// 5xx errors are transient and worth retrying. We throw on both — the
// outbox worker's MAX_ATTEMPTS cap handles the "give up" path.

import type { EmailClient, SendEmailInput, SendEmailResult } from "./client.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
// Resend's documented timeout is generous; cap ours so a hung connection
// doesn't pin the outbox worker. The worker processes rows serially
// anyway — a 15 s ceiling is the right knob.
const SEND_TIMEOUT_MS = 15_000;

interface ResendSuccess {
  id: string;
}

interface ResendError {
  name?: string;
  message?: string;
  statusCode?: number;
}

export function createResendClient(apiKey: string): EmailClient {
  return {
    name: "resend",
    async send(input: SendEmailInput): Promise<SendEmailResult> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), SEND_TIMEOUT_MS);
      let res: Response;
      // Custom headers — Resend forwards arbitrary headers via the
      // `headers` map (e.g. for In-Reply-To). They overwrite Message-ID
      // with their own, so don't try to set that here.
      const customHeaders: Record<string, string> = {};
      if (input.inReplyTo) {
        customHeaders["In-Reply-To"] = `<${input.inReplyTo}>`;
      }
      try {
        res = await fetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: input.from,
            to: input.to,
            subject: input.subject,
            html: input.html,
            text: input.text,
            reply_to: input.replyTo ?? input.from,
            ...(Object.keys(customHeaders).length > 0
              ? { headers: customHeaders }
              : {}),
          }),
          signal: ac.signal,
        });
      } catch (err) {
        // AbortError on timeout; TypeError on DNS/connect. Both are
        // transient — let the worker count attempts.
        throw new Error(`resend_network: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        try {
          const ok = (await res.json()) as ResendSuccess;
          return { providerMessageId: ok?.id ?? null };
        } catch {
          // empty body on 2xx — count as success without a provider id
          return { providerMessageId: null };
        }
      }

      // Non-2xx. Try to read the structured body; fall back to status.
      let detail = `status=${res.status}`;
      try {
        const body = (await res.json()) as ResendError;
        if (body?.message) detail = `${detail} ${body.name ?? "error"}: ${body.message}`;
      } catch {
        // ignore parse failures
      }
      throw new Error(`resend_send_failed: ${detail}`);
    },
  };
}
