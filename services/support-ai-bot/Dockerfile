# support-ai-bot — the AI support assistant worker.
#
# Historically PC-only, because the model was a local LM Studio and the thing
# calling it had to sit next to it. With LM_STUDIO_BASE_URL pointed at a
# hosted OpenAI-compatible endpoint that constraint is gone, so it runs here
# and answers around the clock instead of only while an operator PC is awake.
#
# Its sibling services/zillaboost-banner-gen stays on the PC and must: it
# drives ComfyUI, which is unauthenticated admin-level code execution and is
# bound to loopback for that reason.
#
# The worker still dials OUT only — it polls the API's webhook endpoints and
# posts replies. It listens on nothing, which is why the healthcheck reads a
# liveness file rather than probing a port.

FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc* ./
COPY packages ./packages
COPY services/support-ai-bot ./services/support-ai-bot
RUN pnpm install --frozen-lockfile=false --filter @oddzilla/support-ai-bot...

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app /app
WORKDIR /app/services/support-ai-bot
# The worker runs through tsx (see package.json `start`), matching the api
# container: the @oddzilla/types workspace ships source TypeScript, so there
# is no build step to run here.
RUN chown -R node:node /app
USER node
CMD ["pnpm", "start"]
