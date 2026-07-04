# School Management System

Multi-tenant SaaS for private schools in Pakistan. Built strictly from
[`school-management-master-blueprint.md`](./school-management-master-blueprint.md) (v2.0, authoritative)
and the briefs in [`docs/`](./docs/).

> **Where the blueprint says AWS, we run the user's stack instead** (deliberate, documented deviation):
> Contabo VPS + Coolify (Docker/Traefik), self-hosted Postgres 16, Redis 7, **Cloudflare R2** for
> object storage, Cloudflare for CDN/WAF/DNS. The application design is infra-agnostic and unchanged.

## Stack

| Layer | Choice |
|---|---|
| Backend | Node 22, NestJS 10 (modular monolith: `api` + `worker`), TypeScript strict |
| ORM | Prisma (snake_case mapping) |
| Database | Postgres 16 with Row-Level Security (pooled multi-tenancy) |
| Cache / queues | Redis 7 + BullMQ |
| Object storage | Cloudflare R2 (S3-compatible); MinIO locally |
| Deploy | Coolify on Contabo VPS |

## Repository layout

```
apps/
  api/         NestJS HTTP app (request path)
  worker/      NestJS BullMQ consumer (background jobs)
libs/
  common/      cross-cutting: tenant context, guards, config, errors
  database/    Prisma service, tenant-bound client, client extension
prisma/
  schema.prisma        authoritative data model (blueprint §17)
  sql/                 raw-SQL companions Prisma can't express (§17.1):
                         partial uniques, CHECKs, trigram, RLS policies, grants
  migrations/          Prisma migrations
scripts/               DB bootstrap, SQL runner, RLS coverage CI gate
test/isolation/        merge-blocking tenant-isolation suite (§21.6)
```

## Tenant isolation — three independent layers (blueprint §2, Part IV)

1. **Application** — a Prisma client extension injects/asserts `school_id` on every operation.
2. **Database** — Postgres RLS (`FORCE`) on every `school_id` table; `app_user` has **no** `BYPASSRLS`.
   Policy is fail-closed: no tenant context ⇒ zero rows (never an error — see the `NULLIF` note in
   `prisma/sql/05_rls.sql`).
3. **CI** — the tenant-isolation suite seeds two schools and asserts every cross-tenant access fails;
   `scripts/check-rls-coverage.mjs` fails the build if any `school_id` table lacks a policy.

## Local development

Prerequisites: Node 22, pnpm 9, Docker.

```bash
pnpm install
cp .env.example .env            # then set ENCRYPTION_MASTER_KEY: openssl rand -base64 32

# Start infra (Postgres:5433, Redis:6380, MinIO:9002, ClamAV). Ports are shifted
# off the defaults so this coexists with other local projects (e.g. Goex on 5432).
docker compose up -d postgres redis

# Create schema + apply the RLS/constraint companions + verify RLS coverage
pnpm prisma:migrate            # creates tables (runs as the migration owner)
pnpm db:sql                    # applies prisma/sql/*.sql
pnpm db:check-rls              # CI gate: every tenant table is RLS-covered
```

### Database roles (blueprint §21.5)

`scripts/postgres-init.sql` bootstraps two least-privilege roles:

- **`app_user`** — the API/worker runtime connection. `NOBYPASSRLS`. Always RLS-bound.
- **`platform_admin`** — `BYPASSRLS`, read-mostly. Vendor console + cross-tenant jobs only.

Migrations/DDL run as the superuser (`MIGRATION_DATABASE_URL` → Prisma `directUrl`) because
`FORCE` RLS and `GRANT` require table ownership.

## Roadmap

Milestone-gated (blueprint §34, `docs/10-project-milestones-roadmap.md`). **M1 must be green before
any domain feature.** See `docs/` for the full plan.

| Milestone | Gate |
|---|---|
| M1 Foundations | tenant-isolation suite passes |
| M2 Students & Admissions | `admit` E2E green |
| M3 Attendance, Leaves, SMS | `mark attendance` + absence SMS green |
| M4 Fees | `collect fee` green + integrity check clean |
| M5 Exams & Report Cards | `enter/publish marks` + parent report card green |
| M6 HR, Payroll, Docs, Reports | `promotion` green + reports export |
| M7 Hardening & Pilot | load + pen test + DR drill → GA |
