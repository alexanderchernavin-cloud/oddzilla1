# zillaboost-banner-gen

Worker that generates AI graphics for ZillaBoost promo banners.

**Primary deployment (since the tailnet): the `banner-gen` compose
service on the production box.** tailscaled runs on the HOST and joins
the operator's tailnet; the container reaches the model PC's LM Studio +
image server through it (containers route to `100.64.0.0/10` via the
host, no extra network config). Set `LM_STUDIO_BASE_URL` /
`IMAGE_API_BASE` in the server `.env` to the PC's tailnet name and
`make recreate banner-gen`.

It can equally run straight on any PC (`pnpm start` with a local
`.env`) — the queue's claim leases make concurrent workers safe.

## Flow

1. Admin ticks **Generate graphics banner** in the ZillaBoost popup →
   the api enqueues a job row (`zillaboost_banner_image_jobs`).
2. This worker polls `GET /webhooks/banner-gen/<secret>/pending`,
   claiming due jobs under a 15-minute lease.
3. Per job: research the boosted entities on Wikipedia (keyless Action
   API) → author a diffusion prompt on LM Studio
   (`/v1/chat/completions`) → render on ComfyUI (POST `/prompt` with a
   minimal txt2img graph, poll `/history`, fetch via `/view`) → upload
   via `POST .../jobs/:ruleId/complete` (base64 PNG, 4 MB cap).
4. The storefront's banner endpoint starts serving the image on its
   next poll; banners upgrade in place.

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

Server side: set the SAME `BANNER_GEN_TOKEN` in `/home/team/oddzilla/.env`
(`openssl rand -hex 24`) and `make recreate api`. Until then the webhook
routes 503 `banner_gen_disabled` — jobs still enqueue and wait.

The image backend is ComfyUI (must listen beyond loopback:
`--listen 0.0.0.0`). Checkpoint auto-discovery prefers an SD3-family
model; a FLUX pick drops cfg to 1.0 automatically. A different backend
is a one-file swap in `src/imagegen.ts`.

## Guardrails baked into the prompt

No text / numbers / logos / watermarks in the image (the storefront
overlays its own ZillaBoost chip and copy); no real people; trademarked
marks evoked through colours and atmosphere only; left third of the
frame kept calm for the UI copy that sits over it.
