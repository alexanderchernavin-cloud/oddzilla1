-- Daily partitions for odds_history. Prefers pg_partman if available; otherwise
-- creates today's and tomorrow's partition inline and relies on a cron job
-- (set up in Phase 3) to pre-create upcoming partitions + detach old ones.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_partman') THEN
        CREATE EXTENSION IF NOT EXISTS pg_partman;

        PERFORM partman.create_parent(
            p_parent_table   => 'public.odds_history',
            p_control        => 'ts',
            p_type           => 'range',
            p_interval       => '1 day',
            p_premake        => 7
        );

        UPDATE partman.part_config
            SET retention = '90 days',
                retention_keep_table = false
            WHERE parent_table = 'public.odds_history';
    ELSE
        -- Fallback: create today's and tomorrow's partition so the table is usable.
        -- Phase 3 adds a cron-driven job that pre-creates upcoming partitions.
        PERFORM
            format(
                'CREATE TABLE IF NOT EXISTS odds_history_%s PARTITION OF odds_history FOR VALUES FROM (%L) TO (%L)',
                to_char(d, 'YYYYMMDD'),
                d,
                d + INTERVAL '1 day'
            )
        FROM generate_series(
            date_trunc('day', NOW()),
            date_trunc('day', NOW()) + INTERVAL '7 days',
            INTERVAL '1 day'
        ) AS d;
    END IF;
END
$$;

-- Default partition catches rows that fall outside all explicit ranges (should
-- never happen in normal operation; treat existence of rows here as an alarm).
CREATE TABLE IF NOT EXISTS odds_history_default PARTITION OF odds_history DEFAULT;
