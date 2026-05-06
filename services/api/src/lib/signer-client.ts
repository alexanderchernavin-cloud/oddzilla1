// Client for the signer service over a Unix-socket HTTP transport.
//
// The signer container holds HD_MASTER_MNEMONIC; the API doesn't.
// Every address-derivation or sign-hash operation goes through this
// client. If SIGNER_SOCKET_PATH is unset OR the socket isn't
// connectable, the client surfaces a clear error so the caller can
// 503 the request — there is intentionally no in-process fallback.

import { Agent, request as undiciRequest } from "undici";

const SIGNER_SOCKET = process.env.SIGNER_SOCKET_PATH ?? "";

// Undici can dial Unix sockets via an agent; the URL host is a
// dummy because the agent is what picks the socket.
const agent = SIGNER_SOCKET
  ? new Agent({
      connect: { socketPath: SIGNER_SOCKET, timeout: 2_000 },
      headersTimeout: 5_000,
      bodyTimeout: 5_000,
    })
  : null;

export class SignerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerUnavailableError";
  }
}

async function call<TReq, TResp>(path: string, body: TReq): Promise<TResp> {
  if (!agent) {
    throw new SignerUnavailableError(
      "SIGNER_SOCKET_PATH is not set; the signer service is required for HD operations",
    );
  }
  let res;
  try {
    res = await undiciRequest(`http://signer${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      dispatcher: agent,
    });
  } catch (err) {
    throw new SignerUnavailableError(
      `signer ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.body.text();
  if (res.statusCode !== 200) {
    throw new SignerUnavailableError(`signer ${path} ${res.statusCode}: ${text}`);
  }
  return JSON.parse(text) as TResp;
}

export type Network = "ERC20" | "TRC20";

export interface DerivedAddress {
  address: string;
  derivationPath: string;
}

export async function deriveAddress(
  network: Network,
  userIndex: number,
): Promise<DerivedAddress> {
  return call<{ network: Network; userIndex: number }, DerivedAddress>(
    "/derive",
    { network, userIndex },
  );
}

export async function deriveAddressesForUser(
  userIndex: number,
): Promise<{ ERC20: string; TRC20: string }> {
  const [eth, tron] = await Promise.all([
    deriveAddress("ERC20", userIndex),
    deriveAddress("TRC20", userIndex),
  ]);
  return { ERC20: eth.address, TRC20: tron.address };
}

export interface SignedHash {
  signature: string; // 0x-prefixed 65-byte hex (r || s || v)
  address: string; // 0x-prefixed ETH-form derived address (cross-check)
}

export async function signHash(input: {
  derivationPath: string;
  messageHash: string; // 0x-prefixed 32-byte hex
  auditTag?: string;
}): Promise<SignedHash> {
  return call<typeof input, SignedHash>("/sign", input);
}
