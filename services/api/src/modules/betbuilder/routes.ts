// Oddin BetBuilder (OBB) routes. Frontend uses these to:
//
//   GET  /betbuilder/match/:id/markets     — initial paint, list OBB-eligible markets
//   POST /betbuilder/match/:id/quote       — create/refresh an OBB session
//                                             from a list of selections
//
// Both routes return 503 `betbuilder_disabled` when ODDIN_OBB_HOST is
// empty (graceful idle). The same pattern Disir widgets use — when
// disabled the storefront silently hides the toggle.

import type { FastifyInstance } from "fastify";
import { eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  matches,
  markets,
  marketOutcomes,
} from "@oddzilla/db";
import { canonical, parse as parseSpecifiers } from "@oddzilla/types/specifiers";
import type {
  BetBuilderAvailableMarket,
  BetBuilderAvailableOutcome,
  BetBuilderQuoteAcceptedResponse,
  BetBuilderQuoteRejectedResponse,
  BetBuilderQuoteResponse,
  BetBuilderAvailableMarketsResponse,
} from "@oddzilla/types";
import { getSharedObbClient, ObbError } from "../../lib/obb-client.js";
import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../lib/errors.js";

// Shared singleton across betbuilder routes + bets service so both
// paths reuse the same gRPC channel (keepalive + connection pool).
// Null when ODDIN_OBB_HOST is empty — the routes 503
// `betbuilder_disabled` and the frontend silently hides the toggle.
const obb = getSharedObbClient();

const sessionsRateLimit = {
  rateLimit: {
    // Oddin caps SessionCreate at 100 RPS globally — well above what
    // any single user could hit. The per-client cap is to dampen abuse:
    // a slip can refresh on every click; 30/min is generous.
    max: 30,
    timeWindow: "1 minute",
  },
};

const quoteBody = z.object({
  selections: z
    .array(
      z.object({
        marketId: z.string().regex(/^\d+$/),
        outcomeId: z.string().min(1).max(64),
      }),
    )
    .min(1)
    .max(20),
});

/**
 * Build the Oddin selection_id wire format from internal pieces. Per the
 * OBB doc §2.4.1, the format is literally `<event>/<market>/<outcome>?<spec>`
 * where `<spec>` is `k1=v1&k2=v2` with values unencoded — the doc's
 * example uses `?variant=way:two&way=two` (literal colon). Running values
 * through encodeURIComponent breaks Oddin's parser; spec values come from
 * Oddin's own feed, so they're already safe (`way:two`, `total:over`,
 * numeric thresholds, etc. — no `&`, `=`, `?`, or `#`). Keys are sorted
 * lexicographically for stable round-trip with our markets.specifiers_hash.
 */
function buildSelectionId(
  eventUrn: string,
  providerMarketId: number,
  outcomeId: string,
  specifiers: Record<string, string>,
): string {
  const keys = Object.keys(specifiers).sort();
  const qs = keys.map((k) => `${k}=${specifiers[k]!}`).join("&");
  const base = `${eventUrn}/${providerMarketId}/${outcomeId}`;
  return qs ? `${base}?${qs}` : base;
}

/** Map Oddin's reject Code enum (proto) into our public union. */
function mapRejectReason(code: number): BetBuilderQuoteRejectedResponse["reason"] {
  // SessionRejectReason.Code from session.proto:
  //   0 UNSPECIFIED, 1 INTERNAL, 2 INVALID_ARGUMENT,
  //   3 INVALID_MARKET_COMBINATION, 4 INACTIVE_MARKET
  switch (code) {
    case 1:
      return "internal";
    case 2:
      return "invalid_argument";
    case 3:
      return "invalid_market_combination";
    case 4:
      return "inactive_market";
    default:
      return "unknown";
  }
}

