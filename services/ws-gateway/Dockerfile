FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc* ./
COPY packages ./packages
COPY services/ws-gateway ./services/ws-gateway
RUN pnpm install --frozen-lockfile=false --filter @oddzilla/ws-gateway...

FROM base AS builder
COPY --from=deps /app /app
WORKDIR /app/services/ws-gateway
RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app /app
WORKDIR /app/services/ws-gateway
RUN chown -R node:node /app
USER node
EXPOSE 3002
CMD ["pnpm", "start"]
