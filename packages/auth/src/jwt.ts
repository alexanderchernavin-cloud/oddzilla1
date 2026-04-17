import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { randomBytes, createHash } from "node:crypto";

const ISSUER = "oddzilla";

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  role: "user" | "admin" | "support";
  sid?: string;
}

export function secretKey(raw: string): Uint8Array {
  return new TextEncoder().encode(raw);
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: Uint8Array,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secret);
}

export async function verifyAccessToken(
  token: string,
  secret: Uint8Array,
): Promise<AccessTokenClaims> {
  // Pin the algorithm explicitly. With a symmetric secret jose would reject
  // asymmetric algs at runtime, but naming HS256 forecloses future confusion.
  const { payload } = await jwtVerify(token, secret, {
    issuer: ISSUER,
    algorithms: ["HS256"],
  });
  return payload as AccessTokenClaims;
}

/** Refresh tokens are opaque random bytes; we store sha256 of the token. */
export function newRefreshToken(): { raw: string; hash: Buffer } {
  const raw = randomBytes(48).toString("base64url");
  const hash = createHash("sha256").update(raw, "utf8").digest();
  return { raw, hash };
}

export function hashRefreshToken(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}
