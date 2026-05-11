// /admin/tickets endpoints. Two surfaces:
//
//   - GET  /admin/tickets        rich-filter ticket listing powering
//                                the backoffice "All bets" page. Covers
//                                every ticket regardless of currency
//                                (USDC + OZ) or RiskZilla path
//                                (engine-evaluated USDC tickets and
//                                engine-bypassed OZ tickets both show).
//   - POST /admin/tickets/:id/void  manual void (cancel + refund).
//                                Transitions an accepted ticket to
//                                `voided` and issues a full refund.
//                                Audit-logged. Gated by the
//                                balance-edit admin allowlist.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  tickets,
  wallets,
  walletLedger,
  adminAuditLog,
} from "@oddzilla/db";
import { SUPPORTED_CURRENCIES } from "@oddzilla/types/currencies";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../lib/errors.js";
import { requireBalanceEditAdmin } from "../../lib/balance-edit-gate.js";

const voidBody = z.object({
  reason: z.string().min(3).max(500),
});

const currencySchema = z
  .string()
  .transform((s) => s.toUpperCase())
  .pipe(z.enum(SUPPORTED_CURRENCIES));

// Whitelist of sortable columns. Each maps to a SQL expression evaluated
// on the `tickets t` row — keeping sorts to ticket-level columns means
// we never have to join just to ORDER BY (the first-leg join is for
// row metadata only).
const SORT_COLUMNS = {
  placedAt: sql`t.placed_at`,
  stake: sql`t.stake_micro`,
  potentialPayout: sql`t.potential_payout_micro`,
  actualPayout: sql`t.actual_payout_micro`,
  status: sql`t.status`,
  betType: sql`t.bet_type`,
  settledAt: sql`t.settled_at`,
} as const;
type SortKey = keyof typeof SORT_COLUMNS;

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  // Page-based pagination. Page 1 = OFFSET 0. The frontend uses this
  // instead of cursor pagination so the same page-N URL renders the
  // same content regardless of which sort the operator picked.
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  sortBy: z.enum(Object.keys(SORT_COLUMNS) as [SortKey, ...SortKey[]]).default("placedAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  status: z
    .enum(["pending_delay", "accepted", "rejected", "settled", "voided"])
    .optional(),
  // For settled tickets, narrow further by outcome: won | lost | void.
  // Doesn't apply to accepted / pending_delay / voided.
  outcome: z.enum(["won", "lost", "void"]).optional(),
  currency: currencySchema.optional(),
  betType: z.enum(["single", "combo", "betbuilder", "tiple", "tippot"]).optional(),
  userId: z.string().uuid().optional(),
  // Free-text search across user email/nickname. Case-insensitive,
  // applied as ILIKE %q% with SQL wildcards stripped.
  userQuery: z.string().min(1).max(200).optional(),
  sportId: z.coerce.number().int().optional(),
  matchId: z.coerce.bigint().optional(),
  fromTs: z.coerce.date().optional(),
  toTs: z.coerce.date().optional(),
  minStakeMicro: z.string().regex(/^\d+$/).optional(),
  maxStakeMicro: z.string().regex(/^\d+$/).optional(),
});

interface TicketSelectionDto {
  marketId: string;
  providerMarketId: number;
  marketName: string;
  outcomeId: string;
  outcomeName: string | null;
  oddsAtPlacement: string;
  matchId: string | null;
  matchLabel: string | null;
  result: string | null;
}

