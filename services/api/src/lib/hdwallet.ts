// HD wallet helpers — purely public-key / index utilities.
//
// SECURITY
// --------
// Address derivation lives in the signer container (services/signer)
// since PR #132. The mnemonic is no longer in this process. Callers
// requesting a derived address go through `signer-client.ts`. This file
// keeps the two pieces that don't touch the secret: the deterministic
// per-user index from a UUID, and the path string for storage in
// deposit_addresses.derivation_path.
//
// The previous local derivation code is gone. If you need to verify
// what addresses the signer produces, run the Go parity test:
//   (cd services/signer && go test ./internal/derive/...)

import { createHash } from "node:crypto";

const ETH_PATH = "m/44'/60'/0'/0";
const TRON_PATH = "m/44'/195'/0'/0";

export type Network = "ERC20" | "TRC20";

export function derivationPath(network: Network, userIndex: number): string {
  return network === "ERC20"
    ? `${ETH_PATH}/${userIndex}`
    : `${TRON_PATH}/${userIndex}`;
}

/**
 * Generates a stable 31-bit BIP32 index from a user UUID. BIP32 requires
 * non-hardened child indices to be < 2^31; we hash the UUID and mask.
 *
 * WHY NOT a sequential SERIAL column: users delete/block happens over
 * time, and reusing an index for a different user would cause address
 * collisions. A hash-derived index from the UUID is stable forever.
 */
export function userIndexFromUUID(userUuid: string): number {
  const digest = createHash("sha256").update(userUuid).digest();
  // First 4 bytes → u32, mask top bit to keep it in the non-hardened range.
  const n =
    (digest[0]! << 24) |
    (digest[1]! << 16) |
    (digest[2]! << 8) |
    digest[3]!;
  return n >>> 1; // shift to clear top bit
}

// Re-export the signer client so callers don't need a separate import.
export {
  deriveAddressesForUser,
  deriveAddress,
  signHash,
  SignerUnavailableError,
  type DerivedAddress,
  type SignedHash,
} from "./signer-client.js";
