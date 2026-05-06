# node:22-alpine pinned by manifest-list digest (multi-arch). Refresh
# with `docker buildx imagetools inspect node:22-alpine` and bump in
# every services/*/Dockerfile + apps/web/Dockerfile when bumping.
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS base
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
RUN chown -R node:node /app
USER node
EXPOSE 3001
CMD ["pnpm", "start"]