interface TicketRowDto {
  id: string;
  cursor: string;
  userId: string;
  userEmail: string | null;
  userNickname: string | null;
  status: string;
  outcome: "won" | "lost" | "void" | null;
  currency: string;
  betType: string;
  legCount: number;
  stakeMicro: string;
  potentialPayoutMicro: string;
  actualPayoutMicro: string | null;
  rejectReason: string | null;
  // First-leg metadata — useful for compact list display.
  matchId: string | null;
  matchLabel: string | null;
  matchScheduledAt: string | null;
  sportId: number | null;
  sportSlug: string | null;
  tournamentId: number | null;
  tournamentName: string | null;
  riskTier: number | null;
  // Full per-leg selection list (in placement order). For singles this
  // is a one-element array; for combos / betbuilder / tiple / tippot
  // it's the full ladder.
  selections: TicketSelectionDto[];
  placedAt: string;
  settledAt: string | null;
}

const USER_CHANNEL_PREFIX = "user:";

export default async function adminTicketsRoutes(app: FastifyInstance) {
  // Rich-filter listing powering the backoffice "All bets" page.
  // Returns every ticket regardless of currency or RiskZilla path —
  // OZ tickets bypass the engine, but they all show here.
  app.get("/admin/tickets", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);

    const conditions: ReturnType<typeof sql>[] = [];
    if (q.status) conditions.push(sql`t.status = ${q.status}::ticket_status`);
    if (q.currency) conditions.push(sql`t.currency = ${q.currency}`);
    if (q.betType) conditions.push(sql`t.bet_type = ${q.betType}::bet_type`);
    if (q.userId) conditions.push(sql`t.user_id = ${q.userId}::uuid`);
    if (q.fromTs)
      conditions.push(sql`t.placed_at >= ${q.fromTs.toISOString()}::timestamptz`);
    if (q.toTs)
      conditions.push(sql`t.placed_at <= ${q.toTs.toISOString()}::timestamptz`);
    if (q.minStakeMicro)
      conditions.push(sql`t.stake_micro >= ${q.minStakeMicro}::bigint`);
    if (q.maxStakeMicro)
      conditions.push(sql`t.stake_micro <= ${q.maxStakeMicro}::bigint`);

    // Outcome only meaningful for settled tickets. For voided →
    // outcome="void" is a synonym for status=voided (we still surface
    // it as a column on the row).
    if (q.outcome === "won") {
      conditions.push(
        sql`t.status = 'settled' AND t.actual_payout_micro > t.stake_micro`,
      );
    } else if (q.outcome === "lost") {
      conditions.push(
        sql`t.status = 'settled' AND COALESCE(t.actual_payout_micro, 0) = 0`,
      );
    } else if (q.outcome === "void") {
      conditions.push(
        sql`(t.status = 'voided' OR (t.status = 'settled' AND t.actual_payout_micro = t.stake_micro))`,
      );
    }

    // User-text search joins users (email + nickname). We strip the
    // ILIKE wildcards to keep the query plan predictable; the trailing
    // %…% is added back here.
    let userJoinHasText = false;
    if (q.userQuery) {
      const needle = `%${q.userQuery.replace(/[%_]/g, "")}%`;
      conditions.push(
        sql`(u.email ILIKE ${needle} OR u.nickname ILIKE ${needle})`,
      );
      userJoinHasText = true;
    }

    // Sport / match filter via EXISTS — "any leg of the ticket touches
    // this sport/match". This keeps all filtering in the inner WHERE so
    // the COUNT(*) for the pagination total reflects exactly the row
    // set the list returns, with no post-join filtering surprises.
    if (q.sportId !== undefined) {
      conditions.push(sql`EXISTS (
        SELECT 1
          FROM ticket_selections ts
          JOIN markets    smk ON smk.id = ts.market_id
          JOIN matches    sm  ON sm.id  = smk.match_id
          JOIN tournaments stn ON stn.id = sm.tournament_id
          JOIN categories sc  ON sc.id = stn.category_id
         WHERE ts.ticket_id = t.id AND sc.sport_id = ${q.sportId}
      )`);
    }
    if (q.matchId !== undefined) {
      conditions.push(sql`EXISTS (
        SELECT 1
          FROM ticket_selections ts
          JOIN markets mmk ON mmk.id = ts.market_id
         WHERE ts.ticket_id = t.id AND mmk.match_id = ${q.matchId.toString()}::bigint
      )`);
    }

    const innerWhere =
      conditions.length === 0
        ? sql``
        : sql`WHERE ${conditions.reduce((acc, c, i) =>
            i === 0 ? c : sql`${acc} AND ${c}`,
          )}`;

    // ORDER BY clause from the whitelisted sort column. Ties always
    // resolved by id DESC for deterministic pagination across pages.
    const sortColumn = SORT_COLUMNS[q.sortBy];
    const sortClause =
      q.sortDir === "asc"
        ? sql`${sortColumn} ASC NULLS LAST, t.id ASC`
        : sql`${sortColumn} DESC NULLS LAST, t.id DESC`;
    const offset = (q.page - 1) * q.limit;

    // Total count uses the same WHERE on the same `tickets t` source.
    // The user-search join is only present when q.userQuery is set, so
    // we mirror that conditionally. Run in parallel with the row query.
    const totalPromise = app.db.execute(sql`
      SELECT COUNT(*)::bigint AS total
        FROM tickets t
        ${userJoinHasText ? sql`LEFT JOIN users u ON u.id = t.user_id` : sql``}
        ${innerWhere}
    `) as unknown as Promise<Array<{ total: string }>>;
    const rowsPromise = app.db.execute(sql`
      WITH filtered AS (
        SELECT t.*
          FROM tickets t
          ${userJoinHasText ? sql`LEFT JOIN users u ON u.id = t.user_id` : sql``}
          ${innerWhere}
          ORDER BY ${sortClause}
          LIMIT ${q.limit}
          OFFSET ${offset}
      )
      SELECT
        t.id::text                                    AS id,
        EXTRACT(epoch FROM t.placed_at) * 1000        AS cursor_ms,
        t.user_id::text                               AS user_id,
        u.email                                       AS user_email,
        u.nickname                                    AS user_nickname,
        t.status::text                                AS status,
        t.currency                                    AS currency,
        t.bet_type::text                              AS bet_type,
        (SELECT COUNT(*)::int FROM ticket_selections ts WHERE ts.ticket_id = t.id) AS leg_count,
        t.stake_micro::text                           AS stake_micro,
        t.potential_payout_micro::text                AS potential_payout_micro,
        t.actual_payout_micro::text                   AS actual_payout_micro,
        t.reject_reason                               AS reject_reason,
        m.id::text                                    AS match_id,
        CASE WHEN m.id IS NOT NULL
             THEN m.home_team || ' vs ' || m.away_team
             ELSE NULL END                            AS match_label,
        m.scheduled_at                                AS match_scheduled_at,
        s.id                                          AS sport_id,
        s.slug                                        AS sport_slug,
        tn.id                                         AS tournament_id,
        tn.name                                       AS tournament_name,
        tn.risk_tier                                  AS risk_tier,
        -- Per-leg selection list as a JSON array. Aggregated via a
        -- LATERAL subquery so the per-ticket join cardinality stays
        -- at 1 and the ORDER BY / LIMIT on the outer query is stable.
        COALESCE(sel.selections, '[]'::jsonb)         AS selections,
        t.placed_at                                   AS placed_at,
        t.settled_at                                  AS settled_at
      FROM filtered t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN LATERAL (
        SELECT ts.market_id
          FROM ticket_selections ts
         WHERE ts.ticket_id = t.id
         ORDER BY ts.id ASC
         LIMIT 1
      ) first_leg ON true
      LEFT JOIN markets    mk ON mk.id = first_leg.market_id
      LEFT JOIN matches    m  ON m.id  = mk.match_id
      LEFT JOIN tournaments tn ON tn.id = m.tournament_id
      LEFT JOIN categories c  ON c.id = tn.category_id
      LEFT JOIN sports     s  ON s.id = c.sport_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'marketId',         lmk.id::text,
            'providerMarketId', lmk.provider_market_id,
            'marketName',       COALESCE(
              (SELECT md.name_template
                 FROM market_descriptions md
                WHERE md.provider_market_id = lmk.provider_market_id
                ORDER BY (md.variant = '') DESC, md.variant
                LIMIT 1),
              'Market #' || lmk.provider_market_id
            ),
            'outcomeId',         ts.outcome_id,
            'outcomeName',       mo.name,
            'oddsAtPlacement',   ts.odds_at_placement::text,
            'matchId',           lmk.match_id::text,
            'matchLabel',        CASE WHEN lm.id IS NOT NULL
                                       THEN lm.home_team || ' vs ' || lm.away_team
                                       ELSE NULL END,
            'result',            ts.result::text
          )
          ORDER BY ts.id ASC
        ) AS selections
        FROM ticket_selections ts
        JOIN markets        lmk ON lmk.id = ts.market_id
        LEFT JOIN matches   lm  ON lm.id  = lmk.match_id
        LEFT JOIN market_outcomes mo ON mo.market_id = ts.market_id AND mo.outcome_id = ts.outcome_id
        WHERE ts.ticket_id = t.id
      ) sel ON true
      ORDER BY ${sortClause}
    `) as unknown as Promise<Array<{
      id: string;
      cursor_ms: string | number;
      user_id: string;
      user_email: string | null;
      user_nickname: string | null;
      status: string;
      currency: string;
      bet_type: string;
      leg_count: number;
      stake_micro: string;
      potential_payout_micro: string;
      actual_payout_micro: string | null;
      reject_reason: string | null;
      match_id: string | null;
      match_label: string | null;
      match_scheduled_at: Date | string | null;
      sport_id: number | null;
      sport_slug: string | null;
      tournament_id: number | null;
      tournament_name: string | null;
      risk_tier: number | null;
      selections: TicketSelectionDto[] | null;
      placed_at: Date | string;
      settled_at: Date | string | null;
    }>>;

    const [rows, totalRows] = await Promise.all([rowsPromise, totalPromise]);
    const total = Number(totalRows[0]?.total ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / q.limit));

    const entries: TicketRowDto[] = rows.map((r) => {
      const cursorMs = Math.floor(Number(r.cursor_ms));
      // Derive outcome from status + payout for settled tickets so
      // the UI can colour the row without re-doing the math.
      let outcome: "won" | "lost" | "void" | null = null;
      if (r.status === "settled") {
        const stake = BigInt(r.stake_micro);
        const payout = BigInt(r.actual_payout_micro ?? "0");
        if (payout > stake) outcome = "won";
        else if (payout === stake) outcome = "void"; // full refund
        else outcome = "lost";
      } else if (r.status === "voided") {
        outcome = "void";
      }
      return {
        id: r.id,
        cursor: `${cursorMs}_${r.id}`,
        userId: r.user_id,
        userEmail: r.user_email,
        userNickname: r.user_nickname,
        status: r.status,
        outcome,
        currency: r.currency.trim(),
        betType: r.bet_type,
        legCount: r.leg_count,
        stakeMicro: r.stake_micro,
        potentialPayoutMicro: r.potential_payout_micro,
        actualPayoutMicro: r.actual_payout_micro,
        rejectReason: r.reject_reason,
        matchId: r.match_id,
        matchLabel: r.match_label,
        matchScheduledAt:
          r.match_scheduled_at == null
            ? null
            : r.match_scheduled_at instanceof Date
              ? r.match_scheduled_at.toISOString()
              : String(r.match_scheduled_at),
        sportId: r.sport_id,
        sportSlug: r.sport_slug,
        tournamentId: r.tournament_id,
        tournamentName: r.tournament_name,
        riskTier: r.risk_tier,
        selections: Array.isArray(r.selections) ? r.selections : [],
        placedAt:
          r.placed_at instanceof Date
            ? r.placed_at.toISOString()
            : String(r.placed_at),
        settledAt:
          r.settled_at == null
            ? null
            : r.settled_at instanceof Date
              ? r.settled_at.toISOString()
              : String(r.settled_at),
      };
    });

    return {
      entries,
      total,
      page: q.page,
      pageSize: q.limit,
      totalPages,
      sortBy: q.sortBy,
      sortDir: q.sortDir,
    };
  });

  // Manual void refunds the stake — gate to the balance-edit operator
  // allowlist (see lib/balance-edit-gate.ts).
  app.post("/admin/tickets/:id/void", async (request) => {
    const admin = await requireBalanceEditAdmin(app, request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = voidBody.parse(request.body);

    // Read ticket + status check + status-guarded UPDATE all happen
    // inside ONE transaction with FOR UPDATE on the row, so settlement
    // can't slip a payout in between our read and our write. Without
    // this, an admin clicking Void on an actively-settling ticket can
    // corrupt locked_micro (negative locked → inflated available) and
    // double-credit the ledger (bet_payout from settlement + bet_refund
    // from the void are distinct rows under the unique partial index).
    const userIdForPublish = await app.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(tickets)
        .where(eq(tickets.id, params.id))
        .for("update")
        .limit(1);
      if (!existing) throw new NotFoundError("ticket_not_found", "ticket_not_found");

      // Only `accepted` tickets can be manually voided. Settled tickets go
      // through rollback (handled by the settlement worker); rejected +
      // pending_delay are already out of the live set.
      if (existing.status !== "accepted") {
        throw new BadRequestError(
          `cannot_void_status_${existing.status}`,
          `cannot_void_status_${existing.status}`,
        );
      }

      const stakeMicro = existing.stakeMicro;
      const ticketCurrency = existing.currency;

      // Flip to voided with a full refund. Status guard on the WHERE is
      // redundant given FOR UPDATE above, but cheap defense-in-depth —
      // RETURNING.length catches any future drift where the lock is
      // dropped.
      const updated = await tx
        .update(tickets)
        .set({
          status: "voided",
          actualPayoutMicro: stakeMicro,
          settledAt: new Date(),
          rejectReason: body.reason,
        })
        .where(and(eq(tickets.id, params.id), eq(tickets.status, "accepted")))
        .returning({ id: tickets.id });
      if (updated.length !== 1) {
        throw new ConflictError("ticket_status_changed", "ticket_status_changed");
      }

      // Release the lock + credit back the full stake on the ticket's
      // currency wallet.
      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} - ${stakeMicro}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(wallets.userId, existing.userId),
            eq(wallets.currency, ticketCurrency),
          ),
        );

      // Ledger: bet_refund row (unique on (type, ref_type, ref_id) so
      // replay is safe).
      await tx.insert(walletLedger).values({
        userId: existing.userId,
        currency: ticketCurrency,
        deltaMicro: stakeMicro,
        type: "bet_refund",
        refType: "ticket",
        refId: params.id,
        memo: `admin_void:${body.reason}`,
      }).onConflictDoNothing();

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "ticket.void",
        targetType: "ticket",
        targetId: params.id,
        beforeJson: {
          status: existing.status,
          stakeMicro: existing.stakeMicro.toString(),
        },
        afterJson: {
          status: "voided",
          reason: body.reason,
          refundMicro: stakeMicro.toString(),
        },
        ipInet: request.ip ?? null,
      });

      return existing.userId;
    });

    // Notify the user via ws-gateway user channel.
    try {
      await app.redis.publish(
        USER_CHANNEL_PREFIX + userIdForPublish,
        JSON.stringify({
          type: "ticket",
          ticketId: params.id,
          status: "voided",
          rejectReason: body.reason,
        }),
      );
    } catch {
      // best-effort
    }

    return { ok: true, ticketId: params.id, status: "voided" };
  });
}
