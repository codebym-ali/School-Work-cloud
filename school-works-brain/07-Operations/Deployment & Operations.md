---
title: Deployment & Operations
type: ops
updated: 2026-08-29
---

# Deployment & Operations

> [!note] Stack deviation (approved)
> The blueprint ([[08-deployment-infrastructure-plan]]) is written for **AWS** (ECS/RDS/S3/CloudFront/KMS…). We run the owner's existing stack. App code is unchanged; only infra differs.

## Our stack (Contabo + Coolify + Cloudflare)
| Blueprint (AWS) | Our stack |
|---|---|
| ECS Fargate (api + worker) | **Coolify** on a Contabo VPS (2 Docker services) |
| ALB | Coolify's built-in **Traefik** (TLS via Let's Encrypt) |
| CloudFront + WAF | **Cloudflare** (CDN/WAF/DNS; wildcard `*.domain` for subdomain tenancy) |
| RDS Postgres 16 | **self-hosted Postgres 16** via Coolify |
| ElastiCache Redis | **Redis 7** via Coolify |
| S3 + versioning | **Cloudflare R2** (S3-compatible; versioning + presigned URLs) |
| KMS | app-level AES-256-GCM master key in **Coolify secrets** |
| Secrets Manager | **Coolify env/secrets** |
| CloudWatch/Prometheus/… | start lean: **Sentry + Coolify logs** |

**Honest trade-offs:** a single VPS can't meet the blueprint's Multi-AZ / 99.9% / RTO-4h NFRs — fine for launch + pilot; scale to a replica/managed DB + a 2nd app node later **without code changes**. **Backups are ours to own** — nightly `pg_dump` + WAL → R2 + weekly restore-test *(the one outstanding M1 hardening item)*.

## Environments & deploys
Local (docker-compose: pg/redis/minio/clamav) → staging → prod. Blue/green at the proxy; migrations **N-1 compatible** (expand/contract); per-tenant feature flags (pilot → 10% → all); rollback section in every deploy.

## Production go-live: subdomain hosting on the VPS ⏳ TODO
**Operator decision (2026-08-29): host on a VPS under `schoolworks.com`, subdomain-per-tenant.** The whole
front end is ONE web app on ONE port, separated by **subdomain** (the Host header), **never by port** — ports
share cookies across the same hostname and don't encode which tenant, so they are the wrong boundary (they
are a dev-only convenience). See [[Multi-Tenancy & Isolation]].

**The rule: a subdomain = a SCHOOL (tenant), not a role.** Owner, campus admin, staff and students all sign in
on THEIR school's subdomain via the role doors (`/owner-login`, `/staff-login`, `/student-login`) — the
subdomain identifies the school, the door + role identifies the person. A single global `admin.`/`student.`
role-subdomain would **break tenancy** (re-merges every school onto one cookie domain) and is a security
regression, not an improvement. The only legitimate global-subdomain split is the vendor console.

**Target layout:**
- `schoolworks.com` (+ `www.`) → the **marketing** landing page (apex).
- `superadmin.schoolworks.com` → the **vendor console** (super admin) — one global subdomain, separate
  `platform_users` + separate cookies. *(Console is currently reachable under the reserved `admin` subdomain;
  add `superadmin` to serve it there.)*
- `<school>.schoolworks.com` → each school's app, e.g. `greenwood.schoolworks.com/owner-login`.

**Go-live checklist** (the concrete "production Coolify deploy on the VPS" item from Implementation status):
1. **DNS (Cloudflare):** `A schoolworks.com → VPS IP` **plus a wildcard** `A *.schoolworks.com → VPS IP`, so a
   new school subdomain resolves with **no per-school DNS change**. Proxied (orange-cloud) for CDN/WAF.
2. **TLS:** a **wildcard** Let's Encrypt cert `*.schoolworks.com` on the Traefik edge — wildcards need the
   **DNS-01** challenge (Cloudflare API token); HTTP-01 cannot issue wildcards.
3. **Env:** `APP_APEX_DOMAIN=schoolworks.com`; add `superadmin` to `RESERVED_SUBDOMAINS`
   (`www,api,admin,app,superadmin`); prod cookie domain + `secure`/HTTPS cookie flags on; `NODE_ENV=production`
   (which also enforces `RATE_LIMIT_ENABLED=true`).
4. **Reverse proxy:** Traefik path-split (`/api` → api, `/` → web) **preserving the Host header** (already
   designed + proven locally — see the ingress-topology note under Implementation status) with a
   `websecure :443` entrypoint + the Let's Encrypt certresolver.
5. **A new school gets its subdomain for free** — provisioning writes the `<subdomain>` record; wildcard DNS +
   wildcard cert mean it resolves and is HTTPS with zero per-school setup.
6. **Then:** `migrate deploy` + SQL companions + RLS-coverage check, seed the platform admin, and smoke-test
   every entry point on the real domain (marketing apex, `superadmin.`, a `<school>.` with its three doors).

⚠️ **Do NOT split roles onto separate ports or role-subdomains.** Roles are resolved inside the tenant app
(role guards + `landingPath`); the vendor console is the one global-subdomain split.

