# apps/web

Next.js 16 App Router frontend. Tailwind v4, TypeScript. Dark `#0A0A0A`
locked. No emojis. shadcn/ui was planned but not adopted — UI primitives
are inline in the dark theme; switch to a real component library if the
surface area grows enough to justify it.

Through Phase 7 this includes:
- Real auth (login/signup, cookie-driven sessions, role-gated admin).
- Catalog + live WS odds on sport + match pages.
- Bet slip + placement + bet history with live ticket-state updates.
- Wallet: balance, ledger, deposit addresses + QR, withdrawal form.
- Admin: mapping review, margins, withdrawals lifecycle.
- Non-wallet ticket admin surfaces (`/admin/tickets`) exist as API
  endpoints but no UI yet.

## Run

```bash
pnpm --filter @oddzilla/web dev        # localhost:3000, Turbopack
pnpm --filter @oddzilla/web build      # standalone output for Docker
pnpm --filter @oddzilla/web start      # prod
```

The standalone Next output is mounted by the `web` service in
`docker-compose.yml`.

## Routes

```
/                     homepage — sports grid, live/news placeholders            ✔
/(auth)/login         login                                                     ✔
/(auth)/signup        signup                                                    ✔
/(marketing)/news     news feed                                                 phase 8
/(app)/account        profile + password change                                 ✔
/(app)/wallet         balance, deposit addresses + QR, withdrawals              ✔
/(app)/bets           bet history with live WS updates                          ✔
/sport/[slug]         sport landing → upcoming + live matches                   ✔ (public)
/match/[id]           markets + outcomes, live WS odds, slip integration        ✔ (public)
/admin                admin shell (role-gated via notFound())                   ✔
/admin/mapping        mapping_review_queue approvals                            ✔
/admin/margins        odds_config edit with cascade selector                    ✔
/admin/withdrawals    approve/reject/submit/confirm/fail lifecycle              ✔
/admin/dashboard      PnL / KPIs                                                phase 8
/admin/users          user list, status/limit/delay toggle                      phase 8
/admin/audit          admin_audit_log viewer                                    phase 8
```

## Theming

`src/app/globals.css` defines CSS custom properties consumed by Tailwind v4
(`@theme`). Update there, not in individual components.

| Token | Value | Use |
| --- | --- | --- |
| `--color-bg` | `#0a0a0a` | page background |
| `--color-bg-elevated` | `#111` | nav bars, inputs |
| `--color-bg-card` | `#141414` | cards |
| `--color-fg` | `#f5f5f5` | primary text |
| `--color-fg-muted` | `#9c9c9c` | secondary text |
| `--color-accent` | `#d9ff3b` | primary buttons, focus rings |
| `--color-positive` | `#22e37b` | wins, up moves |
| `--color-negative` | `#ff4b4b` | losses, down moves |

## Invariants

- **No emojis** in any UI string.
- All money values come over the wire as **strings** (bigint precision).
  Convert with `fromMicro()` for display.
- WS payloads are validated before they touch state — assume nothing.
