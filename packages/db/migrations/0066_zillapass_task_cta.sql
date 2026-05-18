-- 0066_zillapass_task_cta.sql
--
-- ZillaPass — add a per-task call-to-action so tasks deep-link to the
-- surface where their predicate actually fires. Without this the user
-- sees "Complete your profile" / "Place 5 prematch singles" with no
-- next step and has to hunt for the page.
--
--   cta_href   — path-relative URL (starts with `/`). Intra-app
--                navigation only; admins paste full https URLs at
--                their own risk and the storefront treats anything
--                lacking a leading `/` as untrusted (rendered as plain
--                text, no anchor). Nullable: tasks without a natural
--                destination (e.g. `market_tab_changes`, which happens
--                incidentally on any match page) leave it NULL and
--                render without a CTA.
--
--   cta_label  — short button copy. Falls back to "Open" on the
--                storefront when NULL but cta_href is set. Admin can
--                tune per task so a "Complete your profile" card reads
--                "Open profile" instead of generic "Open".
--
-- Backfills the existing day-1 + day-2 tasks (migrations 0061, 0062)
-- so production users see the CTA on the next /zillapass/me hit.
-- ON CONFLICT-style backfill is unnecessary here — `slug` is unique
-- and we know exactly which rows exist; if a slug is missing (admin
-- already toggled it off and deleted, say) the UPDATE simply no-ops.

BEGIN;

ALTER TABLE zillapass_tasks
    ADD COLUMN cta_href TEXT,
    ADD COLUMN cta_label TEXT;

-- Day-1 set (migration 0061)
UPDATE zillapass_tasks
SET cta_href = '/account/community',
    cta_label = 'Open profile'
WHERE slug = 'profile-complete';

UPDATE zillapass_tasks
SET cta_href = '/upcoming',
    cta_label = 'Browse sports'
WHERE slug = 'open-5-sports';

UPDATE zillapass_tasks
SET cta_href = '/upcoming',
    cta_label = 'Browse matches'
WHERE slug = 'open-5-matches-different-sports';

-- Day-2 set (migration 0062). `market_tab_changes` is incidental — it
-- fires on any match page and pointing it at a specific match would
-- be arbitrary, so it stays NULL.
UPDATE zillapass_tasks
SET cta_href = '/upcoming',
    cta_label = 'Pick a match'
WHERE slug = 'place-5-prematch-bets';

UPDATE zillapass_tasks
SET cta_href = '/live',
    cta_label = 'Watch live'
WHERE slug = 'place-5-live-bets';

COMMIT;
