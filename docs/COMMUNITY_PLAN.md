# Community Features — Phase 10 plan

Owner: Alex Cartier (@Arak00)
Status: Proposed — open for review
Target: after pre-launch exit gates land, before phase-9 cashout extensions

This plan defines a four-stage path to a usable Community surface inside
Oddzilla — public profiles, a feed of recently-settled tickets,
copy-to-bet, achievements, and AI seed bettors. It is shaped end-to-end
to the existing stack: Drizzle schema, Fastify modules, Go settlement
service, multi-currency `BIGINT _micro` money, apply-once settlement,
and the `services/api` + `services/settlement` split.

This plan was originally drafted against a sister scaffold; that work
is reference only. The schema, module placement, money types, and
settlement write path below are all rewritten for the production
oddzilla1 stack.

---

## Why this scope

Oddzilla already ships every primitive Community needs:

- A real ticket lifecycle with apply-once settlement and a stable
  `tickets.settled_at` timestamp.
- Multi-currency wallets — USDT (real, on-chain) and OZ (demo, every
  signup gets 1000 OZ). The community feed surfaces peer betting proof
  in either currency, with the currency labelled on each card.
- A WebSocket gateway (`services/ws-gateway`) with a per-user channel
  (`user:{userId}`) that already carries ticket frames. Adding a
  community fan-out channel is a one-line PUBLISH.
- Locked invariants on money (`_micro`, `(user_id, currency)` scoping)
  and on settlement (apply-once 5-tuple, ledger unique partial index).
  Community projection rows must respect both.

The V1 scope deliberately drops the **social graph** (follow, People
tab, follower counts). Discovery is achievement-driven and feed-driven.
Reason: the social-graph surface costs more in moderation and abuse
vectors than it returns in retention before there is meaningful
network density. Achievements + chronological feed + per-handle
profile pages are sufficient to bootstrap.

---

## Decisions locked

| # | Decision | Rationale |
|---|---|---|
| D1 | `users.tickets_public` defaults to `true` on signup | Maximizes feed density from day one. Toggle is a one-click opt-out in `/account/community`. |
| D2 | `users.is_ai` flag in DB, never serialised by any API endpoint | Transparency-on-request for regulators / future audit, but seed bettors must read as normal users in feed. |
| D3 | Real-money leaderboards (USDT) are in scope | The OZ demo currency is also surfaced in the feed but with a clear `OZ` label per card. |
| D4 (proposed) | Feed shows USDT and OZ tickets together with currency badges; profile stats are computed **per currency** | OZ-only-bettors won't have a healthy USDT win-rate yet; segregating stats by currency keeps "real" leaderboards honest. The default profile view is USDT; a tab toggle shows OZ stats. The feed defaults to "All" with `USDT` / `OZ` filter pills. |

Awaiting sign-off on D4. D1–D3 carry over from the prior plan review.

---

## V1 surface (Phase 10.1–10.4)

1. **Public profile** — `/u/[nickname]`: handle, bio, joined date, win
   rate, ROI, badge count, last 10 settled tickets. Stats scoped per
   currency.
2. **Community feed** — `/community`: chronological + Best Wins tabs,
   sport filter, currency filter, last 7 days, Copy this bet button.
3. **Visibility settings** — `/account/community`: tickets-public toggle,
   nickname, bio.
4. **Achievements** — five starter badges, settlement-driven, idempotent
   unlock writes. (Phase 10.4.)
5. **AI seed bettors** — internal accounts with `users.is_ai = true`
   placing bets through the existing bets API. Drives early-day feed
   density. (Phase 10.4.)

Out of V1: comments, reactions, follow, chat, stories, video clips.
Revisit when feed engagement justifies the moderation cost.

---

## Schema additions

### Phase 10.1 — migration `0024_community_profiles.sql`

