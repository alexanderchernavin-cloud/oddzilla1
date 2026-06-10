-- 0081_perf_indexes.sql
--
-- Performance pass: four additive indexes for hot paths that currently
-- seq-scan or full-walk a large table. All purely additive (no drops, no
-- column changes) so the previous code version reads the schema cleanly
-- and a rollback needs nothing reverted.
--
-- Plain (non-CONCURRENT) CREATE INDEX because the migrate runner wraps
-- each file in a transaction (CONCURRENTLY can't run there). Each takes a
-- build-time SHARE lock that blocks writes to its table until the build
-- finishes — the same tradeoff every prior index migration made (e.g.
-- 0023 on the 4M-row settlements table). `make deploy` runs migrations as
-- a discrete step with a pre-deploy pg_dump, so this lands in a
-- maintenance window, not under peak live load.
--
-- Deliberately NOT dropping the indexes a companion review flagged as
-- redundant/dead (ticket_selections_market_idx superseded by #1,
-- tickets_open_idx by #3, plus settlements_event_idx /
-- community_tickets_score_settled_idx / support_threads_ai_pending_idx).
-- A wrong drop is far costlier than a few weeks of extra maintenance, so
-- those wait on a prod `pg_stat_user_indexes.idx_scan = 0` confirmation.

-- 1. ticket_selections(market_id, ticket_id)
--    The only existing market_id index is partial — `WHERE result IS NULL`
--    (0000_init.sql). Three HOT queries probe by market_id with NO
--    result-IS-NULL predicate, so the planner can't use it and seq-scans
--    the whole table (66K+ rows on a single busy match):
--      • settlement AffectedTicketsForMarket — per market settle, inside
--        the tx that holds the per-market advisory lock.
--      • settlement AffectedTicketsForMarketInWindow — every bet_cancel.
--      • RiskZilla leg_shares CTE — runs 4x per bet placement, inside the
--        tx holding the wallet row lock.
--    market_id leads (serves all three) and ticket_id second makes the
--    settlement `DISTINCT ticket_id` an index-only scan.
CREATE INDEX IF NOT EXISTS ticket_selections_market_ticket_idx
    ON ticket_selections (market_id, ticket_id);

-- 2. markets(last_oddin_ts) WHERE status = -2
--    SweepHandoverTimeouts runs every 15 s: `UPDATE markets SET status=-1
--    WHERE status=-2 AND last_oddin_ts < now()-Xs`. No existing index
--    leads with status, so it full-scans a millions-row table 4x/min,
--    forever, on the shared box. Rows sit at -2 only transiently
--    (pre-match → live handover), so this partial index stays near-empty
--    and its maintenance cost is negligible.
CREATE INDEX IF NOT EXISTS markets_handover_sweep_idx
    ON markets (last_oddin_ts)
    WHERE status = -2;

-- 3. tickets(status, placed_at DESC) WHERE status IN ('accepted','pending_delay')
--    The public /community Recent feed filters `status='accepted' AND
--    placed_at >= now()-24h`. The existing partial `tickets_open_idx`
--    carries status only, so every open ticket (weeks-out prematch bets,
--    settlement backlog) is heap-fetched and 5-table-join-expanded before
--    the 24h window drops it. Adding placed_at lets the window filter +
--    ORDER BY run off the index. Partial (open tickets only) so it stays
--    small and drops rows as they settle.
CREATE INDEX IF NOT EXISTS tickets_open_placed_idx
    ON tickets (status, placed_at DESC)
    WHERE status IN ('accepted', 'pending_delay');

-- 4. feed_messages(event_urn) WHERE match_id IS NULL AND event_urn IS NOT NULL
--    The hourly match_id backfill scans `WHERE match_id IS NULL AND
--    event_urn IS NOT NULL`. The existing feed_messages_match_ts_idx is
--    `WHERE match_id IS NOT NULL` — the exact opposite — so the backfill
--    seq-scans the full 7-day window (10^5–10^6 rows) hourly to find a
--    handful of orphans. This partial covers exactly the unresolved slice
--    and stays tiny (rows leave it the moment match_id resolves).
CREATE INDEX IF NOT EXISTS feed_messages_unresolved_idx
    ON feed_messages (event_urn)
    WHERE match_id IS NULL AND event_urn IS NOT NULL;
