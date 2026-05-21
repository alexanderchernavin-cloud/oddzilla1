// Single-use random tokens for email verification + password reset.
//
// Construction: 256 bits of cryptographic randomness, base64url-encoded
// (no padding) so the value is URL-safe without escaping. The raw value
// is sent to the user's inbox; the DB stores only sha256(raw) so a
// later table exfiltration leaks nothing useful.
//
// 256 bits is comfortable headroom — both NIST SP 800-63B and OWASP
// suggest >= 128 bits for non-rate-limited recovery tokens. Doubling
// to 256 costs 11 extra characters in the URL and rules out brute force
// even against an offline copy of the table.

import { createHash, randomBytes } from "node:crypto";

export interface MintedToken {
  /** The raw value to embed in the email link. */
  raw: string;
  /** sha256(raw) — store this in the DB. */
  hash: Buffer;
}

export function mintToken(): MintedToken {
  // 32 random bytes ≈ 43 characters in base64url. URL-safe out of the box.
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest();
  return { raw, hash };
}

export function hashTokenRaw(raw: string): Buffer {
  return createHash("sha256").update(raw).digest();
}
