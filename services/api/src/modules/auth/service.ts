// Auth business logic. Kept separate from routes so it's trivially
// unit-testable and so session rotation is a single call site.

import { eq, and, isNull } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { DbClient } from "@oddzilla/db";
import { users, sessions, wallets, walletLedger } from "@oddzilla/db";
import { SIGNUP_BONUS_OZ_MICRO } from "@oddzilla/types";
import { randomUUID } from "node:crypto";
import { SESSION_STATUS_KEY } from "../../plugins/auth.js";

// A Drizzle transaction handle has the same query API as the root client
// (`.insert`, `.update`, `.select`, etc.). We extract the callback's first
// parameter so helpers can accept either a DbClient or a tx.
type TxHandle = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type DbOrTx = DbClient | TxHandle;
import {
  hashPassword,
  verifyPassword,
  verifyDummyPassword,
  signAccessToken,
  newRefreshToken,
  hashRefreshToken,
  type AccessTokenClaims,
} from "@oddzilla/auth";
import type { AuthEnv } from "@oddzilla/config";
import {
  ConflictError,
  UnauthorizedError,
} from "../../lib/errors.js";

export interface CreateUserInput {
  email: string;
  password: string;
  displayName?: string | null;
  countryCode?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
}

export interface IssuedTokens {
  userId: string;
  role: "user" | "admin" | "support";
  accessToken: string;
  accessExpiresAt: Date;
  refreshTokenRaw: string;
  refreshExpiresAt: Date;
  sessionId: string;
}

export interface PublicUser {
  id: string;
  email: string;
  role: "user" | "admin" | "support";
  status: "active" | "blocked" | "pending_kyc";
  kycStatus: "none" | "pending" | "approved" | "rejected";
  displayName: string | null;
  nickname: string | null;
  countryCode: string | null;
  sportOrder: string[] | null;
  createdAt: Date;
}

export class AuthService {
  constructor(
    private readonly db: DbClient,
    private readonly auth: AuthEnv,
    private readonly jwtKey: Uint8Array,
    private readonly redis: Redis,
  ) {}

  /** Mark a session id as revoked in the per-request cache so the next
   * authenticated request rejects immediately rather than waiting for
   * the access JWT to expire (up to 15 min). TTL slightly exceeds the
   * access lifetime so we don't keep the entry around after the JWT
   * itself is unusable.
   */
  private async cacheRevoked(sessionId: string): Promise<void> {
    try {
      await this.redis.set(
        SESSION_STATUS_KEY(sessionId),
        "revoked",
        "EX",
        Math.max(60, this.auth.jwtAccessTtlSeconds + 60),
      );
    } catch {
      // Cache failure is degradation, not a fatal error. The DB row's
      // revoked_at is the source of truth on the next cache miss.
    }
  }

  // ── Refresh rotation grace window ──────────────────────────────────────
  // A single Next.js middleware refresh on a page load fans out across
  // every tab of an active session: each tab's SSR fires its own
  // middleware pass and each pass calls /auth/refresh. Three tabs racing
  // the same rotation used to play out as: one tab wins (rotates and
  // revokes the old session), the other two see `revokedAt` set and
  // trigger family-revocation — instant logout across every tab and
  // every device.
  //
  // Fix: after a successful rotation, cache the result keyed by the
  // OLD token hash with a short TTL (10 s). Concurrent refreshes for
  // the same old token hit the cache and return the same new tokens
  // instead of racing the DB. A Redis lock around the rotation
  // serialises the first writer so the cache write happens before any
  // late arrival reads it.
  //
  // Genuine token-reuse attacks still trip family revocation: a stolen
  // token surfacing > 10 s after the rotation hits a cache miss, the
  // DB lookup finds the session revoked, and the family is burned.
  // The grace window narrows replay detection by 10 s — an acceptable
  // trade for keeping legitimate multi-tab sessions alive.
  private static readonly REFRESH_GRACE_SECONDS = 10;
  private static readonly REFRESH_LOCK_TTL_MS = 5000;
  private static readonly REFRESH_LOCK_POLL_DEADLINE_MS = 2500;
  private static readonly REFRESH_LOCK_POLL_INTERVAL_MS = 50;
  private rotationCacheKey(oldHash: string): string {
    return `auth:refresh_rotate:${oldHash}`;
  }
  private rotationLockKey(oldHash: string): string {
    return `auth:refresh_lock:${oldHash}`;
  }
  private async readRotationCache(oldHash: string): Promise<IssuedTokens | null> {
    try {
      const raw = await this.redis.get(this.rotationCacheKey(oldHash));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Omit<IssuedTokens, "accessExpiresAt" | "refreshExpiresAt"> & {
        accessExpiresAt: string;
        refreshExpiresAt: string;
      };
      return {
        ...parsed,
        accessExpiresAt: new Date(parsed.accessExpiresAt),
        refreshExpiresAt: new Date(parsed.refreshExpiresAt),
      };
    } catch {
      return null;
    }
  }
  private async writeRotationCache(oldHash: string, tokens: IssuedTokens): Promise<void> {
    try {
      await this.redis.set(
        this.rotationCacheKey(oldHash),
        JSON.stringify({
          ...tokens,
          accessExpiresAt: tokens.accessExpiresAt.toISOString(),
          refreshExpiresAt: tokens.refreshExpiresAt.toISOString(),
        }),
        "EX",
        AuthService.REFRESH_GRACE_SECONDS,
      );
    } catch {
      // Cache write failure means concurrent tabs may trip family
      // revocation. Degraded, not fatal — surface no error.
    }
  }
  /** Atomic compare-and-delete so we only ever release the lock we own. */
  private static readonly RELEASE_LOCK_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

