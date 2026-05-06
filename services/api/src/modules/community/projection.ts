// Shared upsert for the community_tickets projection.
//
// The Go settlement service writes the same row inside its SettleTicket
// transaction (services/settlement/internal/store/store.go ::
// WriteCommunityProjection). The two implementations MUST keep their
// SQL in sync — both rely on the `(ticket_id) UNIQUE` constraint with
// ON CONFLICT DO UPDATE so any of these paths can run idempotently:
//
//   - Go: bet_settlement → maybeSettleTicket → SettleTicket
//   - Go: bet_cancel / rollback_bet_settlement → ReverseSettledTicket
//   - TS: cashout accept (this module is called inside the cashout tx)
//   - TS: POST /admin/community/backfill (sweeps any miss in bulk)
//
// Failure semantics: callers wrap this in their own transaction and
// decide whether a projection error is fatal or best-effort. Cashout
// treats it as best-effort (the ticket payout is the source of truth
// and backfill recovers any miss). Admin backfill surfaces errors.

import { sql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";

// Structural type that accepts both the request-scoped Drizzle client
// and a transaction handle — both expose `.execute()`. Used here so
// cashout can pass its `tx` to participate in the same transaction
// while the admin backfill passes the parent `db`.
export type CommunityProjectionExecutor = Pick<DbClient, "execute">;

// The query is parameterised on the array of ticket UUIDs to upsert,
// which lets the same SQL drive the per-ticket cashout path AND the
// bulk admin backfill path. Aliased table names match the Go side
// (services/settlement/internal/store/store.go ::
// WriteCommunityProjection) so the two queries are easy to diff during
// ongoing maintenance.
export async function writeCommunityProjection(
  db: CommunityProjectionExecutor,
  ticketIds: readonly string[],
): Promise<number> {
  if (ticketIds.length === 0) return 0;

  const result = await db.execute<Record<string, unknown>>(sql`
WITH legs AS (
  SELECT
    t.id           AS ticket_id,
    t.user_id      AS user_id,
    t.currency     AS currency,
    t.status       AS status,
    t.bet_type     AS bet_type,
    t.stake_micro  AS stake_micro,
    COALESCE(t.actual_payout_micro, 0) AS payout_micro,
    t.settled_at   AS settled_at,
    COUNT(*)::int                                                AS num_legs,
    COALESCE(
      ARRAY_AGG(DISTINCT c.sport_id) FILTER (WHERE c.sport_id IS NOT NULL),
      '{}'::int[]
    )                                                            AS sport_ids,
    EXP(SUM(LN(ts2.odds_at_placement::float8)))::numeric(10, 4)  AS total_odds
    FROM tickets t
    JOIN ticket_selections ts2 ON ts2.ticket_id = t.id
    JOIN markets mk            ON mk.id = ts2.market_id
    JOIN matches mt            ON mt.id = mk.match_id
    JOIN tournaments tn        ON tn.id = mt.tournament_id
    JOIN categories c          ON c.id = tn.category_id
   WHERE t.id = ANY(${ticketIds}::uuid[])
   GROUP BY t.id
)
INSERT INTO community_tickets (
  ticket_id, user_id, currency, status, bet_type,
  stake_micro, payout_micro, total_odds, num_legs, sport_ids, settled_at, score
)
SELECT
  l.ticket_id, l.user_id, l.currency, l.status, l.bet_type,
  l.stake_micro, l.payout_micro, l.total_odds, l.num_legs, l.sport_ids,
  COALESCE(l.settled_at, NOW()),
  -- Phase 10.3 deterministic score, frozen at settlement time.
  -- Components and weights mirror docs/COMMUNITY_PLAN.md:
  --   Inspiration 25  log10(payout/stake) capped at 1, only on wins
  --   Odds        15  log10(total_odds) / log10(20), capped at 1
  --   Reputation  15  prior_wins / max(prior, 1), 0 if user has no
  --                   prior settled tickets in this currency
  --   Copyability 15  reserved (Phase 10.4); 0 today
  --   Recency     30  applied at QUERY time (the feed's Best Wins
  --                   path filters to the last 7 days), so the stored
  --                   score stays time-invariant and the existing
  --                   (score DESC, settled_at DESC) index powers
  --                   ranking without a cron recompute.
  COALESCE((
    SELECT
      (CASE WHEN l.payout_micro > l.stake_micro THEN
              25 * LEAST(1.0, LN(l.payout_micro::float8 / l.stake_micro::float8) / LN(10))
            ELSE 0
       END)
    + 15 * LEAST(1.0, LN(GREATEST(l.total_odds::float8, 1.0001)) / LN(20))
    + 15 * COALESCE(
        (SELECT (COUNT(*) FILTER (WHERE prior.payout_micro > prior.stake_micro))::float8
              / NULLIF(COUNT(*), 0)
           FROM community_tickets prior
          WHERE prior.user_id  = l.user_id
            AND prior.currency = l.currency
            AND prior.settled_at < COALESCE(l.settled_at, NOW())
            AND prior.status::text IN ('settled', 'cashed_out')),
        0
      )
  ), 0)
  FROM legs l
ON CONFLICT (ticket_id) DO UPDATE
   SET status       = EXCLUDED.status,
       payout_micro = EXCLUDED.payout_micro,
       settled_at   = EXCLUDED.settled_at,
       score        = EXCLUDED.score
RETURNING ticket_id
`);

  // RETURNING gives us one row per actual upsert (insert + conflict-update
  // alike). postgres-js exposes the row list as array-like via Drizzle's
  // execute() wrapper.
  return result.length;
}
