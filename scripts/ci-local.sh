#!/usr/bin/env bash
# Run what CI runs, against VIRGIN services, in CI's order.
#
# ⚠️ This exists because "passes locally" and "passes CI" meant different things, and the gap was
# invisible: `pnpm verify` covers the STATIC gates only, and every manual database run used a
# database that had already been migrated by hand. The fresh-database path — postgres-init →
# migrate deploy → SQL companions → RLS gate, on an empty database — was never exercised outside CI,
# which is exactly where a migration ordering bug would hide.
#
# Requires Docker. Starts throwaway Postgres/Redis/MinIO on high ports, tears them down at exit.
#
#   ./scripts/ci-local.sh            # full sequence
#   ./scripts/ci-local.sh --keep     # leave the services running to poke at a failure
set -euo pipefail

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

PG_PORT=55432
REDIS_PORT=56379
MINIO_PORT=59000
PREFIX=cilocal

cleanup() {
  if [ "$KEEP" = 1 ]; then
    echo "--keep: leaving ${PREFIX}-* running (pg:${PG_PORT} redis:${REDIS_PORT} minio:${MINIO_PORT})"
  else
    docker rm -f "${PREFIX}-pg" "${PREFIX}-redis" "${PREFIX}-minio" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

step "Starting virgin services"
docker rm -f "${PREFIX}-pg" "${PREFIX}-redis" "${PREFIX}-minio" >/dev/null 2>&1 || true
docker run -d --name "${PREFIX}-pg" -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=school -p "127.0.0.1:${PG_PORT}:5432" postgres:16-alpine >/dev/null
docker run -d --name "${PREFIX}-redis" -p "127.0.0.1:${REDIS_PORT}:6379" redis:7-alpine >/dev/null
# quay.io, not Docker Hub — see the note in .github/workflows/ci.yml about anonymous pull limits.
docker run -d --name "${PREFIX}-minio" -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  -p "127.0.0.1:${MINIO_PORT}:9000" quay.io/minio/minio:latest server /data >/dev/null

until docker exec "${PREFIX}-pg" pg_isready -U postgres -d school >/dev/null 2>&1; do sleep 1; done
echo "postgres ready"

export CI=true
export NODE_ENV=test
export MIGRATION_DATABASE_URL="postgresql://postgres:postgres@localhost:${PG_PORT}/school?schema=public"
export DATABASE_URL="postgresql://app_user:app_pw@localhost:${PG_PORT}/school?schema=public"
export PLATFORM_DATABASE_URL="postgresql://platform_admin:platform_pw@localhost:${PG_PORT}/school?schema=public"
export REDIS_URL="redis://localhost:${REDIS_PORT}"
export APP_APEX_DOMAIN=localhost:3000
export RESERVED_SUBDOMAINS=www,api,admin,app,s3
export JWT_ACTIVE_KID=k1
export JWT_KEYS='{"k1":"ci-secret-k1-please-change","k2":"ci-secret-k2-please-change"}'
export ENCRYPTION_MASTER_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
export S3_ENDPOINT="http://localhost:${MINIO_PORT}"
export S3_BUCKET=school-uploads
export S3_ACCESS_KEY_ID=minioadmin
export S3_SECRET_ACCESS_KEY=minioadmin
export SMS_PROVIDER=console
export SMS_WEBHOOK_HMAC_SECRET=ci-webhook-secret
export COOKIE_SECURE=false
export COOKIE_DOMAIN=localhost

step "Install (frozen lockfile)"
pnpm install --frozen-lockfile

step "Bootstrap DB roles + extensions"
docker cp scripts/postgres-init.sql "${PREFIX}-pg:/tmp/init.sql" >/dev/null
docker exec "${PREFIX}-pg" psql -U postgres -d school -v ON_ERROR_STOP=1 -f /tmp/init.sql >/dev/null
echo "roles + extensions created"

step "Prisma generate";                 pnpm prisma:generate
step "Migration safety gate";           pnpm db:check-migrations
step "Migrate (prisma migrate deploy)"; pnpm prisma:deploy
step "SQL companions";                  pnpm db:sql
step "RLS coverage gate";               pnpm db:check-rls
step "Lint";                            pnpm lint
step "Lint shared packages";            pnpm lint:packages
step "Typecheck";                       pnpm typecheck
step "Typecheck Playwright specs";      pnpm typecheck:e2e
step "Unit tests";                      pnpm test:unit
step "Integration tests";               pnpm test:integration
step "Tenant-isolation suite";          pnpm test:isolation
step "Build (api + worker bundles)";    pnpm build

printf '\n\033[1;32mAll CI steps passed against virgin services.\033[0m\n'
