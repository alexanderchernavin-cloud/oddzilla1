// HD wallet derivation for USDT deposit addresses.
//
// Two networks, two BIP44 coin types:
//   • Ethereum (ERC20 USDT): m/44'/60'/0'/0/<userIndex>
//   • Tron     (TRC20 USDT): m/44'/195'/0'/0/<userIndex>
//
// Both live on secp256k1. Ethereum ↔ Tron only differ in how the public
// key becomes an address.
//
// SECURITY
// --------
// The master mnemonic lives in HD_MASTER_MNEMONIC on this process for MVP.
// Before public launch it moves into an isolated signer container (see
// docs/PHASES.md exit criteria). This file intentionally derives ONLY
// addresses (public keys) — no signing. Signing code belongs in
// wallet-watcher / the future signer service, never in the user-facing API.

import {
  Mnemonic,
  HDNodeWallet,
  SigningKey,
  keccak256,
  getBytes,
} from "ethers";
import { createHash } from "node:crypto";
import bs58 from "bs58";

const ETH_PATH = "m/44'/60'/0'/0";
const TRON_PATH = "m/44'/195'/0'/0";

/**
 * Derives the Ethereum address at userIndex. EIP-55 checksummed.
 * Validates the mnemonic once and caches the root node in-process so
 * subsequent derivations don't redo BIP39 seed expansion.
 */
export function deriveEthereumAddress(mnemonic: string, userIndex: number): string {
  const root = rootFor(mnemonic);
  const child = root.derivePath(`${ETH_PATH}/${userIndex}`);
  return child.address; // already checksummed
}

/**
 * Derives the Tron address at userIndex. Returns the Base58Check-encoded
 * T-prefixed form (the standard on-chain representation).
 *
 * Tron address = Base58Check(0x41 || keccak256(uncompressed_pubkey[1:])[-20:])
 */
export function deriveTronAddress(mnemonic: string, userIndex: number): string {
  const root = rootFor(mnemonic);
  const child = root.derivePath(`${TRON_PATH}/${userIndex}`);

  // `child.publicKey` is compressed (33 bytes, 0x02/0x03 prefix). Uncompress
  // to 65 bytes (0x04 || X || Y).
  const uncompressed = SigningKey.computePublicKey(child.publicKey, false);
  const pubBytes = getBytes(uncompressed).slice(1); // drop 0x04 prefix → 64 bytes

  const hashHex = keccak256(pubBytes);
  const addressBytes = getBytes(hashHex).slice(-20); // low 20 bytes

  const tronBody = new Uint8Array(21);
  tronBody[0] = 0x41; // Tron mainnet prefix
  tronBody.set(addressBytes, 1);

  return base58check(tronBody);
}

export interface DerivedAddressPair {
  ERC20: string;
  TRC20: string;
}

export function deriveAddressesForUser(mnemonic: string, userIndex: number): DerivedAddressPair {
  return {
    ERC20: deriveEthereumAddress(mnemonic, userIndex),
    TRC20: deriveTronAddress(mnemonic, userIndex),
  };
}

export function derivationPath(network: "ERC20" | "TRC20", userIndex: number): string {
  return network === "ERC20"
    ? `${ETH_PATH}/${userIndex}`
    : `${TRON_PATH}/${userIndex}`;
}

// ─── Internals ──────────────────────────────────────────────────────────────

const rootCache = new Map<string, HDNodeWallet>();

function rootFor(mnemonic: string): HDNodeWallet {
  const cached = rootCache.get(mnemonic);
  if (cached) return cached;
  const m = Mnemonic.fromPhrase(mnemonic);
  const node = HDNodeWallet.fromMnemonic(m);
  rootCache.set(mnemonic, node);
  return node;
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function base58check(payload: Uint8Array): string {
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(checksum, payload.length);
  return bs58.encode(full);
}

// ─── Helpers for deterministic user-index assignment ───────────────────────

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
