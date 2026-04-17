// Canonical market-specifier representation. The output of `canonical()` is
// what feed-ingester stores in markets.specifiers_json. `hash()` produces the
// 32-byte sha256 stored in markets.specifiers_hash.
//
// CRITICAL: the Go implementation at
// services/feed-ingester/internal/oddinxml/specifiers.go must produce the
// byte-identical canonical string and hash for the same input.

import { createHash } from "node:crypto";

export type Specifiers = Record<string, string>;

/** Canonical pipe-separated form: `k1=v1|k2=v2`, keys sorted lexicographically. */
export function canonical(specs: Specifiers): string {
  const keys = Object.keys(specs).sort();
  return keys.map((k) => `${k}=${specs[k]}`).join("|");
}

/** 32-byte sha256 of the canonical form, as a Buffer. */
export function hash(specs: Specifiers): Buffer {
  return createHash("sha256").update(canonical(specs), "utf8").digest();
}

/** Parse an Oddin-style "k=v|k=v" string back into a Specifiers map. */
export function parse(raw: string): Specifiers {
  if (!raw) return {};
  const out: Specifiers = {};
  for (const pair of raw.split("|")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}
