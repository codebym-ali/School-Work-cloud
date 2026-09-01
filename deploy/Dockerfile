# Generic front-end image for the workspace (Front-End Instance Separation Plan, Phase 4).
#
# ONE image per app, selected by build-arg. Build context is the REPO ROOT — each app depends on the
# shared packages/* and the workspace install, so a per-app context (the old apps/web/Dockerfile) no
# longer works. Uses `next start`, not standalone: the simplest reliable path for a pnpm monorepo
# (standalone tracing across workspace packages needs outputFileTracingRoot fiddling — revisit for
# leaner images once this is validated on the host).
#
#   docker build -f deploy/Dockerfile --build-arg APP=owner-web -t sw-owner .
#   APP ∈ { web, superadmin-web, owner-web, staff-web, student-web }   (dir under apps/)
#
# Ports (each app's `start` script): web 3001 · superadmin-web 3004 · student-web 3003
#                                     owner-web 3005 · staff-web 3006
# /api is handled by the edge proxy (deploy/Caddyfile), so these images need no NEXT_API_ORIGIN.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG APP
# Workspace manifests + install first (better layer caching), then the source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN cd apps/${APP} && pnpm build

FROM base AS runtime
ARG APP
ENV NODE_ENV=production HOSTNAME=0.0.0.0
WORKDIR /repo
COPY --from=build /repo ./
WORKDIR /repo/apps/${APP}
USER node
# The port is baked into each app's `start` script; the compose file / proxy maps it.
CMD ["pnpm", "start"]
