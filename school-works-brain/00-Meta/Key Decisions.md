---
title: Key Decisions
type: meta
updated: 2026-07-06
---

# Key Decisions

The locked, cross-cutting decisions every note and every developer must respect.
Full ledger: [[consistency-register]] (LOCKED). This is the digest.

## Architecture & tenancy
- **Pooled multi-tenancy**: one Postgres, shared schema, every tenant row carries `school_id`. Isolation via 3 layers → [[Multi-Tenancy & Isolation]].
- **Modular monolith**: one codebase, two deployables (`api` + `worker`); modules talk through exported services.
- **snake_case** in the DB (every `@@map`/`@map`), **camelCase** in code. UUID PKs. Money = `Decimal(12,2)`.
- Relations default `onDelete: Restrict`; `Cascade` only on pure child tables (invoice items, guardian links). **No hard cascade delete exists in the product.**

## The 20 immutable business rules
Copy verbatim from [[consistency-register]] §6. The load-bearing ones:
1. **Students are never linked to a section directly** — always via an enrollment scoped to an academic year. → [[Enrollment & Admissions]]
2. One ACTIVE enrollment per student per year; one `isCurrent` year per school; one `isPrimary` guardian per student (partial uniques).
3. **Moves are new rows** (TRANSFERRED_OUT closes + creates), never destructive updates.
4. **Admit is one transaction** (guardian + student + enrollment + admission + admission invoice).
5. Guardian resolution **never auto-merges** — explicit link-or-create.
6. Bulk attendance = **partial-failure** `{succeeded, failed, errors[]}`, not all-or-nothing. → [[Attendance & Leaves]]
7. Absence SMS: ABSENT only, primary guardian, once per (student, date), never for ON_LEAVE.
8. Grades are **derived at read/publish** from the active scale (no stored grade). → [[Exams & Report Cards]]
9. Term exam weightages must sum to 100 before report cards generate.
10. **Payments are immutable**; corrections via PaymentReversal (OWNER_ADMIN only). → [[Fees & Payments]]
11. Payment endpoint needs `Idempotency-Key` + serializable tx + `SELECT … FOR UPDATE`.
12. Invoice generation idempotent on `[schoolId, classId, month, year]`.
13. **RLS FORCED** on every tenant table; unset GUC → NULL → zero rows (fail-closed). Only `schools` isn't RLS'd.
14. Suspended tenant → **403 TENANT_SUSPENDED** (a truthful page), not 404.

## Security invariants
- Tokens in **httpOnly/Secure/SameSite=Strict cookies** + **CSRF double-submit** on writes. → [[Security & Compliance]]
- **MFA mandatory** for OWNER_ADMIN & ACCOUNTANT.
- OWNER_ADMIN-only: reversals, waivers, post-publish mark change, promotion-precondition override, LEAVING_CERT fee-clearance override.
- Field-level AES-256-GCM for `cnic`, `bank_account`, `mfa_secret`. PII never logged.

## API conventions
- Base `/api/v1`, JSON, JWT-cookie, tenant-scoped. → [[API Contract]]
- Error envelope: `{ error: { code, message, details[], requestId } }`; codes from `error-codes.ts`.
- Status codes, pagination (default 25 / max 100), `Idempotency-Key` on payments/reversals/advances/manual-SMS — see [[consistency-register]] §8.
- Tenant addressing by subdomain `{slug}.platform.pk`; vendor console at `admin.platform.pk`.

## Locked catalogs (do not re-order / rename)
- **24 enums**, **48 model→table maps**, **14 error codes**, **15 audit actions**, all magic numbers → [[consistency-register]].

## Our stack deviation (approved)
Blueprint's AWS reference (RDS/ECS/S3/KMS…) is replaced by **Contabo + Coolify + self-hosted Postgres + Cloudflare R2**. App code is unchanged; only infra differs. → [[Deployment & Operations]]

**Source:** [[consistency-register]] · [[school-management-master-blueprint]] §2–§34
