// Placement intent tokens (migration 0097).
//
// The slip asks POST /bets/intent for a token whenever its selection set
// changes; POST /bets requires one. The token is a compact HMAC-signed
// claim set — stateless, so verification costs one hash and never
// touches Postgres or Redis:
//
//   { v: 1, u: <userId>, s: <sha256 of the sorted selection keys>,
//     t: <issued-at epoch ms>, n: <random nonce> }
//
// What it buys:
//   * every placement is preceded by a quote step the server timestamped,
//     so "minimum human time" (quote -> place) is measurable and
//     enforceable, and every ticket records how long the bettor took;
//   * the selection set is pinned, so a token issued for one slip cannot
//     be spent on a different one;
//   * single-use (best-effort, Redis nonce in routes.ts) stops a captured
//     token from being replayed for a second ticket.
//
// It deliberately binds the selection SET, not the odds: live prices tick
// several times a second and binding them would reset the human-time
// clock on every tick, starving a slip on a live market. Odds are still
// validated at placement by the existing drift + authoritative-price path.
//
// Not a bot-proof gate — a script can call /bets/intent too. It removes
// the latency-arbitrage edge and forces automation through the same
// timeline a human follows, which is the point.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const BET_INTENT_VERSION = 1 as const;

export interface BetIntentClaims {
  v: typeof BET_INTENT_VERSION;
  u: string;
  s: string;
  t: number;
  n: string;
}

export interface IntentSelectionKey {
  marketId: string;
  outcomeId: string;
}

// Derive a dedicated signing key from the JWT secret so an intent token
// can never be confused with (or forged from) an access token.
export function deriveIntentKey(jwtSecret: string): Buffer {
  return createHmac("sha256", jwtSecret).update("oddzilla-bet-intent-v1").digest();
}

// Order-independent, duplicate-insensitive digest of the selection set.
export function selectionSetHash(selections: ReadonlyArray<IntentSelectionKey>): string {
  const keys = Array.from(
    new Set(selections.map((s) => `${s.marketId}:${s.outcomeId}`)),
  ).sort();
  return createHash("sha256").update(keys.join("|")).digest("hex");
}

export function newIntentClaims(
  userId: string,
  selections: ReadonlyArray<IntentSelectionKey>,
  nowMs: number = Date.now(),
): BetIntentClaims {
  return {
    v: BET_INTENT_VERSION,
    u: userId,
    s: selectionSetHash(selections),
    t: nowMs,
    n: randomBytes(12).toString("hex"),
  };
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signIntent(claims: BetIntentClaims, key: Buffer): string {
  const body = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const mac = b64url(createHmac("sha256", key).update(body).digest());
  return `${body}.${mac}`;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX24 = /^[0-9a-f]{24}$/;

// Signature + shape check only. Returns null for anything that is not a
// token we minted; the caller layers user / selection / time checks.
export function verifyIntent(token: unknown, key: Buffer): BetIntentClaims | null {
  if (typeof token !== "string" || token.length < 16 || token.length > 2048) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", key).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (c.v !== BET_INTENT_VERSION) return null;
  if (typeof c.u !== "string" || c.u.length === 0 || c.u.length > 64) return null;
  if (typeof c.s !== "string" || !HEX64.test(c.s)) return null;
  if (typeof c.t !== "number" || !Number.isFinite(c.t)) return null;
  if (typeof c.n !== "string" || !HEX24.test(c.n)) return null;
  return { v: BET_INTENT_VERSION, u: c.u, s: c.s, t: c.t, n: c.n };
}

export type IntentFailure =
  | "intent_invalid"
  | "intent_selection_mismatch"
  | "intent_expired"
  | "intent_too_fast";

export type IntentCheck =
  | { ok: true; claims: BetIntentClaims }
  // `claims` is present when the token itself was genuine and only the
  // time window failed — callers can still record the quote timestamp.
  | { ok: false; reason: IntentFailure; claims: BetIntentClaims | null };

// A token dated more than this far in the future is not ours (our clock
// issued it); treat as invalid rather than letting a future-dated token
// pass the age checks.
const MAX_FUTURE_SKEW_MS = 30_000;

export function checkIntent(
  token: unknown,
  key: Buffer,
  ctx: {
    userId: string;
    selections: ReadonlyArray<IntentSelectionKey>;
    nowMs: number;
    ttlMs: number;
    minHumanMs: number;
  },
): IntentCheck {
  const claims = verifyIntent(token, key);
  if (!claims) return { ok: false, reason: "intent_invalid", claims: null };
  if (claims.u !== ctx.userId) return { ok: false, reason: "intent_invalid", claims: null };
  if (claims.s !== selectionSetHash(ctx.selections)) {
    return { ok: false, reason: "intent_selection_mismatch", claims };
  }
  const age = ctx.nowMs - claims.t;
  if (age < -MAX_FUTURE_SKEW_MS) return { ok: false, reason: "intent_invalid", claims: null };
  if (age > ctx.ttlMs) return { ok: false, reason: "intent_expired", claims };
  if (age < ctx.minHumanMs) return { ok: false, reason: "intent_too_fast", claims };
  return { ok: true, claims };
}
