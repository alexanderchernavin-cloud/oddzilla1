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
  countryCode: string | null;
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

  async signup(input: CreateUserInput): Promise<{ user: PublicUser; tokens: IssuedTokens }> {
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email.toLowerCase()))
      .limit(1);
    if (existing.length > 0) throw new ConflictError("email_in_use", "email_in_use");

    const passwordHash = await hashPassword(input.password);

    // Create user + per-currency wallets atomically. Every signup gets a
    // zero-balance USDT wallet (real money) and an OZ wallet pre-funded
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
          { userId: created.id, currency: "USDT", balanceMicro: 0n },
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
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    if (!user) {
      // Equalise wall-clock time so an attacker can't tell registered
      // emails apart from unregistered ones via response latency. Without
      // this branch a missing-user request returns in ~1 ms while a found
      // user spends ~50 ms inside argon2.verify.
      await verifyDummyPassword(password);
      throw new UnauthorizedError("invalid_credentials", "invalid_credentials");
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) throw new UnauthorizedError("invalid_credentials", "invalid_credentials");

    if (user.status === "blocked") {
      throw new UnauthorizedError("account_blocked", "account_blocked");
    }

    await this.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    const tokens = await this.issueTokens(user.id, user.role, ctx);
    return { user: publicUser(user), tokens };
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
    return result;
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
    countryCode: row.countryCode,
    createdAt: row.createdAt,
  };
}
