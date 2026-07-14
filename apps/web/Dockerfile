# Frontend image (Next.js 14 App Router; blueprint §33). Standalone output → a lean
# runner that ships only Next's traced deps (no full node_modules). Build context is
# apps/web (its own pnpm project + lockfile), so this image is independent of the api/
# worker backend image. Node 22 matches the backend image.
#
#   docker build -t school-web apps/web
# In prod an edge proxy (Traefik; see docker-compose.prod.yml) routes /api → the API on
# the tenant host and everything else here; the browser calls /api/v1/* same-origin.

# ---------- builder ----------
FROM node:22-slim AS builder
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# Install deps against the lockfile (deps before source → better layer caching).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build the standalone server bundle (next.config.mjs sets output: 'standalone').
COPY . .
RUN pnpm build

# ---------- runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# Standalone layout: the traced server + a minimal node_modules, plus the static assets
# (Next does not fold .next/static into standalone) copied to where server.js expects them.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

USER node
EXPOSE 3001

# Standalone entrypoint listens on $PORT / $HOSTNAME.
CMD ["node", "server.js"]