export default async function betbuilderRoutes(app: FastifyInstance) {
  if (!obb) {
    app.log.warn(
      { component: "betbuilder" },
      "ODDIN_OBB_HOST/ODDIN_OBB_TOKEN unset — /betbuilder/* will 503",
    );
  }

  // ── GET /betbuilder/match/:id/markets ────────────────────────────
  // Returns the set of OBB-eligible markets for a match. Frontend uses
  // this to paint a "BetBuilder available" indicator on the match page;
  // unmapped markets are excluded so the storefront only ever surfaces
  // markets it can actually price.
  app.get(
    "/betbuilder/match/:id/markets",
    async (request): Promise<BetBuilderAvailableMarketsResponse> => {
      if (!obb) {
        throw new ServiceUnavailableError("betbuilder_disabled", "betbuilder_disabled");
      }
      const params = z.object({ id: z.coerce.bigint() }).parse(request.params);

      const [match] = await app.db
        .select({
          id: matches.id,
          providerUrn: matches.providerUrn,
        })
        .from(matches)
        .where(eq(matches.id, params.id))
        .limit(1);
      if (!match || !match.providerUrn) {
        throw new NotFoundError("match_not_found", "match_not_found");
      }

      let raw;
      try {
        raw = await obb.availableMarkets(match.providerUrn);
      } catch (err) {
        if (err instanceof ObbError) {
          // Oddin downtime is transient — surface as 503 so the slip
          // hides the toggle until it recovers.
          throw new ServiceUnavailableError("betbuilder_unavailable", err.message);
        }
        throw err;
      }

      // Reverse-map (provider_market_id, specifiers_hash) → internal id.
      // `markets.specifiersHash` is a 32-byte sha256 of the canonical
      // string the feed-ingester wrote at insert. We re-canonicalize on
      // our side so a permutation in Oddin's specifiers string still
      // resolves to the same row.
      const matchedRows = raw.markets.map((m) => ({
        providerMarketId: m.marketId,
        specifiersJson: parseSpecifiers(m.specifiers),
        rawSpecifiers: m.specifiers,
      }));
      const providerMarketIds = Array.from(
        new Set(matchedRows.map((r) => r.providerMarketId)),
      );
      const internal = providerMarketIds.length
        ? await app.db
            .select({
              id: markets.id,
              providerMarketId: markets.providerMarketId,
              specifiersJson: markets.specifiersJson,
            })
            .from(markets)
            .where(
              and(
                eq(markets.matchId, params.id),
                inArray(markets.providerMarketId, providerMarketIds),
              ),
            )
        : [];
      const internalByKey = new Map<string, string>();
      for (const r of internal) {
        const key = `${r.providerMarketId}|${canonical((r.specifiersJson ?? {}) as Record<string, string>)}`;
        internalByKey.set(key, r.id.toString());
      }

      const marketIds: string[] = [];
      for (const r of matchedRows) {
        const key = `${r.providerMarketId}|${canonical(r.specifiersJson)}`;
        const id = internalByKey.get(key);
        if (id) marketIds.push(id);
      }

      return {
        marketIds,
        raw: matchedRows.map((r) => ({
          providerMarketId: r.providerMarketId,
          specifiers: r.rawSpecifiers,
        })),
      };
    },
  );

  // ── POST /betbuilder/match/:id/quote ─────────────────────────────
  // Build (or refresh) an OBB session for the supplied selections.
  // Returns the combined session odds + the still-available markets
  // the user could add. Same shape Oddin's SessionCreate returns,
  // except we map Oddin's market ids back to our internal market ids
  // so the slip can render outcomes against existing buttons.
  app.post(
    "/betbuilder/match/:id/quote",
    { config: sessionsRateLimit },
    async (request): Promise<BetBuilderQuoteResponse> => {
      if (!obb) {
        throw new ServiceUnavailableError("betbuilder_disabled", "betbuilder_disabled");
      }
      // Auth optional but rate-limited per IP. The server doesn't write
      // any state here — placement is the only authenticated path.
      const params = z.object({ id: z.coerce.bigint() }).parse(request.params);
      const body = quoteBody.parse(request.body);

      const [match] = await app.db
        .select({
          id: matches.id,
          providerUrn: matches.providerUrn,
          status: matches.status,
        })
        .from(matches)
        .where(eq(matches.id, params.id))
        .limit(1);
      if (!match || !match.providerUrn) {
        throw new NotFoundError("match_not_found", "match_not_found");
      }
      if (match.status !== "not_started" && match.status !== "live") {
        throw new BadRequestError("match_not_open", "match_not_open");
      }
      const eventUrn = match.providerUrn;

      const internalMarketIds = body.selections.map((s) => BigInt(s.marketId));
      const marketRows = await app.db
        .select({
          id: markets.id,
          providerMarketId: markets.providerMarketId,
          specifiersJson: markets.specifiersJson,
          status: markets.status,
          matchId: markets.matchId,
        })
        .from(markets)
        .where(inArray(markets.id, internalMarketIds));
      const marketByID = new Map(marketRows.map((m) => [m.id.toString(), m]));

      // Validate all legs belong to this match.
      for (const sel of body.selections) {
        const m = marketByID.get(sel.marketId);
        if (!m) {
          throw new BadRequestError("market_not_found", "market_not_found");
        }
        if (m.matchId !== params.id) {
          throw new BadRequestError("betbuilder_cross_match", "betbuilder_cross_match");
        }
      }

      // Validate outcomes exist (cheap sanity vs typo'd outcome ids).
      const outcomeRows = await app.db
        .select({
          marketId: marketOutcomes.marketId,
          outcomeId: marketOutcomes.outcomeId,
        })
        .from(marketOutcomes)
        .where(inArray(marketOutcomes.marketId, internalMarketIds));
      const outcomeKeys = new Set(
        outcomeRows.map((o) => `${o.marketId.toString()}:${o.outcomeId}`),
      );
      for (const sel of body.selections) {
        if (!outcomeKeys.has(`${sel.marketId}:${sel.outcomeId}`)) {
          throw new BadRequestError("outcome_not_found", "outcome_not_found");
        }
      }

      const selectionIds = body.selections.map((sel) => {
        const m = marketByID.get(sel.marketId)!;
        return buildSelectionId(
          eventUrn,
          m.providerMarketId,
          sel.outcomeId,
          (m.specifiersJson ?? {}) as Record<string, string>,
        );
      });

      let raw;
      try {
        raw = await obb.sessionCreate(selectionIds);
      } catch (err) {
        if (err instanceof ObbError) {
          throw new ServiceUnavailableError("betbuilder_unavailable", err.message);
        }
        throw err;
      }

      if (raw.status === "rejected") {
        const r = raw.rejected!;
        const out: BetBuilderQuoteRejectedResponse = {
          status: "rejected",
          reason: mapRejectReason(r.reason?.code ?? 0),
          message: r.reason?.message ?? "",
          selectionsRejected: r.selectionsRejected
            ? Object.fromEntries(
                Object.entries(r.selectionsRejected).map(([k, v]) => [
                  k,
                  { code: String(v.code), message: v.message },
                ]),
              )
            : undefined,
        };
        return out;
      }

      const created = raw.created!;
      const oddsX10000 = Number(created.odds);
      if (!Number.isFinite(oddsX10000) || oddsX10000 <= 0) {
        throw new ServiceUnavailableError(
          "betbuilder_unavailable",
          "obb_invalid_odds",
        );
      }
      const combinedOdds = (oddsX10000 / 10_000).toFixed(2);

      // Map available_markets back to our internal market ids so the
      // frontend can render them against existing outcome buttons. Oddin
      // can return markets we haven't seen yet (unmapped) — those keep
      // marketId=null and the slip can show them disabled.
      const obbProviderIds = Array.from(
        new Set(created.availableMarkets.map((m) => m.marketId)),
      );
      const obbInternal = obbProviderIds.length
        ? await app.db
            .select({
              id: markets.id,
              providerMarketId: markets.providerMarketId,
              specifiersJson: markets.specifiersJson,
            })
            .from(markets)
            .where(
              and(
                eq(markets.matchId, params.id),
                inArray(markets.providerMarketId, obbProviderIds),
              ),
            )
        : [];
      const internalByKey = new Map<string, string>();
      for (const r of obbInternal) {
        const key = `${r.providerMarketId}|${canonical((r.specifiersJson ?? {}) as Record<string, string>)}`;
        internalByKey.set(key, r.id.toString());
      }
      const availableMarkets: BetBuilderAvailableMarket[] = created.availableMarkets.map(
        (m) => {
          const specObj = parseSpecifiers(m.specifiers);
          const key = `${m.marketId}|${canonical(specObj)}`;
          const internalId = internalByKey.get(key) ?? null;
          const outcomes: BetBuilderAvailableOutcome[] = m.outcomes.map((o) => {
            const ox = Number(o.odds);
            return {
              outcomeId: o.outcomeId,
              odds: Number.isFinite(ox) && ox > 0 ? (ox / 10_000).toFixed(2) : "0.00",
              oddsX10000: Number.isFinite(ox) ? ox : 0,
              rawProbability:
                typeof o.rawProbability === "number" && o.rawProbability > 0
                  ? o.rawProbability.toFixed(6)
                  : undefined,
            };
          });
          return {
            marketId: internalId,
            providerMarketId: m.marketId,
            specifiers: m.specifiers,
            outcomes,
          };
        },
      );

      const accepted: BetBuilderQuoteAcceptedResponse = {
        status: "accepted",
        sessionId: raw.sessionId,
        selectionIds: created.selections.map((s) => s.selectionId),
        oddsX10000,
        combinedOdds,
        rawProbability:
          typeof created.rawProbability === "number" && created.rawProbability > 0
            ? created.rawProbability.toFixed(6)
            : undefined,
        availableMarkets,
      };
      return accepted;
    },
  );
}
