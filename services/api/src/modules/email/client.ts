// Provider-agnostic email client interface.
//
// `EmailClient.send` is the only contract the rest of the module relies
// on. Concrete implementations live in this directory (resend.ts today;
// add sendgrid.ts / ses.ts / smtp.ts alongside as needed).
//
// The factory `resolveEmailClient` picks an implementation at boot based
// on `EMAIL_PROVIDER`. When `EMAIL_PROVIDER_TOKEN` is unset for the
// chosen provider, the factory returns `null` and the outbox worker
// switches to graceful-idle mode — same shape Firebase / Disir / OBB
// use elsewhere in the codebase.

import { loadEnv } from "@oddzilla/config";
import { createResendClient } from "./resend.js";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  from: string;
  replyTo?: string;
  /** Optional In-Reply-To header for threading. Resend doesn't honour
   * a caller-supplied Message-ID (theirs always wins), but it will
   * pass In-Reply-To through, so the recipient's mail client groups
   * the message into the right conversation locally. */
  inReplyTo?: string;
}

export interface SendEmailResult {
  /** Provider-internal id (Resend's email id, etc.). Stored in
   * email_outbox.provider_message_id for debugging visibility. NOT the
   * SMTP Message-ID — providers generally don't expose that. */
  providerMessageId: string | null;
}

export interface EmailClient {
  /** Sends a single message. Throws on transient failure so the worker
   * retries; returns normally on success. Permanently bad recipients
   * (bounced, blocked) are also a throw — the worker counts attempts
   * and force-marks rows sent after MAX_ATTEMPTS. */
  send(input: SendEmailInput): Promise<SendEmailResult>;
  /** Human-readable provider name, used in log lines. */
  readonly name: string;
}

/** Resolves the configured email client. Returns null when the
 * provider isn't configured (no token) — the worker treats that as
 * graceful-idle and stamps `last_error=email_disabled` on every row.
 */
export function resolveEmailClient(): EmailClient | null {
  const env = loadEnv();
  if (!env.EMAIL_PROVIDER_TOKEN) return null;

  switch (env.EMAIL_PROVIDER) {
    case "resend":
      return createResendClient(env.EMAIL_PROVIDER_TOKEN);
    case "sendgrid":
    case "ses":
    case "smtp":
      // Stub: provider abstraction is ready, but only Resend ships
      // today. Adding another provider is one file in this directory
      // + a case branch above. The boot log surfaces this so the
      // operator notices a misconfigured env immediately.
      return null;
    default:
      return null;
  }
}

/** Human-readable summary of the resolved provider state, for boot logs. */
export function emailProviderSummary(): string {
  const env = loadEnv();
  if (!env.EMAIL_PROVIDER_TOKEN) {
    return `disabled (EMAIL_PROVIDER_TOKEN unset for provider=${env.EMAIL_PROVIDER})`;
  }
  if (env.EMAIL_PROVIDER === "resend") {
    return `enabled (provider=resend from=${env.EMAIL_FROM})`;
  }
  return `disabled (provider=${env.EMAIL_PROVIDER} has no shipped client yet)`;
}