```sql
-- Community-side user fields. Defaults are chosen so existing rows get
-- the desired behaviour with no backfill. citext makes nickname
-- case-insensitive-unique without a separate lower() index.
ALTER TABLE users ADD COLUMN tickets_public BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN nickname citext UNIQUE;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN is_ai BOOLEAN NOT NULL DEFAULT FALSE;

-- Nickname format: 3-20 chars, [A-Za-z0-9_]. Validated again at the
-- API layer (zod), but the DB-level check stops bypasses.
ALTER TABLE users ADD CONSTRAINT users_nickname_format
  CHECK (nickname IS NULL OR nickname ~ '^[A-Za-z0-9_]{3,20}$');

-- Bio length cap (DB-level guard mirroring the zod cap at the API).
ALTER TABLE users ADD CONSTRAINT users_bio_length
  CHECK (bio IS NULL OR length(bio) <= 280);
```

Drizzle schema: extend `packages/db/src/schema/users.ts` with the four
new columns; the citext customType is already declared above the
existing `email` column.

> No new value added to `userRoleEnum`. Seed accounts stay
> `role='user'` and are flagged solely by `is_ai`. This avoids an
> `ALTER TYPE ... ADD VALUE` migration and keeps the role surface small.

### Phase 10.2 — migration `0025_community_tickets.sql`

```sql
-- Read-projection of settled tickets. Written from
-- services/settlement/internal/store/store.go inside the same
-- transaction as SettleTicket / ReverseSettledTicket.
--
-- Currency is denormalised so the feed can filter by it without a
-- join. The unique on ticket_id makes the write idempotent under
-- replay; a re-settle after rollback updates the same row in place.
CREATE TABLE community_tickets (
  id              BIGSERIAL    PRIMARY KEY,
  ticket_id       UUID         NOT NULL UNIQUE
                  REFERENCES tickets(id) ON DELETE CASCADE,
  user_id         UUID         NOT NULL
                  REFERENCES users(id) ON DELETE CASCADE,
  currency        CHAR(4)      NOT NULL,
  status          ticket_status NOT NULL,
  bet_type        bet_type      NOT NULL,
  stake_micro     BIGINT       NOT NULL,
  payout_micro    BIGINT       NOT NULL,
  total_odds      NUMERIC(10, 4) NOT NULL,
  num_legs        INT          NOT NULL,
  sport_ids       BIGINT[]     NOT NULL,
  settled_at      TIMESTAMPTZ  NOT NULL,
  score           DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT community_tickets_stake_pos    CHECK (stake_micro > 0),
  CONSTRAINT community_tickets_payout_nonneg CHECK (payout_micro >= 0)
);

CREATE INDEX community_tickets_settled_idx
  ON community_tickets (settled_at DESC);
CREATE INDEX community_tickets_score_settled_idx
  ON community_tickets (score DESC, settled_at DESC);
CREATE INDEX community_tickets_user_settled_idx
  ON community_tickets (user_id, settled_at DESC);
CREATE INDEX community_tickets_currency_settled_idx
  ON community_tickets (currency, settled_at DESC);
```

Drizzle schema lives in `packages/db/src/schema/community.ts`; index
exported from `packages/db/src/schema/index.ts`.

### Phase 10.4 — achievements (deferred design)

Achievement definitions + unlock log will land as their own migration
when 10.4 starts. Schema sketch:

```sql
CREATE TABLE achievement_definitions (
  id          TEXT PRIMARY KEY,            -- 'first_win', 'five_leg_combo', etc.
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  icon        TEXT NOT NULL                 -- lucide icon slug
);

CREATE TABLE user_achievements (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL REFERENCES achievement_definitions(id),
  unlocked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, achievement_id)
);
```

Idempotent on the composite PK. Unlock check runs at the same site as
the projection write (Go settlement) — the same transaction that flips
`tickets.status='settled'` evaluates each badge predicate and inserts
the unlock row.

---

## Settlement integration — the projection write hook

