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
# Pre-create the team-logos write target so the named volume inherits
# `node` ownership on first mount. resolve-logos / apply-logo-seed
# scripts download into this path; LOGO_STORE_DIR=/data/team-logos in
# docker-compose. Without this chown the volume mounts as root:root
# and the api process (running as `node`) gets EACCES.
RUN mkdir -p /data/team-logos && chown -R node:node /app /data
USER node
EXPOSE 3001
CMD ["pnpm", "start"]
