# zillaboost-banner-gen

Operator-PC worker that generates AI graphics for ZillaBoost promo
banners. NOT part of the docker stack — it runs ON the machine that
hosts ComfyUI and dials OUT to the production API over HTTPS, exactly
like `services/support-ai-bot`. The server never connects inbound.

**ComfyUI stays bound to 127.0.0.1 — non-negotiable.** It has no
authentication, executes workflow graphs as the (Administrator) user
running it, and `--enable-manager` can install arbitrary custom nodes:
network exposure is remote code execution as admin. A server-side
variant of this worker briefly existed (2026-08-28, reaching the PC
over tailscale) and was reverted the same day for exactly that reason —
the sportsbook only needs "make me an image from this text", never a
route to port 8188.

```
worker (this PC) ──outbound HTTPS──> https://oddzilla.cc/api/webhooks/banner-gen/<secret>/...
   │
   ├──> ComfyUI    http://127.0.0.1:8188   (never leaves the box)
   └──> LM Studio  http://127.0.0.1:1234   (prompt authoring)
```

## Flow

1. Admin ticks **Generate graphics banner** in the ZillaBoost popup →
   the api enqueues a job row (`zillaboost_banner_image_jobs`).
2. This worker polls `GET /webhooks/banner-gen/<secret>/pending`,
   claiming due jobs under a 15-minute lease.
3. Per job: research the boosted entities on Wikipedia (keyless Action
   API) → author a diffusion prompt on LM Studio
   (`/v1/chat/completions`) → render the plate on ComfyUI (POST
   `/prompt` with a fixed txt2img graph, poll `/history`, fetch via
   `/view`) → composite the real crests and names on top (`sharp`) →
   upload via `POST .../jobs/:ruleId/complete` (base64, 4 MB cap)
   together with the prompt and render params.
4. The storefront's banner endpoint starts serving the image on its
   next poll; banners upgrade in place.

Also `POST /heartbeat` every 30 s on its own timer (fire-and-forget, so
it keeps beating through multi-minute renders) — drives the "Image worker
online" dot and queue counts on `/admin/boosted-odds`.

## Image quality

Four things carry it. The first three are the difference between a
banner and generic AI slop; the fourth is what puts the teams on it.

- **Pixel budget.** Plates render at 1920x640 (~1.2 MP), not the
  original 1152x384 (0.44 MP). Under half the resolution these models
  are trained at is where mushy faces, melted hands and duplicated
  subjects come from, and no prompt fixes it. The plate is downscaled
  to `BANNER_OUTPUT_WIDTH` on the way out, which sharpens it further.
  FLUX also gets an explicit `FluxGuidance` node at 2.5 — ComfyUI's
  implicit 3.5 is what makes faces look plastic and colour look cooked.
- **Prose, not tag soup.** FLUX reads sentences (T5); the SD1.5-era
  `cinematic, dramatic lighting, depth of field, vivid accent colours`
  shape does nothing except summon the machine-made look. The system
  prompt asks for 3-5 plain sentences describing one specific moment,
  and [`prompt.ts`](src/prompt.ts) keeps a banned-vocabulary list that
  is both forbidden in the instructions and **stripped from the
  completion afterwards** (`scrubSlop`) — a small local model agrees
  not to use those words and then uses them anyway.
- **[`game-vocab.ts`](src/game-vocab.ts) supplies each title as ground
  truth**, keyed by sport slug, in two parts: `scene` (what is in the
  frame) and `style` (how that game actually looks — a Source 2 frame,
  Valve painted key art, Riot splash art, a broadcast frame). `scene`
  exists because the LLM does not reliably know these titles: it once
  rendered a DOTA 2 match as tactical-shooter soldiers holding melee
  weapons (2026-08-28), because the "esports arena + soldiers"
  attractor swallows everything. `style` exists because "premium
  esports promo art" produced the same airbrushed picture for all 32
  slugs. Both are appended deterministically so no completion can drop
  them. Adding a sport means adding an entry here, not hoping.