The settlement service is the only writer of `community_tickets`. The
hook lives next to `SettleTicket` in
[`services/settlement/internal/store/store.go`](../services/settlement/internal/store/store.go),
called by `services/settlement/internal/settler/settler.go` immediately
after the existing wallet/ledger writes — inside the same transaction.

Sketch:

```go
// WriteCommunityProjection upserts a community_tickets row for the
// settled ticket. Idempotent on ticket_id @unique. sport_ids is
// computed by joining ticket_selections → markets → matches →
// tournaments → categories → sports and deduping. Called from
// settler.maybeSettleTicket after SettleTicket.
//
// Failure must NOT unwind the settlement transaction — log + continue.
// The dedicated backfill admin endpoint can repair any miss.
func WriteCommunityProjection(ctx context.Context, tx pgx.Tx,
    ticketID string, payoutMicro int64) error {
    const q = `
WITH ts AS (
  SELECT t.id, t.user_id, t.currency, t.status, t.bet_type,
         t.stake_micro, ts2.odds_total, t.settled_at,
         COUNT(*)::int AS num_legs,
         ARRAY_AGG(DISTINCT c.sport_id) FILTER (WHERE c.sport_id IS NOT NULL) AS sport_ids
    FROM tickets t
    JOIN ticket_selections ts2 ON ts2.ticket_id = t.id
    JOIN markets mk            ON mk.id = ts2.market_id
    JOIN matches mt            ON mt.id = mk.match_id
    JOIN tournaments tn        ON tn.id = mt.tournament_id
    JOIN categories c          ON c.id = tn.category_id
   WHERE t.id = $1
   GROUP BY t.id
)
INSERT INTO community_tickets
  (ticket_id, user_id, currency, status, bet_type,
   stake_micro, payout_micro, total_odds, num_legs, sport_ids, settled_at)
SELECT id, user_id, currency, status, bet_type,
       stake_micro, $2, /* odds product over selections */, num_legs, sport_ids, settled_at
  FROM ts
ON CONFLICT (ticket_id) DO UPDATE
  SET status = EXCLUDED.status,
      payout_micro = EXCLUDED.payout_micro,
      settled_at = EXCLUDED.settled_at
`
    _, err := tx.Exec(ctx, q, ticketID, payoutMicro)
    return err
}
```

Why inside the settlement transaction:

- The `ON CONFLICT DO UPDATE` is the natural idempotency story under
  re-settles. The same `ticket_id` keeps one row across settle →
  rollback → re-settle generations.
- A separate notify+listen worker would buy us nothing — the projection
  is computable from data already locked in the same tx.
- Failure handling: wrap in defer / log-only path so a projection bug
  doesn't unwind a real settlement. The admin
  `POST /admin/community/backfill` endpoint (see §API) recovers any
  miss.

`ReverseSettledTicket` similarly updates the projection row's `status`
and clears `payout_micro` back to 0 to keep `community_tickets`
consistent with the source-of-truth `tickets` table.

---

## API surface

New Fastify module at `services/api/src/modules/community/`:

```
GET    /community/feed?sort=recent|best&sportId=&currency=USDT|OZ&page=&pageSize=
GET    /community/users/:nickname/profile?currency=USDT|OZ
GET    /community/users/:nickname/tickets?currency=USDT|OZ&page=&pageSize=
GET    /community/me                                                   (auth)
PATCH  /community/me/visibility   body: { ticketsPublic: boolean }     (auth)
PATCH  /community/me/profile      body: { nickname?, bio? }            (auth)
POST   /community/copy/:communityTicketId                              (auth)
       → returns prefilled bet-slip selections (Phase 10.3)
POST   /admin/community/backfill                                       (admin)
       → retroactively projects any settled ticket missing a
         community_tickets row (idempotent)
```

Locked DTO field names go in `packages/types/src/community.ts`.
Money is serialised as decimal strings (matching the rest of the
codebase — `bigint → string`), never as numbers. The `is_ai` field is
filtered out of every API response; there is no query parameter that
exposes it.

