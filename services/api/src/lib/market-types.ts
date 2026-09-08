// The provider_market_types registry, as the api reads it.
//
// Our own provider_market_id per market type since migration
// 20260908T115542. The id is OPAQUE — it carries no Fonbet table number —
// so anything that used to reason about `1_000_000 + table` now resolves
// through here:
//
//   • the payload's `marketKind`, so the BROWSER never needs the registry
//     (bet-assist keys off the kind, and it runs client-side);
//   • the static allowlists that name a market by table — the Fonbet
//     head-to-head pair, the ladder handicap and total tables — which stay
//     written as readable kinds and are resolved to ids per request.
//
// Cached because it only changes when Fonbet publishes a sub-event we have
// never seen: 1 060 types over 580 tables on production 2026-09-08, and a
// new one appears at most a few times a day. A miss is not an error — it
// means the ingester has not written that type yet, and the caller simply
// resolves nothing.

import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { cached } from "./cache.js";

/** How long a loaded registry is reused. New types appear rarely. */
const CACHE_SECONDS = 300;
const CACHE_KEY = "market-types:v1";

export interface MarketTypeRegistry {
  /** Our id -> the readable kind ("fb:120@100201"). */
  kindOf(providerMarketId: number): string | null;
  /** The readable kind -> our id. For the static allowlists. */
  idOf(marketKind: string): number | null;
  /** Every id whose kind is in `kinds`, for an `inArray` filter. */
  idsOf(kinds: readonly string[]): number[];
  readonly size: number;
}

interface Row {
  id: number;
  kind: string;
}

function build(rows: readonly Row[]): MarketTypeRegistry {
  const byId = new Map<number, string>();
  const byKind = new Map<string, number>();
  for (const r of rows) {
    byId.set(r.id, r.kind);
    // First id wins on a duplicate kind, which the unique index makes
    // impossible — belt and braces so a bad row cannot make this
    // non-deterministic.
    if (!byKind.has(r.kind)) byKind.set(r.kind, r.id);
  }
  return {
    kindOf: (id) => byId.get(id) ?? null,
    idOf: (kind) => byKind.get(kind) ?? null,
    idsOf: (kinds) => {
      const out: number[] = [];
      for (const k of kinds) {
        const id = byKind.get(k);
        if (id != null) out.push(id);
      }
      return out;
    },
    size: byId.size,
  };
}

/** An empty registry, for the graceful path when the table is unreachable. */
export const EMPTY_MARKET_TYPES: MarketTypeRegistry = build([]);

export async function loadMarketTypes(
  app: FastifyInstance,
): Promise<MarketTypeRegistry> {
  const rows = await cached(app.redis, CACHE_KEY, CACHE_SECONDS, async () => {
    const rows = await app.db.execute<{ id: number; kind: string }>(sql`
      SELECT provider_market_id AS "id", market_kind AS "kind"
        FROM provider_market_types
    `);
    return Array.from(rows).map((r) => ({
      id: Number(r.id),
      kind: String(r.kind),
    }));
  });
  return build(rows);
}