## Jobs & schedules (§27)
BullMQ, `attempts:3` + backoff, dead-letter monitored. Inventory: invoice-batch-generate, `mark-overdue` (nightly), the `*-sms` event jobs, report-cards-generate, promotion-batch, payroll-run, sms-log-purge, idempotency-purge, `fee-integrity-check` (nightly, pages on mismatch), reconciliation, `tenant-export`, `db-backup-verify` (weekly). → [[System Architecture]].

**Cross-tenant scheduled jobs wired (M7)** — `MaintenanceProcessor` upserts BullMQ **repeatables** (idempotent, fire once fleet-wide) and `MaintenanceService` runs each: `mark-overdue` 01:00, `fee-integrity-check` 01:30 (pages on mismatch), `idempotency-purge` hourly, `sms-log-purge` 02:00, **`sms-monthly-credit` 1st of month 00:30** — refreshes each active tenant's plan SMS credit (`PLAN_MONTHLY_SMS_CREDITS[planTier]`), idempotent per calendar month, on the BYPASSRLS platform connection. **Deliberately NOT auto-crons** (human-in-the-loop by design, would be a domain bug if timed): **payroll-run** (monthly admin action, reviewed via `approve`/`markPaid`), **report-cards-generate** (fires on term close when weightages sum to 100). **attendance-archive** deferred (no method; not GA-critical). *(SMS event jobs ✅ built M3.)*

## Observability & NFRs (§29, §31)
Targets: P95 <300ms read / <600ms write, 99.9% uptime, RPO ≤30m, RTO ≤4h, 500 concurrent payments, 10k SMS <30m. **Rate limits (Redis sliding window) ✅ implemented (M7)** — `RateLimitGuard` + atomic Lua limiter, 429 + `Retry-After`. **Sentry error monitoring ✅ (M7)** — unhandled 500s + exhausted worker jobs, tagged `schoolId/userId/requestId`, opt-in via `SENTRY_DSN`. Structured logs with `requestId/schoolId/userId`, PII-redacted. `TENANT_VIOLATION` and `fee-integrity-check` mismatches **page on-call**. → [[07-non-functional-requirements]].

## DR & runbooks (§33)
Backups + PITR, cross-account/region copies, weekly restore-verify, quarterly restore drills, annual failover drill. Single-tenant restore via `tenant-export` replay → [[Multi-Tenancy & Isolation]]. **Step-by-step recovery procedures + drill log: [[DR Runbook]]** (Runbook A logical restore, B PITR, C VPS rebuild, D single-tenant; PITR verified locally 2026-07-14).

**Source:** [[08-deployment-infrastructure-plan]], [[07-non-functional-requirements]], blueprint §27–§33.
**Implementation status:** local docker-compose ✅; CI ✅; SMS worker/queue ✅ (M3); **rate-limits ✅ + Sentry ✅ + Prometheus `/metrics` + Pino JSON logs ✅ + worker cron ✅ (M7)**; **containerized ✅** — backend multi-stage `Dockerfile` (Node 22; one image → api+worker via CMD; prod-pruned, Prisma CLI kept for `migrate deploy`) + a separate **web image** (`apps/web/Dockerfile`, Next 14 `output: 'standalone'` runner) + `docker-compose.prod.yml` (api+worker+web+one-shot `migrate`+pg/redis/minio + a **Traefik edge**). **Ingress topology (M7, 2026-07-14):** Traefik path-routes one origin — `/api` → api (priority 100), `/` → web (priority 1) — and **preserves the Host header** so the API's `TenantResolutionMiddleware` still resolves the school from the subdomain; the browser calls `/api/v1/*` same-origin. Verified: web image builds + serves (`/login` 200, correct `<title>`), and the path-split + Host-preservation proven with a `traefik/whoami` file-provider test (`/api`→API-STUB, `/`→WEB-STUB, `Host: demo.localhost` echoed on both). **PITR backups ✅** — WAL archiving + `basebackup.sh`/`restore-verify-local.sh` (restore-verified). **Durable WAL→R2 ✅ (2026-07-14):** a custom `docker/postgres` image (postgres:16-alpine + rclone + `scripts/archive-wal.sh`) ships each segment off-box to `s3://$R2_BUCKET/wal/` (opt-in `WAL_R2_ENABLED=true`) and returns non-zero until the upload lands, so Postgres never recycles un-shipped WAL — base **and** WAL both live in R2, so PITR survives host loss. Verified end-to-end vs S3-compatible storage; the image owns `/wal-archive` as `postgres` so the fresh volume is writable (retires the archive-dir uid gotcha). **Deploy gotchas:** (1) docker `env_file`/`--env-file` do NOT strip inline `# comments` — keep them on their own line; on Coolify set env vars directly, `JWT_KEYS` single-line JSON. (2) **Traefik's docker provider needs the docker socket** (`/var/run/docker.sock`) — works on the Linux VPS but fails on local Docker Desktop for Windows (daemon-negotiation error), which is why the routing was proven via the file provider. For prod add a `websecure :443` entrypoint + Let's Encrypt certresolver (Coolify's Traefik does this for you). Remaining: production Coolify deploy on the VPS, k6/live load at fleet scale, pen test, DR drill → [[Progress Tracker]].
