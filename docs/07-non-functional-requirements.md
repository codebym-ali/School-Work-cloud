# Non-Functional Requirements (NFRs) — v1.0

**Product:** Multi-Tenant School Management System
**Document:** 07 — Non-Functional Requirements
**Audience:** Architects · DevOps · QA · Performance Engineers
**Authority:** Conforms to `docs/consistency-register.md` (v1.0, LOCKED) and `school-management-master-blueprint.md` (v2.0) §29–§33, §21.6, §34. Where this document would conflict with the register, the register wins.

---

## 1. Performance Targets

| Metric | Target | Measurement method |
|---|---|---|
| **P95 read latency** | **< 300 ms** (excl. async) | Prometheus histogram per route (golden signals); measured at the API, excluding queued work |
| **P95 write latency** | **< 600 ms** (excl. async) | Prometheus histogram per route |
| **Concurrent payment submissions** | **500** (design basis) | k6 load profile: 500 payment VUs; contention is per-invoice (row lock), not global |
| **SMS throughput** | **10,000 SMS cleared in < 30 min** | k6 enqueues 10k; measured via BullMQ queue drain + `SmsLog` timestamps |
| **Report generation** | **Always async** (PDF → 202 + document) | Report PDFs are queued; API returns 202, never blocks the request thread |
| **Upload size** | **≤ 10 MB** | Enforced by the S3 upload policy (not just the app) |
| **Dashboard read** | Served from a 5-min Redis cache | Cache hit ratio metric; invalidated on payment/attendance writes for the affected school |
| **Attendance bulk write** | One `INSERT … ON CONFLICT` statement | No N+1; absence-SMS guardian fetch is batched (one query per section submission) |

**Load profile (`k6`, in-repo, runs before each major release):** simulates fee-season peak = **500 payment VUs + 10k SMS enqueue** (§30). Pre-release gate.

**Query/perf design notes (§30) that these targets rely on:**
- Stored `paid_amount` on the invoice avoids per-read payment aggregation.
- Defaulters query covered by the `(school_id, status, due_date)` index.
- Trigram GIN index (`pg_trgm`) backs student name search.
- Report PDFs always queued; never synchronous.

---

## 2. Scalability & Capacity

### 2.1 Data growth assumptions
| Dimension | Planning figure | Basis |
|---|---|---|
| Students per school | **200–3,000** | Target market (§1) |
| Campuses per school | 1–several | Multi-campus is core |
| Schools per platform | 1,000+ (pooled tenancy chosen to survive this) | Rejected schema-per-tenant specifically to avoid migration fan-out at 1,000+ schools (§2) |
| Highest-growth tables | `attendance_records`, `sms_logs`, `audit_logs` | Monthly-partitioned from day one (§30) |

### 2.2 Connection pool sizing
- **Formula:** `(2 × vCPU) + spare` per app instance (§30).
- **Pool-exhaustion alerting** required; alert when pool > 90% (see §5).
- **Ops constraint:** the tenant-isolation mechanism relies on transaction-local `set_config`. If **PgBouncer** is introduced, it must run in **session pooling** mode for these connections (or be bypassed) — transaction-local settings require connection affinity (§21.4).

### 2.3 Redis cache strategy
| Cache | TTL | Invalidation | Notes |
|---|---|---|---|
| **Tenant resolution** `tenant:{host}` | **60 s** | **Explicit `DEL`** on suspend/reactivate/domain-change (event hook), *plus* TTL | `isActive` re-checked from cached value every request; suspend → 403 on the **next** request, not after TTL (integration-tested) |
| **Dashboard payload** per (school, campus, role-shape) | **5 min** | Invalidated on payment/attendance writes **only for the affected school** | Avoids per-read aggregation |
| **Access-token denylist** (disable/downgrade) | = access-token life (15 min) | expires with TTL | Checked by the auth guard |

Redis is **ephemeral by design** — nothing recovery-critical lives only in Redis.

---

## 3. Availability & Reliability

| Metric | Target | Mechanism |
|---|---|---|
| **Uptime** | **99.9%** | ECS Fargate multi-AZ; ALB; blue/green deploys |
| **RPO** | **≤ 30 min** | RDS PITR at **5-min** granularity |
| **RTO** | **≤ 4 h** | Documented restore runbook (§33.4); repoint application DB endpoint |
| **Backups** | RDS automated **35 d** + PITR 5-min; daily snapshot to a **second AWS account**; S3 versioning + cross-region replication + MFA-delete | Weekly automated **restore-verify** job (`db-backup-verify`) — pages on failure |
| **Zero cross-tenant exposure** | Hard requirement | CI-enforced isolation suite (§6.1) |

### 3.1 Partitioning & archival
| Table | Partitioning | Archive / rotate |
|---|---|---|
| `attendance_records` | Monthly (from day one) | `attendance-archive` moves partitions **> 2 years** to cold storage (monthly job) |
| `sms_logs` | Monthly | `sms-log-purge` deletes **< 90 d** retained window (nightly) |
| `audit_logs` | Monthly | `audit-log-rotate` rotates partitions **> 3 years** (annual) |

### 3.2 Job reliability
All BullMQ jobs: `attempts: 3` default, **dead-letter queue monitored** (DLQ nonzero → page). Every job payload carries `schoolId` (or is a platform job on `platformPrisma`); workers open `withTenant` per unit. Idempotency keys per job (§27): e.g. `absence:{enrollmentId}:{date}`, `rc:{termId}:{enrollmentId}`, batch/payroll unique tuples.

