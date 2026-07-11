# Backend image for the api + worker deployables (blueprint §33; Coolify/Contabo).
# One image, two entrypoints — the compose/Coolify service overrides CMD:
#   api    → node dist/apps/api/main
#   worker → node dist/apps/worker/main
# Node 22 matches the pinned engine (package.json "engines").

# ---------- builder ----------
FROM node:22-slim AS builder
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# Toolchain for native modules (argon2) + prisma engine (openssl).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install deps against the lockfile (better layer caching: deps before source).
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# Build api + worker bundles, generate the Prisma client, then drop dev deps.
COPY . .
RUN pnpm prisma:generate \
  && pnpm build \
  && pnpm prune --prod

# ---------- runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
# openssl is required at runtime by the Prisma query engine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Prod deps (incl. the generated Prisma client + CLI for migrate deploy), built code,
# schema/migrations/sql companions, and the DB bootstrap scripts.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json ./package.json

USER node
EXPOSE 3000

# Default to the API; the worker service overrides this.
CMD ["node", "dist/apps/api/main"]
