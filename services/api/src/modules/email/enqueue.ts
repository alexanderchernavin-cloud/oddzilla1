// Server-side helpers for enqueuing email sends.
//
// Each helper mints the appropriate token (with hash-only DB storage),
// inserts the token row + the outbox row, and fires NOTIFY so the
// worker drains immediately. Both operations live inside whatever
// transaction the caller passes — signup wires this into its existing
// user-creation tx so the email enqueue commits or rolls back with
// the user row.
//
// The functions return the raw token so the caller can also log /
// debug, but in production the only consumer is the email content
// itself.

import { sql as drizzleSql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";
import { emailOutbox, emailVerificationTokens, passwordResetTokens } from "@oddzilla/db";
import { loadEnv } from "@oddzilla/config";
import { mintToken } from "./tokens.js";

// Match the auth service convention for "drizzle client or tx handle".
type TxHandle = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type DbOrTx = DbClient | TxHandle;

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const RESET_TTL_MS = 30 * 60 * 1000; // 30 min — sensitive action, short window
export const PASSWORD_RESET_EXPIRES_IN = "30 minutes";

/** Resolved public base URL for verify/reset links. Falls back to
 * https://${FRONTEND_HOST} when EMAIL_PUBLIC_BASE_URL is unset.
 * Throws if neither is available — we'd otherwise generate broken
 * links and the operator would only notice when a user clicked one.
 */
export function publicBaseUrl(): string {
  const env = loadEnv();
  if (env.EMAIL_PUBLIC_BASE_URL) return stripTrailingSlash(env.EMAIL_PUBLIC_BASE_URL);
  if (env.FRONTEND_HOST) {
    const proto = env.NODE_ENV === "production" ? "https" : "http";
    return `${proto}://${env.FRONTEND_HOST}`;
  }
  throw new Error(
    "email link base URL unknown: set EMAIL_PUBLIC_BASE_URL or FRONTEND_HOST",
  );
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export interface EnqueueVerifyEmailInput {
  userId: string;
  email: string;
  displayName: string | null;
}

export interface EnqueueResult {
  /** Raw token. Useful only for debug logs — never returned to clients. */
  rawToken: string;
  /** Outbox row id for log correlation. */
  outboxId: string;
}

/** Issues a fresh verify-email token + outbox row. Caller must
 * supply a tx for transactional enqueue alongside signup; outside a
 * tx pass the root db client. */
export async function enqueueVerifyEmail(
  tx: DbOrTx,
  input: EnqueueVerifyEmailInput,
): Promise<EnqueueResult> {
  const { raw, hash } = mintToken();
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MS);

  const [tokenRow] = await tx
    .insert(emailVerificationTokens)
    .values({
      userId: input.userId,
      tokenHash: hash,
      expiresAt,
    })
    .returning({ id: emailVerificationTokens.id });
  if (!tokenRow) throw new Error("email_verification_token insert returned no row");

  const url = `${publicBaseUrl()}/verify-email?token=${encodeURIComponent(raw)}`;
  const [outboxRow] = await tx
    .insert(emailOutbox)
    .values({
      kind: "verify_email",
      userId: input.userId,
      toAddress: input.email,
      subject: "Confirm your Oddzilla email",
      payload: {
        url,
        displayName: input.displayName,
      },
      dedupKey: `verify_email:${tokenRow.id}`,
    })
    .returning({ id: emailOutbox.id });
  if (!outboxRow) throw new Error("email_outbox insert returned no row");

  // NOTIFY runs OUTSIDE the tx — fired by the worker LISTEN sweep. We
  // emit it eagerly here so the api process running the route handler
  // and the api process running the worker can be different instances
  // in a future scale-out without dropping the wake-up.
  await tx.execute(drizzleSql`SELECT pg_notify('email_outbox', '')`);

  return { rawToken: raw, outboxId: String(outboxRow.id) };
}

export interface EnqueuePasswordResetInput {
  userId: string;
  email: string;
  displayName: string | null;
  requestedIp: string | null;
}

export async function enqueuePasswordReset(
  tx: DbOrTx,
  input: EnqueuePasswordResetInput,
): Promise<EnqueueResult> {
  const { raw, hash } = mintToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);

  const [tokenRow] = await tx
    .insert(passwordResetTokens)
    .values({
      userId: input.userId,
      tokenHash: hash,
      expiresAt,
      requestedIp: input.requestedIp ?? null,
    })
    .returning({ id: passwordResetTokens.id });
  if (!tokenRow) throw new Error("password_reset_token insert returned no row");

  const url = `${publicBaseUrl()}/reset-password?token=${encodeURIComponent(raw)}`;
  const [outboxRow] = await tx
    .insert(emailOutbox)
    .values({
      kind: "password_reset",
      userId: input.userId,
      toAddress: input.email,
      subject: "Reset your Oddzilla password",
      payload: {
        url,
        displayName: input.displayName,
        expiresIn: PASSWORD_RESET_EXPIRES_IN,
        requestedIp: input.requestedIp,
      },
      dedupKey: `password_reset:${tokenRow.id}`,
    })
    .returning({ id: emailOutbox.id });
  if (!outboxRow) throw new Error("email_outbox insert returned no row");

  await tx.execute(drizzleSql`SELECT pg_notify('email_outbox', '')`);

  return { rawToken: raw, outboxId: String(outboxRow.id) };
}