  async signup(input: CreateUserInput): Promise<{ user: PublicUser; tokens: IssuedTokens }> {
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email.toLowerCase()))
      .limit(1);
    if (existing.length > 0) throw new ConflictError("email_in_use", "email_in_use");

    const passwordHash = await hashPassword(input.password);

    // Create user + per-currency wallets atomically. Every signup gets a
    // zero-balance USDC wallet (real money) and an OZ wallet pre-funded
    // with the demo signup bonus so the bet slip and settlement are
    // testable end-to-end without on-chain top-up.
    const user = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          email: input.email.toLowerCase(),
          passwordHash,
          displayName: input.displayName ?? null,
          countryCode: input.countryCode ?? null,
          status: "active",
          role: "user",
          kycStatus: "none",
        })
        .returning();
      if (!created) throw new Error("user insert returned no row");

      await tx
        .insert(wallets)
        .values([
          { userId: created.id, currency: "USDC", balanceMicro: 0n },
          {
            userId: created.id,
            currency: "OZ",
            balanceMicro: SIGNUP_BONUS_OZ_MICRO,
          },
        ])
        .onConflictDoNothing({ target: [wallets.userId, wallets.currency] });

      // Audit row for the OZ bonus. The wallet_ledger unique partial index
      // on (type, ref_type, ref_id) makes this idempotent if signup is
      // somehow retried for the same user id.
      await tx
        .insert(walletLedger)
        .values({
          userId: created.id,
          currency: "OZ",
          deltaMicro: SIGNUP_BONUS_OZ_MICRO,
          type: "adjustment",
          refType: "signup_bonus",
          refId: created.id,
          memo: "demo OZ signup bonus",
        })
        .onConflictDoNothing();

      return created;
    });

    const tokens = await this.issueTokens(user.id, user.role, {
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      deviceId: input.deviceId ?? null,
    });

    return { user: publicUser(user), tokens };
  }

  async login(
    email: string,
    password: string,
    ctx: { ip: string | null; userAgent: string | null; deviceId: string | null },
  ): Promise<{ user: PublicUser; tokens: IssuedTokens }> {
    const lowerEmail = email.toLowerCase();
    // Per-account rate limit on top of the per-IP @fastify/rate-limit
    // (5/min/IP). An attacker rotating residential proxies otherwise
    // sustains effectively unlimited per-account guesses; this caps any
    // single email at LOGIN_FAIL_THRESHOLD failures inside the window.
    // Counter increments BEFORE we know whether the email is registered,
    // so the response shape doesn't leak account existence.
    if (await this.isLoginRateLimited(lowerEmail)) {
      // Equalise timing so the lockout response isn't visibly faster
      // than a successful argon2 verify.
      await verifyDummyPassword(password);
      throw new UnauthorizedError("too_many_login_attempts", "too_many_login_attempts");
    }

    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, lowerEmail))
      .limit(1);
    if (!user) {
      // Equalise wall-clock time so an attacker can't tell registered
      // emails apart from unregistered ones via response latency. Without
      // this branch a missing-user request returns in ~1 ms while a found
      // user spends ~50 ms inside argon2.verify.
      await verifyDummyPassword(password);
      await this.recordLoginFailure(lowerEmail);
      throw new UnauthorizedError("invalid_credentials", "invalid_credentials");
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      await this.recordLoginFailure(lowerEmail);
      throw new UnauthorizedError("invalid_credentials", "invalid_credentials");
    }

    if (user.status === "blocked") {
      throw new UnauthorizedError("account_blocked", "account_blocked");
    }

    // Success — clear the failure counter so prior typos don't lock out
    // this user later.
    await this.clearLoginFailures(lowerEmail);

    await this.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    const tokens = await this.issueTokens(user.id, user.role, ctx);
    return { user: publicUser(user), tokens };
  }

  // Per-account login throttle. Sliding window, Redis-backed; survives
  // api restarts (the in-memory @fastify/rate-limit state doesn't).
  private static readonly LOGIN_FAIL_THRESHOLD = 10;
  private static readonly LOGIN_FAIL_WINDOW_SECONDS = 15 * 60;
  private loginFailKey(emailLower: string): string {
    return `auth:login_fail:${emailLower}`;
  }
  private async isLoginRateLimited(emailLower: string): Promise<boolean> {
    try {
      const raw = await this.redis.get(this.loginFailKey(emailLower));
      return Boolean(raw) && Number(raw) > AuthService.LOGIN_FAIL_THRESHOLD;
    } catch {
      // Redis blip — fail open. Better one extra attempt than locking
      // every user out of an outage.
      return false;
    }
  }
  private async recordLoginFailure(emailLower: string): Promise<void> {
    try {
      const key = this.loginFailKey(emailLower);
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, AuthService.LOGIN_FAIL_WINDOW_SECONDS);
      }
    } catch {
      // ignore — telemetry only
    }
  }
  private async clearLoginFailures(emailLower: string): Promise<void> {
    try {
      await this.redis.del(this.loginFailKey(emailLower));
    } catch {
      // ignore
    }
  }

  /**
   * Rotates a refresh token. The client presents the raw token; we hash it,
   * look up the session, verify it's not expired/revoked, revoke it, and
   * create a new session with a new refresh token. Returns new tokens.
   *
   * Replay detection: refresh tokens are single-use. If the presented
   * hash matches a session that is ALREADY revoked, the token has been
   * used twice — that means either the legitimate client is replaying
   * an old token (unlikely; cookies handle rotation) or an attacker
   * stole and reused it. Either way, revoke every active session in the
   * family so neither holder retains access.
   */
  async refresh(
    rawRefreshToken: string,
    ctx: { ip: string | null; userAgent: string | null; deviceId: string | null },
  ): Promise<IssuedTokens> {
    const hash = hashRefreshToken(rawRefreshToken);
    // The DB column is bytea so the lookup uses the raw Buffer, but
    // Redis keys must be strings — convert once and reuse for every
    // cache / lock op.
    const hashKey = hash.toString("hex");

    // Grace window: if this old hash was rotated in the last
    // REFRESH_GRACE_SECONDS, return the same new tokens. Covers
    // multi-tab SSR refreshes that race the rotation; without this,
    // every concurrent refresh would trip family-revocation.
    const preCached = await this.readRotationCache(hashKey);
    if (preCached) return preCached;

    // Serialise concurrent rotations of the same hash. Two tabs that
    // both miss the cache here would otherwise both pass the
    // session.revokedAt gate and rotate twice — second rotation
    // either splits the family or trips replay detection.
    const lockKey = this.rotationLockKey(hashKey);
    const lockToken = randomUUID();
    const lockAcquired = await this.redis
      .set(lockKey, lockToken, "PX", AuthService.REFRESH_LOCK_TTL_MS, "NX")
      .catch(() => null);
    if (lockAcquired !== "OK") {
      // Another rotation is in flight. Poll the cache briefly — the
      // winner publishes its result there before releasing the lock.
      const deadline = Date.now() + AuthService.REFRESH_LOCK_POLL_DEADLINE_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, AuthService.REFRESH_LOCK_POLL_INTERVAL_MS));
        const racy = await this.readRotationCache(hashKey);
        if (racy) return racy;
      }
      // Lock contention without a published result is unusual — likely
      // a Redis blip or a winner that errored before writing the
      // cache. Surfacing 401 forces a fresh login on this tab; the
      // user's other tabs still have the rotated cookie.
      throw new UnauthorizedError("refresh_busy", "refresh_busy");
    }

    try {
      // Re-check the cache once we hold the lock: the winner may have
      // completed and released between our initial miss and the
      // lock-acquire above.
      const postLockCached = await this.readRotationCache(hashKey);
      if (postLockCached) return postLockCached;

      const now = new Date();
      // Look up by hash WITHOUT the revoked filter so we can distinguish
      // "no such token" from "token reuse".
      const [session] = await this.db
        .select()
        .from(sessions)
        .where(eq(sessions.refreshTokenHash, hash))
        .limit(1);
      if (!session) throw new UnauthorizedError("invalid_refresh", "invalid_refresh");

      if (session.revokedAt) {
        // Token reuse — burn the whole family. The legitimate client and
        // any thief both lose access; user re-authenticates.
        const family = await this.db
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.familyId, session.familyId), isNull(sessions.revokedAt)))
          .returning({ id: sessions.id });
        await Promise.all(family.map((s) => this.cacheRevoked(s.id)));
        throw new UnauthorizedError("refresh_replayed", "refresh_replayed");
      }
      if (session.expiresAt.getTime() <= now.getTime()) {
        throw new UnauthorizedError("refresh_expired", "refresh_expired");
      }

      const [user] = await this.db
        .select()
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);
      if (!user || user.status === "blocked") {
        throw new UnauthorizedError("account_unavailable", "account_unavailable");
      }

      // Rotate: revoke old, issue new in same family atomically.
      const result = await this.db.transaction(async (tx) => {
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(eq(sessions.id, session.id));
        return this.issueTokensWith(tx, user.id, user.role, ctx, {
          familyId: session.familyId,
          parentSessionId: session.id,
        });
      });
      await this.cacheRevoked(session.id);
      // Publish the result before releasing the lock so concurrent
      // pollers find it.
      await this.writeRotationCache(hashKey, result);
      return result;
    } finally {
      // Release only if we still own the lock (it may have expired and
      // been re-acquired by another worker).
      try {
        await this.redis.eval(AuthService.RELEASE_LOCK_LUA, 1, lockKey, lockToken);
      } catch {
        // Lock will expire on its own via PX TTL.
      }
    }
  }

  async logout(sessionId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.id, sessionId));
    await this.cacheRevoked(sessionId);
  }

  async me(userId: string): Promise<PublicUser | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return user ? publicUser(user) : null;
  }

  /**
   * Revokes every non-revoked session for a user. Called on password change —
   * we force every device to re-login rather than try to preserve current.
   * The cache flip on each revoked session id is what makes the existing
   * 15-min access JWTs stop working immediately.
   */
  async revokeAllSessions(userId: string): Promise<void> {
    const revoked = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    await Promise.all(revoked.map((s) => this.cacheRevoked(s.id)));
  }

  private async issueTokens(
    userId: string,
    role: "user" | "admin" | "support",
    ctx: { ip: string | null; userAgent: string | null; deviceId: string | null },
  ): Promise<IssuedTokens> {
    return this.issueTokensWith(this.db, userId, role, ctx);
  }

  private async issueTokensWith(
    tx: DbOrTx,
    userId: string,
    role: "user" | "admin" | "support",
    ctx: { ip: string | null; userAgent: string | null; deviceId: string | null },
    parent?: { familyId: string; parentSessionId: string },
  ): Promise<IssuedTokens> {
    const refresh = newRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + this.auth.refreshTtlDays * 24 * 60 * 60 * 1000);

    // New login starts a fresh family; refresh continues an existing one.
    const familyId = parent?.familyId ?? randomUUID();
    const parentSessionId = parent?.parentSessionId ?? null;

    const [session] = await tx
      .insert(sessions)
      .values({
        userId,
        refreshTokenHash: refresh.hash,
        deviceId: ctx.deviceId,
        userAgent: ctx.userAgent,
        ipInet: ctx.ip,
        expiresAt: refreshExpiresAt,
        familyId,
        parentSessionId,
      })
      .returning({ id: sessions.id });
    if (!session) throw new Error("session insert returned no row");

    const claims: AccessTokenClaims = {
      sub: userId,
      role,
      sid: session.id,
    };
    const accessExpiresAt = new Date(Date.now() + this.auth.jwtAccessTtlSeconds * 1000);
    const accessToken = await signAccessToken(
      claims,
      this.jwtKey,
      this.auth.jwtAccessTtlSeconds,
    );

    return {
      userId,
      role,
      accessToken,
      accessExpiresAt,
      refreshTokenRaw: refresh.raw,
      refreshExpiresAt,
      sessionId: session.id,
    };
  }
}

function publicUser(row: typeof users.$inferSelect): PublicUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    kycStatus: row.kycStatus,
    displayName: row.displayName,
    nickname: row.nickname,
    countryCode: row.countryCode,
    sportOrder: row.sportOrder ?? null,
    createdAt: row.createdAt,
  };
}