- **Real crests and real names, composited after the render**
  ([`compose.ts`](src/compose.ts)). Diffusion at banner scale draws a
  crest as a smeared blob and a name as mangled pseudo-letters — the
  clearest generated-image tell there is — so the prompt still forbids
  both, and the genuine assets go on top instead: crests fetched from
  `competitors.logo_url` (Oddin CDN or our own byte-serve route, sent
  absolute on the job context), names set in a real font over a scrim,
  with a VS mark. The overlay is sized against the DISPLAY size, not
  the file — the plate is 1536x512 and the card paints it into a
  ~411x137 strip, so type that looks reasonable in the PNG arrives
  illegible on screen. Match / market scope only — sport and tournament
  banners are used by the storefront as backdrops with its own copy laid
  over them, so baking copy into those would collide with the card
  chrome and duplicate it.

  Every part of that step is fail-soft: a crest that 404s is skipped, a
  font that will not rasterise drops the text layer, and `sharp`
  missing entirely (new code unpacked on the GPU box without a
  `pnpm install`) falls back to the bare plate.

**Team identity still needs `brand_color`** on the job context — the
prompt puts each side's colour on its gear and in the light falling on
it. Teams with no colour set produce generic art; fix that at
`/admin/competitors`, not in the prompt.

Every render's prompt + params (checkpoint, cfg, steps, sampler, size,
**seed**, negative) are stored server-side and shown by expanding the
`img` chip in the admin overview. `seed` + `checkpoint` + prompt
reproduce a render by hand in ComfyUI.

## Availability semantics

- **This PC off** → nothing polls; jobs accumulate server-side as
  `pending` and drain when the worker starts again. Run it under Task
  Scheduler ("At log on" / "At startup") so booting the PC IS the retry.
- **Image backend down (PC on)** → the worker probes before claiming
  and sleeps `BACKEND_RETRY_MS` (default 1 hour) between probes. No
  jobs are claimed, no attempts burned.
- **Generation error** → reported to the api; the job backs off 1 hour
  per attempt and flips to `failed` after 24 attempts (visible as a red
  chip in the admin overview; untick + re-tick the option to reset).
- **API unreachable** → normal poll-interval retry (a flaky WAN
  shouldn't cost an hour). A job orphaned mid-render self-returns to
  the queue when its lease expires.

## Setup

```
cd services/zillaboost-banner-gen
cp .env.example .env     # fill ODDZILLA_API_BASE + BANNER_GEN_TOKEN
pnpm install
pnpm start
```

Run it under Task Scheduler ("At log on" / "At startup") so booting the
PC IS the retry. On the current GPU box (`DESKTOP-IO524Q2`, `ssh
localserver`) that task is **`ZillaboostWorker`**, launcher
`D:\AI\zillaboost-worker.cmd`, log `D:\AI\zillaboost-worker.log`.
Updating it is NOT `git pull` — that box has no usable git credentials;
see "Updating the worker on the GPU box" in
[`docs/OPERATIONS.md`](../../docs/OPERATIONS.md) for the git-bundle
procedure. **Re-run `pnpm install` there after unpacking**: the
compositor depends on `sharp`, which is a native module, and without it
the worker still runs but ships bare plates with no crests or names
(it logs `sharp unavailable` once at the first job).

Server side: set the SAME `BANNER_GEN_TOKEN` in `/home/team/oddzilla/.env`
(`openssl rand -hex 24`) and `make recreate api`. Until then the webhook
routes 503 `banner_gen_disabled` — jobs still enqueue and wait.

Two server-side limits must both be in place or a successful render
still 413s on upload: the `/complete` route's own `bodyLimit` (8 MiB —
the 4 MiB decoded cap is ~5.6 MiB as base64) and Caddy's
`@banner_gen_uploads` carve-out above its 1 MiB default.

The image backend is ComfyUI on loopback (`127.0.0.1:8188` — do NOT
launch it with `--listen`). Keep `IMAGE_MODEL` pinned to FLUX on the
RX 7900 XTX box (SD3.5-fp8 crashes its ROCm kernels); a FLUX pick uses
the box-verified graph (EmptyLatentImage, sampler cfg 1.0) with an
explicit FluxGuidance node at 2.5 and 28 steps. A different backend is
a one-file swap in `src/imagegen.ts`.

The worker also POSTs `/heartbeat` every 30 s (fire-and-forget, keeps
beating through long renders) — it drives the "Image worker online"
dot + queue counts on `/admin/boosted-odds`, mirroring the support
assistant's indicator.

## Guardrails baked into the prompt

No text / numbers / logos / watermarks in the RENDER, no real people,
trademarked marks never drawn — not out of caution but because
diffusion cannot produce any of them legibly at this size, and the
attempt is the loudest AI tell on the image. The real crests and names
are composited on afterwards (see **Image quality** above). The prompt
also reserves space for whatever gets laid over the plate: the bottom
third stays simple on match / market plates (the matchup band lands
there), the left third stays simple on sport / tournament plates (the
storefront scrims its own copy there).
