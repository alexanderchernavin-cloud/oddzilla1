import argon2 from "@node-rs/argon2";

// argon2id parameters — tuned for Hetzner CPX22 (~50ms per hash).
// Revisit on hardware upgrade.
// `Algorithm` is a const enum in @node-rs/argon2; under isolatedModules we
// can't reference it, so we pass the numeric value directly. 2 = Argon2id.
const ARGON2_OPTS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
  algorithm: 2, // argon2.Algorithm.Argon2id
} as const;

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
