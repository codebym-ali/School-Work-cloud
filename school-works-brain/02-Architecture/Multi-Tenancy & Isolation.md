---
title: Multi-Tenancy & Isolation
type: architecture
updated: 2026-07-06
---

# Multi-Tenancy & Isolation

**Pooled multi-tenancy**: one database, shared schema, every tenant row carries `school_id`. This is the system's highest-stakes concern — a leak here is SEV-1 by definition.

## Three independent layers (defense in depth)
1. **Application** — a Prisma **client extension** injects/asserts `schoolId` on every operation. Missing context ⇒ throw (fail-closed). Cross-tenant `schoolId` in a write ⇒ `TenantViolationError`.
2. **Database** — **RLS `FORCE`** on every tenant table. Policy: `school_id = current_setting('app.current_school_id')::uuid`. Unset GUC → NULL → **zero rows** (fail-closed). `app_user` has **no BYPASSRLS**; only `platform_admin` does (vendor/analytics/export only).
3. **CI** — a **merge-blocking tenant-isolation suite** seeds two schools and asserts every cross-tenant access fails; plus an **RLS-coverage grep** that fails if any `school_id` table lacks a policy.

## The transaction binding (§21.4) — the subtle part
`SET LOCAL`/`set_config(…, true)` only works if the GUC and the queries share one transaction on one connection. So every request wraps handler DB work in an interactive tx that first runs `set_config('app.current_school_id', $schoolId, true)`. If PgBouncer is ever added it must run in **session pooling** for these connections.

## Tenant resolution (§21.1)
Host → (1) exact custom domain, (2) subdomain of the apex, (3) else 404. Reserved labels (`www`, `api`, `admin`, `app`) never resolve. Cache `tenant:{host}` TTL 60s **plus** explicit invalidation on suspend/reactivate/domain-change. Suspended → **403 TENANT_SUSPENDED** (truthful), not 404.

## Tenant-chain integrity (§17)
Child rows carry a composite FK `(parentId, schoolId)` → parent's `@@unique([id, schoolId])`, so the DB itself guarantees the tenant chain is consistent — a child can't reference a parent in another tenant.

## Single-tenant restore (the pooled trade-off)
Pooled tenancy makes single-tenant restore non-trivial; the `tenant-export` job (dump all `WHERE school_id = X` to JSONL on R2) is both the customer export and the restore input. → [[Deployment & Operations]].

**Source:** [[06-security-compliance-specification]], blueprint §2, §19–§21.
**Implementation status:** ✅ built and green (M1). Isolation suite + RLS-coverage are gates on every commit → [[Progress Tracker]].
