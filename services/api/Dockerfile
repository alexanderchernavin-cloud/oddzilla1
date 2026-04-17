FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc* ./
COPY packages ./packages
COPY services/api ./services/api
RUN pnpm install --frozen-lockfile=false --filter @oddzilla/api...

FROM base AS builder
COPY --from=deps /app /app
WORKDIR /app/services/api
RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app /app
WORKDIR /app/services/api
EXPOSE 3001
CMD ["pnpm", "start"]
