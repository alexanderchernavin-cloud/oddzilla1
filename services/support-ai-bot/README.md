# support-ai-bot

Autonomous live-support assistant for Oddzilla. It answers bettors in the
existing live-support chat, using any **OpenAI-compatible
`/v1/chat/completions`** endpoint for the model.

**It runs in the docker stack** (since 2026-09-01). It was PC-only before
that for exactly one reason — the model was a local LM Studio, so the thing
calling it had to sit beside it. Point `LM_STUDIO_BASE_URL` at a hosted
endpoint and that anchor is gone, so the assistant now answers around the
clock instead of only while a PC is awake with a model loaded. Running it on
a PC against a local LM Studio still works unchanged; nothing about the
outbound design assumes either location.

(Its sibling `services/zillaboost-banner-gen` stays on the PC permanently:
it drives ComfyUI, which is unauthenticated admin-level code execution and
must remain bound to loopback.)

## How it works

- **Dials OUT** to the public API; the server never connects back. No tunnel,
  no port-forward, nothing exposed on your PC.
- Polls `GET /webhooks/support-ai/:secret/pending` for open support threads
  that have an unanswered bettor message and are still AI-handled, runs the
  local model, then `POST`s either a reply or an escalation.
- **Heartbeats** every ~15s so the backoffice shows "Assistant online". When
  this PC is off the bot is simply silent and threads wait for a human — the
  admin shows "offline" within ~45s.

## Tools (read-only)

The model answers from the bettor's account snapshot and can call these
look-up tools on demand — none of them can change anything:

- `find_matches` / `match_markets` / `team_results` — Oddzilla's own data
  (schedule, live odds, a team's recent results).
- `web_search` — general real-world facts the platform doesn't have (past
  tournament winners, a Major's champion, team / player / event background),
  via the **keyless Wikipedia API**. Question phrasings are normalised to a
  keyword query (`"who won IEM Cologne 2026?"` → `IEM Cologne 2026`) because
  Wikipedia's full-text search ranks keywords far better than questions.
  Language/mirror override: `WIKIPEDIA_API_BASE`. It's Wikipedia, not the open
  web — great for factual/historical questions, not breaking news.

## Guardrails

- The bot can **only reply or escalate** — it has no power to move money or
  change accounts (no such endpoint exists).
- **Account-aware but read-only**: the server hands it a pre-formatted snapshot
  of the bettor's own wallet / tickets / deposits / withdrawals. The model is
  instructed to use only those figures and never invent numbers.
- **Escalates** (hands to a human) on withdrawal/deposit problems, bet or
  settlement disputes, KYC, account/security, complaints, or anything it is
  unsure about.
- A **responsible-gambling tripwire** forces a supportive escalation regardless
  of the model output, and a **post-filter** blocks any reply that promises
  payouts/refunds or claims an account action.
- A human **"Take over"** in the backoffice (and any human reply) pauses the
  bot on that thread; "Resume AI" hands it back.

## Setup

1. Install **LM Studio**, download a Gemma model, open the **Developer** tab,
   **Start Server** (default `http://localhost:1234`), and **load the model**.
2. From the repo root: `pnpm install`.
3. Copy the env template and fill it in:
   ```
   cp services/support-ai-bot/.env.example services/support-ai-bot/.env
   ```
   - `SUPPORT_AI_BOT_TOKEN` — the **same** value as the server's `.env`.
   - `ODDZILLA_API_BASE` — e.g. `https://oddzilla.cc/api`.
   - `LM_STUDIO_BASE_URL` — only if it isn't the default.
   - `LM_STUDIO_MODEL` — leave blank to auto-detect the loaded model.
4. Start it:
   ```
   pnpm --filter @oddzilla/support-ai-bot start
   ```

## Keep it running on boot (Windows)

Use **Task Scheduler** → Create Task:
- **Trigger**: At log on (or At startup).
- **Action**: Start a program → `pnpm`, arguments
  `--filter @oddzilla/support-ai-bot start`, **Start in** = the repo path.
- **Settings**: tick *Restart the task if it fails*.

The bot tolerates the API or LM Studio being briefly unavailable and retries
each tick, so transient restarts are harmless.

## Verifying end-to-end

1. Start the bot → the backoffice support inbox shows **Assistant online**
   within ~15s.
2. As a test bettor, open a support thread and ask a product question
   ("how do I deposit?"). A reply tagged **AI** appears within a poll cycle and
   shows live in the bettor's chat widget.
3. Ask something account-specific ("what's my balance?") → the answer matches
   the server-provided facts exactly (it never invents figures).
4. Send a withdrawal dispute or a distress phrase → the bot posts a short
   holding message, escalates, and the thread surfaces in the operator's unread
   queue (the AI stops replying until "Resume AI").
5. Stop the bot (Ctrl-C) → within ~45s the admin shows **Assistant offline**;
   new bettor messages queue for a human, with no errors.
