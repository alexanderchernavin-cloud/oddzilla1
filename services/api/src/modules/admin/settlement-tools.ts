// Operator tools behind /admin/unsettled (docs/SETTLEMENT_COVERAGE_PLAN.md).
// Admin-only. Every mutation is audit-logged.
//
//   GET    /admin/unsettled/denylist                 rules + open markets still under each
//   POST   /admin/unsettled/denylist                 add a rule (table id or label prefix)
//   DELETE /admin/unsettled/denylist/:id             remove a rule
//   GET    /admin/unsettled/denylist/:id/markets     the open markets a rule covers
//   GET    /admin/unsettled/misses                   fixtures the Fonbet grader cannot find
//   POST   /admin/unsettled/markets/:marketId/void   void one market (operator decision)
//   POST   /admin/unsettled/matches/:matchId/void-open  void every open market of a finished match
//
// The denylist (migration 20260906T103343_settlement_operator_tools) is
// the answer to "we offer markets no grader can ever settle":
// fonbet-ingester re-reads it every minute and stops creating those
// shapes; the markets already created under a rule stay listed here so
// the operator can see what would be gained by writing the grading for
// one of them.
//
// Voiding is deliberately a BUTTON, not a sweeper (operator decision
// 2026-09-06): a played market whose result we do not know must never be
// refunded automatically, because a refund is a wrong settlement for
// whoever held the winning side. The button publishes the same `cancel`
// message the Fonbet grader uses for an abandoned event onto
// `settlement.external`, so the void goes through services/settlement's
// apply-once path — market to -4, every selection void, tickets reversed if
// they had already paid. Only markets on FINISHED matches can be voided
// here; a live market is the feed's business.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { adminAuditLog, fonbetMarketDenylist } from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";

const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

// Same stream and cap the Fonbet grader publishes on (bus.StreamSettlement /
// SettlementMaxLenApprox in fonbet-ingester); services/settlement consumes
// it with group `settlement`.
const SETTLEMENT_STREAM = process.env.SETTLEMENT_EXTERNAL_STREAM || "settlement.external";
const SETTLEMENT_STREAM_MAXLEN = "20000";

// Bounds the "open markets under this rule" scans; rules are about the
// current offer, and anything older is the plan document's business.
const DENYLIST_SCAN_DAYS = 30;

const ruleBody = z
  .object({
    kind: z.enum(["table", "label_prefix"]),
    // The Fonbet catalogue table number (7800), not 1 000 000 + it.
    tableNum: z.coerce.number().int().positive().optional(),
    labelPrefix: z.string().trim().min(2).max(120).optional(),
    reason: z.string().trim().max(500).default(""),
  })
  .refine(
    (b) =>
      (b.kind === "table" && b.tableNum !== undefined && b.labelPrefix === undefined) ||
      (b.kind === "label_prefix" && b.labelPrefix !== undefined && b.tableNum === undefined),
    { message: "a table rule takes tableNum, a label_prefix rule takes labelPrefix" },
  );

const voidBody = z.object({
  reason: z.string().trim().max(500).default(""),
});

// Canonical `k=v|k=v` with keys sorted — the same form
// packages/types/src/specifiers.ts hashes and the settlement service parses
// off the stream. Inlined (five lines) rather than imported through the
// package barrel; see the oddzilla-types-barrel-imports note.
function canonicalSpecifiers(json: string | null): string {
  if (!json) return "";
  const parsed = JSON.parse(json) as Record<string, string>;
  return Object.keys(parsed)
    .sort()
    .map((k) => `${k}=${parsed[k]}`)
    .join("|");
}