The feed query honours both filters via composite where clause; default
sort is `recent` in 10.2, `best` lands in 10.3.

### Visibility filter

`getFeed` excludes:

- Users with `tickets_public = false`
- Users with `nickname IS NULL` (their card has nowhere to link to)

Per-currency stats on the profile page query
`community_tickets WHERE user_id = ? AND currency = ?` and aggregate.

---

## Web

New routes under the `(main)` route group:

```
apps/web/src/app/(main)/
  community/
    page.tsx                      # feed (Recent + Best Wins tabs, sport + currency filters)
  u/
    [nickname]/page.tsx           # public profile
  account/
    community/page.tsx            # visibility, nickname, bio
```

Server-rendered with `force-dynamic`. Components in
`apps/web/src/components/community/`. The Community link enters the
left sidebar in `services/api`-backed nav order, after the existing
sport list.

The Copy this bet button (Phase 10.3) reuses the existing bet-slip
store (`apps/web/src/lib/bet-slip.tsx`); the existing
`POST /bets` validation handles drift, market-open status, and combo
restrictions, so no new validation logic is needed on the placement
side.

No emojis anywhere — UI text, log lines, commit messages. Per the
locked invariant.

---

## Phasing

Following the existing PHASES.md numbering. Phase 10 substages, each
~1 working week.

### Phase 10.1 — Profiles + visibility

- Migration `0024_community_profiles.sql`.
- `users` Drizzle schema additions.
- `services/api/src/modules/community/{routes,handlers}.ts`:
  `GET /community/users/:nickname/profile`, `GET /community/me`,
  `PATCH /community/me/{visibility,profile}`.
- `apps/web/src/app/(main)/u/[nickname]/page.tsx` (renders 0 stats
  pre-projection).
- `apps/web/src/app/(main)/account/community/page.tsx`.
- Doc updates: CLAUDE.md migration list + Live phase status,
  docs/SCHEMA.md (new columns), docs/PHASES.md (Phase 10.1 row).

### Phase 10.2 — Feed + projection

- Migration `0025_community_tickets.sql` + Drizzle schema.
- Go: `WriteCommunityProjection` in
  `services/settlement/internal/store/store.go`; called from
  `settler.maybeSettleTicket` and `settler.reverseSettleTicket`.
- TS API: `GET /community/feed` (recent sort), `GET /community/users/:nickname/tickets`.
  Refactor profile stats to read from `community_tickets`.
- Web: `/community` feed page with sport + currency filter pills,
  `<CommunityTicketCard>` with currency badge, link to
  `/u/[nickname]` per card.
- Admin: `POST /admin/community/backfill` (one-shot; safe to run
  repeatedly).
- Doc updates: CLAUDE.md (Architecture map gets the projection write
  arrow on settlement; Live phase status), docs/ARCHITECTURE.md (new
  bullet under settlement flow), docs/SCHEMA.md.

### Phase 10.3 — Scoring + Best Wins + Copy

- Port the deterministic scoring formula:
  Recency 30 / Inspiration 25 / Odds 15 / Reputation 15 / Copyability 15.
  Recompute on settle (in-tx, cheap) + nightly batch via a tiny Go
  ticker in settlement (or a TS cron in `services/api` — TBD when 10.3
  starts).
- Feed `?sort=best` path on the existing endpoint.
- `POST /community/copy/:communityTicketId` — returns selections in the
  same shape `POST /bets` accepts.
- Web: copy-to-bet button on every settled-won card; bet-slip rail
  prefill helper.
- Live updates: `services/ws-gateway` adds `community:feed` channel;
  settlement publishes a small `{ ticketId, userId, score }` frame on
  each projection write.
- Doc updates: CLAUDE.md invariants (scoring formula reference); WS
  channel namespace.

### Phase 10.4 — Achievements + AI seed bettors

