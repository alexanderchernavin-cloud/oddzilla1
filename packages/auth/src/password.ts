import argon2 from "@node-rs/argon2";

// argon2id parameters — bumped per OWASP 2026 minimum (m≥46 MiB, t=1).
// The m=46 MiB profile is faster than the previous m=19 MiB t=2 setting
// on the same hardware while strictly more resistant to GPU / dedicated
// silicon, since memory cost is what defeats those attackers. Revisit
// upward when the box is upgraded past CPX22.
// `Algorithm` is a const enum in @node-rs/argon2; under isolatedModules
// we can't reference it, so we pass the numeric value directly.
// 2 = Argon2id.
const ARGON2_OPTS = {
  memoryCost: 47_104, // 46 MiB
  timeCost: 1,
  parallelism: 1,
  algorithm: 2, // argon2.Algorithm.Argon2id
} as const;

// Pre-computed dummy hash for timing-equalisation. When a login lookup
// finds no user, we run verifyPassword against this hash so the request
// takes roughly as long as a real password verification — without it, an
// attacker can probe registered email addresses by measuring response
// latency.
//
// The plaintext that produced this hash is irrelevant; verifyPassword
// against any other input will return false.
let DUMMY_HASH: string | null = null;
async function dummyHash(): Promise<string> {
  if (DUMMY_HASH === null) {
    DUMMY_HASH = await argon2.hash("oddzilla-timing-dummy-v1", ARGON2_OPTS);
  }
  return DUMMY_HASH;
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

// Run a verifyPassword against a static dummy hash so the caller spends
// the same wall-clock time it would have on a real verify. Used by the
// login path when the email is unknown.
export async function verifyDummyPassword(plain: string): Promise<void> {
  await verifyPassword(await dummyHash(), plain);
}
