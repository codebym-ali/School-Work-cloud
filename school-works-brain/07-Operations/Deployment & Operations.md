---
title: Deployment & Operations
type: ops
updated: 2026-07-06
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

## Jobs & schedules (§27)
BullMQ, `attempts:3` + backoff, dead-letter monitored. Inventory: invoice-batch-generate, `mark-overdue` (nightly), the `*-sms` event jobs, report-cards-generate, promotion-batch, payroll-run, sms-log-purge, idempotency-purge, `fee-integrity-check` (nightly, pages on mismatch), reconciliation, `tenant-export`, `db-backup-verify` (weekly). → [[System Architecture]]. *(SMS jobs ✅ built M3; the rest land with their milestones.)*

## Observability & NFRs (§29, §31)
Targets: P95 <300ms read / <600ms write, 99.9% uptime, RPO ≤30m, RTO ≤4h, 500 concurrent payments, 10k SMS <30m. **Rate limits (Redis sliding window) ✅ implemented (M7)** — `RateLimitGuard` + atomic Lua limiter, 429 + `Retry-After`. **Sentry error monitoring ✅ (M7)** — unhandled 500s + exhausted worker jobs, tagged `schoolId/userId/requestId`, opt-in via `SENTRY_DSN`. Structured logs with `requestId/schoolId/userId`, PII-redacted. `TENANT_VIOLATION` and `fee-integrity-check` mismatches **page on-call**. → [[07-non-functional-requirements]].

## DR & runbooks (§33)
Backups + PITR, cross-account/region copies, weekly restore-verify, quarterly restore drills, annual failover drill. Single-tenant restore via `tenant-export` replay → [[Multi-Tenancy & Isolation]].

**Source:** [[08-deployment-infrastructure-plan]], [[07-non-functional-requirements]], blueprint §27–§33.
**Implementation status:** local docker-compose ✅; CI ✅; SMS worker/queue ✅ (M3); **rate-limits ✅ + Sentry error monitoring ✅ (M7)**. Production Coolify deploy, backups, tracing/metrics ⬜ → [[Progress Tracker]].