- `achievement_definitions` + `user_achievements` tables (migration
  TBD; `0028+` depending on intervening work).
- Idempotent unlock writes co-located with the projection write hook.
- Seed bettor accounts created via a one-off script. AI ticket
  generator runs as a small Go service (or scheduled job in `services/api`)
  reading the next-24h fixture board, picking 1–3 leg bets per seed
  account, and submitting via the normal `POST /bets` path.
- Seed accounts excluded from `/admin/stats/pnl-by-day` (filter
  `is_ai=false`).
- Doc updates: CLAUDE.md hard limits (seed accounts excluded from
  PnL); docs/PHASES.md.

---

## Invariant compliance checklist

The plan respects every existing invariant:

- **Money is `BIGINT _micro` per currency.** All ticket amounts in
  `community_tickets` are `BIGINT`, with a sibling `currency CHAR(4)`
  column. Every read by user is scoped by `(user_id, currency)`.
- **Apply-once.** The projection's `UNIQUE (ticket_id)` makes the write
  idempotent under settlement replay; `ON CONFLICT DO UPDATE` keeps
  status + payout in sync across re-settle generations without
  duplicating rows.
- **Drizzle is the schema source of truth.** Every schema change has a
  matching `packages/db/src/schema/*.ts` file and a hand-written
  migration with an `_journal.json` entry.
- **No localhost in code.** Community endpoints reuse the existing
  Fastify server config; no new hostnames introduced.
- **No emojis.** UI copy, log lines, commit messages, code comments.
- **Doc-sync-on-merge.** Each implementation PR updates CLAUDE.md (the
  migration list + the Live phase status table), docs/SCHEMA.md,
  docs/ARCHITECTURE.md (settlement flow gains a projection-write
  arrow), docs/PHASES.md, and the relevant service READMEs in the same
  merge — never in a follow-up.

---

## Risks + open follow-ups

- **Backfill volume on 10.2 deploy.** If we accumulate >50k settled
  tickets before the projection write hook lands, the
  `POST /admin/community/backfill` endpoint needs batching. Trivial but
  worth flagging.
- **Seed bettor PnL accounting.** Seed accounts place real tickets
  through the real settlement flow; their wins/losses hit the wallet
  ledger. Mitigation: exclude `is_ai=true` from
  `/admin/stats/pnl-by-day` aggregations. Funded via a separate
  admin-credit pool with a capped weekly budget. Lands in 10.4.
- **OZ vs USDT in the feed.** OZ is the demo signup bonus currency;
  90%+ of early tickets will be OZ. The currency badge on each card
  prevents confusion, but the "real" leaderboard story (USDT-only)
  needs deliberate UX so OZ activity doesn't drown out USDT wins.
- **Nickname squatting.** First-come unique constraint via citext.
  Acceptable for V1; revisit if abuse appears.
- **Cashed-out tickets in the feed.** `tickets.status='cashed_out'`
  resolves the user's bet but at a different payout than a normal
  settlement. Decision: include cashed-out tickets in the projection
  (`status='cashed_out'`, `payout_micro` = cashout amount). They
  surface in the feed with a `Cashed out` badge.

---

## Server deploy notes

The production server is a Hetzner CPX22 (4 GB RAM). Per CLAUDE.md
hard limits, every implementation PR's deploy must:

1. Apply migrations first (nullable column adds are safe under
   running images).
2. Build only the changed services serially via `sudo -n docker
   compose build <service>` (never the unargumented form).
3. Recreate just those services with `--no-deps --force-recreate`.

The community module touches `services/api` (always rebuilt for new
routes), `services/settlement` for the projection hook (10.2+), and
`apps/web` for the new pages. `feed-ingester`, `odds-publisher`,
`bet-delay`, `wallet-watcher`, `ws-gateway` are unchanged unless 10.3
introduces the live-update channel — which adds `services/ws-gateway`
to the rebuild list for that phase.