---

## 4. Rate-Limiting Spec

Redis **sliding window** (§29). All limit breaches return **429 + `Retry-After`**. Repeated **tenant-level** limit hits raise an alert (compromise indicator).

| Scope / endpoint | Limit | Window | Rationale |
|---|---|---|---|
| Login (per IP) | **5** | 15 min | Brute-force resistance; sits beneath account lockout |
| Login (per user) | **10** | 1 h | Per-account brute-force cap |
| Refresh (per user) | **60** | 1 h | Normal rotation headroom |
| Parent reads (per user) | **600** | 1 h | Raised from 300 to absorb result-day traffic |
| Manual SMS (per school) | **100** | 1 h | Abuse cap on manual sends |
| SMS recipients (per school) | **10,000** | 1 day | Daily blast ceiling |
| Public endpoints (per IP) | **60** | 1 min | DDoS/abuse guard on unauthenticated routes |
| Authenticated default (per user) | **600** | 1 min | Catch-all for all other authenticated routes |

**Interaction with lockout:** rate limits apply **beneath** account lockout (§22.3) — 10 consecutive login failures → `status=LOCKED`, `lockedUntil = now()+15min` (self-heals); rate limits still gate attempt velocity independently.

---

## 5. Observability Requirements

### 5.1 Log schema (Pino JSON)
Structured fields on every log line: `requestId`, `schoolId`, `userId`, `route`, `latencyMs`. Correlation ID propagated **HTTP → service → Prisma → BullMQ**.

**Global redaction list (PII never logged):** `password`, `cnic`, `authorization`, `token`, `phone`, `bankAccount`. Sinks: CloudWatch / Loki.

### 5.2 Metrics (Prometheus)
| Category | Metrics |
|---|---|
| **Golden signals** (per route) | latency (P50/P95/P99), traffic, errors (rate), saturation |
| **Business metrics** | collections/hour/tenant, SMS queue depth & failure rate, active users/school, **guard-denial counters**, **per-tenant rate-limit hits** |

Grafana: dashboards per functional area **+ a per-tenant health meta-dashboard**.

### 5.3 Tracing & exception tracking
- **OpenTelemetry** traces across HTTP, Prisma, BullMQ, and outbound gateways → **Jaeger**.
- **Sentry** for exception tracking (release-tagged).
- **Synthetic uptime check** hits `/health/ready` + one read flow per minute. Health endpoints reveal nothing internal.

### 5.4 Alert thresholds (§31)
| Condition | Action |
|---|---|
| 5xx > **1% / 5 min** | **Page** |
| P95 > **1 s / 10 min** | **Page** |
| Queue depth > **5k / 15 min** | **Page** |
| **DLQ nonzero** | **Page** |
| Any **`TENANT_VIOLATION`** log line | **Page** (security incident; runbook §33.4, maintenance-mode flag bypasses tenant cache) |
| `fee-integrity-check` mismatch | **Page** |
| Connection pool > **90%** | **Page** |
| Failed-SMS > **10% / 30 min** | Notify |
| RDS disk > **80%** | Notify |

---

## 6. Security NFRs

| Requirement | Cadence / gate | Mechanism |
|---|---|---|
| **Zero cross-tenant exposure** | **Every PR (merge-blocking)** | Tenant-isolation suite (§6.1) — failing blocks merge |
| **Penetration test** | M7 hardening milestone + ongoing | Pen test before GA (§34 roadmap M7) |
| **DR drill** | **Quarterly restore drills; annual full failover drill** | §33.4 runbooks; blameless post-mortems ≤ 5 business days |
| **Access review** | **Quarterly** | Break-glass/`platform_admin` session reviews (§22.9) |
| **Backup restore verification** | **Weekly** | `db-backup-verify` restores latest snapshot to scratch + smoke test; pages on failure |
| **Key rotation** | **Annual** | KMS re-wrap of per-tenant data keys (§32) |
| **Signing-key rotation** | **Quarterly** | Two JWT signing keys active, selected by `kid` (§22.1) |

### 6.1 Tenant-isolation suite (the CI gate for "zero cross-tenant exposure")
Seeds **School A** + **School B**; asserts:
1. Every list/read/write endpoint with A's token against B's rows → **403/404/empty**.
2. Raw-SQL probe inside `withTenant(A)` selecting B's rows → **0 rows** (valid because `set_config` and query share a transaction).
3. `create`/`update` setting **B's `schoolId`** → rejected by **both** the Prisma extension **and** RLS `WITH CHECK` (one variant toggles the extension off to prove RLS alone holds).
4. Any production `TENANT_VIOLATION` log → pages on-call.

**Failing this suite blocks merge.**

### 6.2 CI order (§34)
`lint → unit → integration → isolation → matrix-conformance → build → staging deploy → E2E → manual promote to prod`. The **isolation** and **matrix-to-route conformance** stages are both hard gates.

---

## Changelog
- **v1.0** — Initial NFR document. Derived from blueprint v2.0 §29–§33, §21.6, §34 and Consistency Register v1.0. Covers performance targets, scalability/capacity, availability/reliability, rate-limiting, observability, and security NFRs.
