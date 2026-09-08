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
- **Escalates** (hands to a human) in exactly two cases: the bettor explicitly
  asks for one (the model answers `ESCALATE: <note>`), or the model returned
  nothing at all. It does **not** escalate account questions — per the
  operator's directive it answers those from the read-only snapshot.
- **Responsible gambling is handled in the prompt, not by a code tripwire.**
  There is no forced escalation and no payout/refund post-filter in
  `guardrails.ts` — both were removed deliberately (see the comment there).
  The system prompt commits the assistant to answering addiction and
  loss-of-control messages with real, supportive help and a helpline rather
  than a one-line referral. Anything added around the model has to preserve
  that; see the distress veto below.
- **Abuse moderation** ([`moderation.ts`](./src/moderation.ts), operator
  directive 2026-09-08, `BOT_MODERATION_ENABLED`, on by default). A bettor
  message that is abuse *aimed at the assistant* gets one fixed operator-chosen
  reply instead of a model turn. Deterministic and model-free — the reply is a
  fixed string, and a safety-trained model asked to produce it would comply
  inconsistently. It runs **before** the model call, so it also works when no
  model is loaded.

  The rule is targeting, not vocabulary: a directed phrase ("fuck you", "иди
  нахуй") fires on its own, and otherwise a swear has to sit within three
  tokens of a second-person word. That window is the whole reason it is
  usable — "what the fuck happened to my bet, can you check" contains both
  words nine tokens apart and must not fire.

  **A distress marker vetoes it outright**, before any targeting rule:
  addiction, self-exclusion, "lost everything", rent money, self-harm, and
  the Russian equivalents. Someone swearing while they lose control is
  precisely who the responsible-gambling path above is written for, and
  insulting them would be the system doing the opposite of its job at the
  one moment it matters. Unit-tested in
  [`moderation.test.ts`](./src/moderation.test.ts), where most of the cases
  are the ones that must **not** fire.

  **Languages: all six the storefront ships** — en, ru, es, pt, cs, hr. A
  language is always added to *all three* lists in one pass; adding its
  abuse vocabulary without its distress markers is the dangerous half,
  because it makes the veto silently inapplicable to exactly the speakers
  it exists for. The lists are pooled rather than picked by locale (the
  bettor's language is not known here, and people code-switch), so short
  tokens are checked for cross-language collisions before being added —
  Croatian `vi` is left out because it is "I saw" in Spanish and
  Portuguese, and Spanish `os` and `si` are out for the same reason.
  Diacritics are deliberately not folded, since folding Czech `píča` to
  `pica` would collide with Spanish `pica`.

  The **reply itself is not localised** — it is one fixed string the
  operator chose. Detection is multilingual; the answer is not.
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
   - `BOT_MODERATION_ENABLED` — `false` turns the abuse layer off entirely
     and sends every message to the model, as before.
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
