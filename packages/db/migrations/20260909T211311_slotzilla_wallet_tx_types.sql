-- SlotZilla: the three wallet ledger types the game writes.
--
--   slot_stake   the stake debited when a spin is accepted (api)
--   slot_payout  the payout credited when a spin settles as won (slotzilla)
--   slot_refund  the stake returned when a spin is voided (slotzilla)
--
-- Every row carries ref_type = 'slotzilla_spin' and ref_id = the spin's
-- uuid, so the existing wallet_ledger_unique_ref partial index makes a
-- replayed settlement a no-op — the same apply-once discipline tickets
-- have (invariant 4).
--
-- Its own file on purpose: Postgres forbids REFERENCING a new enum value
-- in the transaction that added it, and the migration runner wraps each
-- file in one transaction (same reason 0087 is split from 0088 and 0096
-- from 0097). The tables follow in 20260909T211312_slotzilla.sql.

ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'slot_stake';
ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'slot_payout';
ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'slot_refund';