function iso(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// The predicate a denylist rule expands to over `markets mk` joined with
// `market_descriptions md` (en, this market's own variant).
//
// A table rule matches through provider_market_types: it names a Fonbet
// catalogue TABLE and covers every sub-event of it, which is what it always
// meant, and which one provider_market_id can no longer express now that
// each sub-event has its own (migration 20260908T115542).
function ruleMatches(kind: string, tableNum: number | null, labelPrefix: string | null) {
  if (kind === "table") {
    return sql`EXISTS (
      SELECT 1 FROM provider_market_types t
       WHERE t.provider_market_id = mk.provider_market_id
         AND t.table_num = ${tableNum}
    )`;
  }
  return sql`md.name_template ILIKE ${(labelPrefix ?? "").replace(/[%_\\]/g, "\\$&") + "%"}`;
}

export default async function adminSettlementToolsRoutes(app: FastifyInstance) {
  // ── Denylist ───────────────────────────────────────────────────────────

  app.get("/admin/unsettled/denylist", async (request) => {
    request.requireRole("admin");
    const rules = await app.db
      .select()
      .from(fonbetMarketDenylist)
      .orderBy(fonbetMarketDenylist.kind, fonbetMarketDenylist.id);

    const out = [];
    for (const r of rules) {
      const [counts] = (await app.db.execute(sql`
        SELECT COUNT(mk.id)::int AS markets, COUNT(DISTINCT mk.match_id)::int AS matches
          FROM markets mk
          JOIN matches m ON m.id = mk.match_id
          LEFT JOIN market_descriptions md
            ON md.provider_market_id = mk.provider_market_id
           AND md.language = 'en'
           AND md.variant = COALESCE(mk.specifiers_json->>'variant', '')
         WHERE m.provider_urn LIKE 'fb:%'
           AND m.status IN ('closed', 'cancelled')
           AND m.scheduled_at > NOW() - (${DENYLIST_SCAN_DAYS} || ' days')::interval
           AND mk.status NOT IN (-3, -4)
           AND ${ruleMatches(r.kind, r.tableNum, r.labelPrefix)}
      `)) as unknown as Array<{ markets: number; matches: number }>;
      out.push({
        id: r.id,
        kind: r.kind,
        tableNum: r.tableNum,
        labelPrefix: r.labelPrefix,
        reason: r.reason,
        createdAt: iso(r.createdAt)!,
        openMarkets: counts?.markets ?? 0,
        openMatches: counts?.matches ?? 0,
      });
    }
    return { rules: out, scanDays: DENYLIST_SCAN_DAYS };
  });

  app.post("/admin/unsettled/denylist", { config: writeRateLimit }, async (request) => {
    const admin = request.requireRole("admin");
    const body = ruleBody.parse(request.body);

    return app.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(fonbetMarketDenylist)
        .values({
          kind: body.kind,
          tableNum: body.kind === "table" ? body.tableNum! : null,
          labelPrefix: body.kind === "label_prefix" ? body.labelPrefix! : null,
          reason: body.reason,
          createdByUserId: admin.id,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        throw new BadRequestError("That table / prefix is already on the denylist", "denylist_rule_exists");
      }
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "settlement.denylist_add",
        targetType: "fonbet_market_denylist",
        targetId: String(row.id),
        afterJson: {
          kind: row.kind,
          tableNum: row.tableNum,
          labelPrefix: row.labelPrefix,
          reason: row.reason,
        },
      });
      return { rule: { ...row, createdAt: iso(row.createdAt) } };
    });
  });

  app.delete("/admin/unsettled/denylist/:id", { config: writeRateLimit }, async (request) => {
    const admin = request.requireRole("admin");
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);

    return app.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(fonbetMarketDenylist)
        .where(eq(fonbetMarketDenylist.id, id))
        .returning();
      if (!row) throw new NotFoundError();
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "settlement.denylist_remove",
        targetType: "fonbet_market_denylist",
        targetId: String(id),
        beforeJson: {
          kind: row.kind,
          tableNum: row.tableNum,
          labelPrefix: row.labelPrefix,
          reason: row.reason,
        },
      });
      return { removed: true };
    });
  });

  // The open markets a rule still covers — created before the rule existed,
  // or by a shape the rule only partly describes. Listed so the operator can
  // judge what writing a grader for the shape would recover.
  app.get("/admin/unsettled/denylist/:id/markets", async (request) => {
    request.requireRole("admin");
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const [rule] = await app.db
      .select()
      .from(fonbetMarketDenylist)
      .where(eq(fonbetMarketDenylist.id, id))
      .limit(1);
    if (!rule) throw new NotFoundError();

    const rows = (await app.db.execute(sql`
      SELECT mk.id::text AS market_id, mk.match_id::text AS match_id, mk.provider_market_id,
             mk.status AS market_status, mk.specifiers_json::text AS specifiers_json,
             md.name_template AS market_name,
             m.home_team, m.away_team, m.scheduled_at, m.status::text AS match_status,
             s.slug AS sport_slug, t.name AS tournament_name,
             (SELECT COUNT(DISTINCT tk.id)::int FROM ticket_selections ts JOIN tickets tk ON tk.id = ts.ticket_id
               WHERE ts.market_id = mk.id AND tk.status IN ('accepted', 'pending_delay')) AS open_tickets
        FROM markets mk
        JOIN matches m ON m.id = mk.match_id
        JOIN tournaments t ON t.id = m.tournament_id
        JOIN categories c ON c.id = t.category_id
        JOIN sports s ON s.id = c.sport_id
        LEFT JOIN market_descriptions md
          ON md.provider_market_id = mk.provider_market_id
         AND md.language = 'en'
         AND md.variant = COALESCE(mk.specifiers_json->>'variant', '')
       WHERE m.provider_urn LIKE 'fb:%'
         AND m.status IN ('closed', 'cancelled')
         AND m.scheduled_at > NOW() - (${DENYLIST_SCAN_DAYS} || ' days')::interval
         AND mk.status NOT IN (-3, -4)
         AND ${ruleMatches(rule.kind, rule.tableNum, rule.labelPrefix)}
       ORDER BY open_tickets DESC, m.scheduled_at DESC, mk.id
       LIMIT 200
    `)) as unknown as Array<{
      market_id: string;
      match_id: string;
      provider_market_id: number;
      market_status: number;
      specifiers_json: string | null;
      market_name: string | null;
      home_team: string;
      away_team: string;
      scheduled_at: Date | string;
      match_status: string;
      sport_slug: string;
      tournament_name: string;
      open_tickets: number;
    }>;

    return {
      markets: rows.map((r) => ({
        marketId: r.market_id,
        matchId: r.match_id,
        providerMarketId: r.provider_market_id,
        marketStatus: r.market_status,
        specifiers: r.specifiers_json,
        marketName: r.market_name,
        homeTeam: r.home_team,
        awayTeam: r.away_team,
        scheduledAt: iso(r.scheduled_at)!,
        matchStatus: r.match_status,
        sportSlug: r.sport_slug,
        tournamentName: r.tournament_name,
        openTickets: r.open_tickets,
      })),
    };
  });

  // ── Unmatched results ──────────────────────────────────────────────────

  // Pending Fonbet matches the grader could not find in the results feed,
  // written by fonbet-ingester every pass (store.RecordSettlementMisses)
  // and cleared the pass the fixture is found.
  app.get("/admin/unsettled/misses", async (request) => {
    request.requireRole("admin");
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(200) })
      .parse(request.query ?? {});
    const rows = (await app.db.execute(sql`
      SELECT fm.match_id::text AS match_id, fm.provider_urn, fm.home_team, fm.away_team, fm.scheduled_at,
             fm.segment_id, fm.candidates, fm.open_markets, fm.first_seen_at, fm.last_seen_at, fm.attempts,
             m.status::text AS match_status, s.slug AS sport_slug, t.name AS tournament_name
        FROM fonbet_settlement_misses fm
        JOIN matches m ON m.id = fm.match_id
        JOIN tournaments t ON t.id = m.tournament_id
        JOIN categories c ON c.id = t.category_id
        JOIN sports s ON s.id = c.sport_id
       ORDER BY fm.open_markets DESC, fm.last_seen_at DESC
       LIMIT ${q.limit}
    `)) as unknown as Array<{
      match_id: string;
      provider_urn: string;
      home_team: string;
      away_team: string;
      scheduled_at: Date | string | null;
      segment_id: number;
      candidates: unknown;
      open_markets: number;
      first_seen_at: Date | string;
      last_seen_at: Date | string;
      attempts: number;
      match_status: string;
      sport_slug: string;
      tournament_name: string;
    }>;
    return {
      misses: rows.map((r) => ({
        matchId: r.match_id,
        providerUrn: r.provider_urn,
        homeTeam: r.home_team,
        awayTeam: r.away_team,
        scheduledAt: iso(r.scheduled_at),
        segmentId: r.segment_id,
        candidates: Array.isArray(r.candidates) ? r.candidates : [],
        openMarkets: r.open_markets,
        firstSeenAt: iso(r.first_seen_at)!,
        lastSeenAt: iso(r.last_seen_at)!,
        attempts: r.attempts,
        matchStatus: r.match_status,
        sportSlug: r.sport_slug,
        tournamentName: r.tournament_name,
      })),
    };
  });

  // ── Operator void ──────────────────────────────────────────────────────

  interface VoidableMarket {
    market_id: string;
    match_id: string;
    provider_urn: string;
    provider_market_id: number;
    specifiers_json: string | null;
    market_status: number;
    match_status: string;
  }

  async function publishCancels(markets: VoidableMarket[]): Promise<void> {
    const ts = String(Date.now());
    const pipeline = app.redis.pipeline();
    for (const mk of markets) {
      pipeline.xadd(
        SETTLEMENT_STREAM,
        "MAXLEN",
        "~",
        SETTLEMENT_STREAM_MAXLEN,
        "*",
        "type",
        "cancel",
        "provider",
        "admin",
        "event_urn",
        mk.provider_urn,
        "provider_market_id",
        String(mk.provider_market_id),
        "specifiers",
        canonicalSpecifiers(mk.specifiers_json),
        "ts",
        ts,
        "outcomes",
        "",
      );
    }
    await pipeline.exec();
  }

  app.post("/admin/unsettled/markets/:marketId/void", { config: writeRateLimit }, async (request) => {
    const admin = request.requireRole("admin");
    const { marketId } = z.object({ marketId: z.coerce.number().int().positive() }).parse(request.params);
    const body = voidBody.parse(request.body ?? {});

    const [mk] = (await app.db.execute(sql`
      SELECT mk.id::text AS market_id, mk.match_id::text AS match_id, m.provider_urn, mk.provider_market_id,
             mk.specifiers_json::text AS specifiers_json, mk.status AS market_status, m.status::text AS match_status
        FROM markets mk JOIN matches m ON m.id = mk.match_id
       WHERE mk.id = ${marketId}
    `)) as unknown as VoidableMarket[];
    if (!mk) throw new NotFoundError();
    if (mk.market_status === -3 || mk.market_status === -4) {
      throw new BadRequestError("This market is already settled or cancelled", "market_already_terminal");
    }
    if (mk.match_status !== "closed" && mk.match_status !== "cancelled") {
      throw new BadRequestError("Only markets on a finished match can be voided here", "match_not_finished");
    }

    await publishCancels([mk]);
    await app.db.insert(adminAuditLog).values({
      actorUserId: admin.id,
      action: "settlement.market_void",
      targetType: "market",
      targetId: mk.market_id,
      beforeJson: { marketStatus: mk.market_status, matchId: mk.match_id, eventUrn: mk.provider_urn },
      afterJson: {
        providerMarketId: mk.provider_market_id,
        specifiers: canonicalSpecifiers(mk.specifiers_json),
        reason: body.reason,
        via: SETTLEMENT_STREAM,
      },
    });
    return { queued: 1 };
  });

  app.post("/admin/unsettled/matches/:matchId/void-open", { config: writeRateLimit }, async (request) => {
    const admin = request.requireRole("admin");
    const { matchId } = z.object({ matchId: z.coerce.number().int().positive() }).parse(request.params);
    const body = voidBody.parse(request.body ?? {});

    const markets = (await app.db.execute(sql`
      SELECT mk.id::text AS market_id, mk.match_id::text AS match_id, m.provider_urn, mk.provider_market_id,
             mk.specifiers_json::text AS specifiers_json, mk.status AS market_status, m.status::text AS match_status
        FROM markets mk JOIN matches m ON m.id = mk.match_id
       WHERE mk.match_id = ${matchId}
         AND mk.status NOT IN (-3, -4)
         AND m.status IN ('closed', 'cancelled')
       ORDER BY mk.id
    `)) as unknown as VoidableMarket[];
    if (markets.length === 0) {
      throw new BadRequestError("No open market on a finished match with that id", "nothing_to_void");
    }

    await publishCancels(markets);
    await app.db.insert(adminAuditLog).values({
      actorUserId: admin.id,
      action: "settlement.match_void_open",
      targetType: "match",
      targetId: String(matchId),
      beforeJson: { openMarkets: markets.length, eventUrn: markets[0]!.provider_urn },
      afterJson: {
        marketIds: markets.map((m) => m.market_id),
        reason: body.reason,
        via: SETTLEMENT_STREAM,
      },
    });
    return { queued: markets.length };
  });
}
