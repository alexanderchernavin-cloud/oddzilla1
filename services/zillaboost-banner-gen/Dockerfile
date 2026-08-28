# node:22-alpine pinned by manifest-list digest (multi-arch) — same base
# as every other TS image; bump them together.
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc* ./
COPY packages ./packages
COPY services/zillaboost-banner-gen ./services/zillaboost-banner-gen
RUN pnpm install --frozen-lockfile=false --filter @oddzilla/zillaboost-banner-gen...

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app /app
WORKDIR /app/services/zillaboost-banner-gen
RUN chown -R node:node /app
USER node
EXPOSE 9091
CMD ["pnpm", "start"]
