# services/api

REST API for browsers and admin. TS / Fastify 5 on Node 22.

**Phase 1:** boots, connects to Postgres + Redis, serves `/healthz`.
**Phase 2:** `/auth/{signup,login,refresh,logout,me}`, `/users/me`
(GET, PATCH, POST password), `/wallet`, `/wallet/ledger`.
**Phase 3:** `/admin/mapping{,/:id/review,/summary}`.
**Phase 4:** `/catalog/sports`, `/catalog/sports/:slug`,
`/catalog/matches/:id`, `/catalog/live-counts`, `/admin/odds-config`
(GET + PUT + DELETE + `/options`).
**Phase 5:** `POST /bets`, `GET /bets`, `GET /bets/:id`.
**Phase 6:** `GET /admin/tickets`, `POST /admin/tickets/:id/void`.
**Phase 7 (current):** `GET /wallet/deposit-addresses`, `GET /wallet/deposits`,
`POST /wallet/withdrawals`, `GET /wallet/withdrawals`,
`POST /wallet/withdrawals/:id/cancel`,
`GET /admin/withdrawals`,
`POST /admin/withdrawals/:id/{approve,reject,mark-submitted,mark-confirmed,mark-failed}`.
**Phase 8+:** `/news`, dashboard PnL endpoints.

## Run

```bash
pnpm --filter @oddzilla/api dev       # watch mode
pnpm --filter @oddzilla/api build     # emit dist/
pnpm --filter @oddzilla/api start     # prod
```

In Docker it's already wired — `make up` brings it on `:3001` inside the
Compose network, fronted by Caddy at `/api/*`.

## Layout (target, phase 2)

```
src/
├─ server.ts          bootstrap, plugins, listen
├─ plugins/           auth, db, redis, helmet, cors, rate-limit, swagger
├─ modules/
│  ├─ auth/           /auth/{signup,login,refresh,logout,me}
│  ├─ users/          /users/me (profile + password change)
│  ├─ wallet/         /wallet, /wallet/deposit-address, /wallet/withdrawals
│  ├─ bets/           POST /bets, GET /bets (history), GET /bets/:id
│  ├─ catalog/        /sports, /sports/:slug/tournaments, /matches/:id
│  ├─ admin/          /admin/* (role-gated)
│  └─ news/           /news
└─ lib/
   ├─ errors.ts       typed errors that map to HTTP status
   └─ idempotency.ts  POST /bets Idempotency-Key handling
```

## Conventions

- **Never** return `password_hash`, `refresh_token_hash`, or raw KYC.
- Money on the wire is a **string** (to preserve bigint precision in JSON).
- Idempotency keys on every POST that writes money.
- Errors are typed and mapped; don't `res.code(500).send(err.message)`.
