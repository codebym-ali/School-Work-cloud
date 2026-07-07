---
title: API Contract
type: api
updated: 2026-07-06
---

# API Contract

Base `/api/v1`, JSON, JWT-cookie auth, tenant-scoped. OpenAPI is generated from code; the frontend client is generated from OpenAPI (contract drift impossible). Full conventions: [[consistency-register]] §8.

## Envelope & errors (§25.1)
- Success: resource JSON, or `{ data, total, page, pageSize }` for lists.
- Error (all non-2xx): `{ error: { code, message, details: [{field, issue}], requestId } }`. Codes are stable strings from `error-codes.ts`. *(Our impl adds `requestId`.)*
- Status codes: 200 read/replay · 201 create · 202 queued · 204 delete · 400/401/403/404 · **409** conflict/state · **422** validation/business-rule · 429 rate-limited · 5xx.

## Pagination, filtering, idempotency, concurrency
- Lists: `page` (1-based), `pageSize` (default 25, **max 100**), allowlisted `sort`; unknown query params rejected.
- **`Idempotency-Key` required** on: payments, reversals, advances, manual SMS send. Replay same hash → stored response; same key/different hash → `IDEMPOTENCY_KEY_REUSED`.
- **Bulk = partial-failure**: `{ succeeded, failed, errors[] }` (attendance, marks, imports), unless stated transactional (invoice batches, promotions).
- Payments: serializable tx + invoice row lock (§25.5). → [[Fees & Payments]].

## Permission matrix (§23)
The authoritative C/R/U/D-per-role grid. **A CI matrix→route conformance test** proves every non-`—` cell has an enforced route (matrix and API can't drift). Row-level scope via the [[Security & Compliance|§22.8 guards]].

## Endpoint inventory (§24)
Grouped: Auth · Setup · Users & staff · Admissions · Students · Enrollment · Attendance · Leaves · Exams · Fees · Payroll · Communication · Documents · Dashboards & reports · Audit · Vendor console. Public (no-JWT) routes are exhaustive — [[consistency-register]] §8.

## Tenant addressing
Subdomain `{slug}.platform.pk` or verified custom domain; vendor console at `admin.platform.pk`. Timezone Asia/Karachi (v1).

**Source:** blueprint §23–§25, [[consistency-register]] §8.
**Implementation status:** conventions, envelope, guards, idempotency ✅ (M1); endpoints land per milestone (Auth/Setup/Students/Admissions/Enrollment/Attendance/Leaves/SMS done). No OpenAPI explorer wired yet → [[Progress Tracker]].
