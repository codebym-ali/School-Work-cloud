# Testing & Quality Strategy — v1.0

**Product:** Multi-Tenant School Management System
**Document:** 09 — Testing & Quality Strategy
**Audience:** QA Leads · SDETs · Engineers
**Authority:** Conforms to `docs/consistency-register.md` (v1.0, LOCKED) and `school-management-master-blueprint.md` (v2.0) §34 (process), §21.6 (isolation suite), §23 (matrix), §30 (load), §33 (SEV), Appendix A/B/C. Where this document would conflict with the register, the register wins.

**Worked-number note:** The numeric fixtures in §2.1 are **illustrative** worked examples derived from the §11–§13 formulas. Appendix C of the blueprint mandates the *final* verbatim fixtures with signed-off expected numbers; QA owns turning these into the locked `Appendix-C` test data.

---

## 1. Testing Pyramid & CI Order

CI order is authoritative (§34). Two stages are **merge-blocking**: the tenant-isolation suite and the matrix-to-route conformance test.

```
lint → unit → integration → isolation (BLOCK) → matrix-conformance (BLOCK) → build → staging deploy → E2E → manual promote to prod
                                                                                              (+ load, pre-release)
```

| Layer | Tooling | Owner | Runs |
|---|---|---|---|
| Unit | Jest | Engineers | Per PR |
| Integration | Supertest + ephemeral Postgres/Redis containers | Engineers | Per PR |
| **Tenant-isolation** | Jest/Supertest, 2-school fixture | Engineers + QA | **Per PR (blocks merge)** |
| **Matrix conformance** | Automated checklist vs OpenAPI routes | QA | **Per PR (blocks merge)** |
| E2E | Playwright | SDETs | On staging, pre-promote |
| Load | k6 | Performance eng | Before each major release |

---

## 2. Unit Tests

Cover **every state machine**, the **fee/payroll/grading formulas**, and the discount/fine/reversal math — using the worked-example fixtures (Appendix C).

### 2.1 Worked-example fixtures (illustrative — finalize as Appendix C)

**(a) Term-result computation incl. an absent exam** (§11 formula: `termPercent = Σ (marksObtained/totalMarks × weightagePercent)`; overall = mean of subject termPercents; dense rank).

Term 1 has two exams: **Midterm (weight 40)**, **Final (weight 60)**.

| Student | Subject | Midterm | Final | termPercent | Note |
|---|---|---|---|---|---|
| A | Math | 30/50 | 70/100 | (0.60×40)+(0.70×60) = **66.00** | present both |
| A | English | 40/50 | 80/100 | (0.80×40)+(0.80×60) = **80.00** | present both |
| B | Math | **ABS** | 70/100 | (0×40)+(0.70×60) = **42.00** | absent Midterm → contributes 0; prints "ABS" |
| B | English | 45/50 | 90/100 | (0.90×40)+(0.90×60) = **90.00** | present both |

- **Overall** = mean of subject termPercents. A = (66.00+80.00)/2 = **73.00**; B = (42.00+90.00)/2 = **66.00**.
- **Dense rank** by overall within the section: A=1, B=2. (Ties share rank: 1,1,3. A student absent from **all** exams is **unranked**.)
- **Grade** is computed from the active `GradeScale` at read/publish — there is **no stored grade** column.

**(b) Payroll deduction month** (§13: `gross = basic + Σ allowances`; `attendanceDeduction = (unpaidLeaveDays + unexcusedAbsentDays) × (basic / workingDaysInMonth)`; `netPay = gross − fixedDeductions − attendanceDeduction`).

| Field | Value |
|---|---|
| basic | 50,000.00 |
| allowances | House Rent 10,000.00 → **gross = 60,000.00** |
| workingDaysInMonth (excl. holidays/weekly-offs) | 22 |
| unpaidLeaveDays + unexcusedAbsentDays | 1 + 1 = 2 |
| attendanceDeduction | 2 × (50,000 / 22) = **4,545.45** |
| fixedDeductions | 2,000.00 |
| **netPay** | 60,000 − 2,000 − 4,545.45 = **53,454.55** |

**(c) Fee invoice: sibling discount + fine + partial payment + reversal** (§12; discounts at generation time as negative line items; FIXED after PERCENT; fine appended by `mark-overdue`; payments immutable, corrections via reversal).

| Step | Line item(s) | Running invoice |
|---|---|---|
| Generate | Tuition **+10,000.00**; Sibling discount (10%, PERCENT) **−1,000.00** | total = **9,000.00**, paidAmount 0, status **PENDING** |
| Overdue (nightly `mark-overdue`, past `dueDate+graceDays`) | FINE (FLAT) **+500.00** | total = **9,500.00**, status **OVERDUE** |
| Payment #1 (`Idempotency-Key`) | FeePayment amountPaid **5,000.00** | paidAmount = 5,000.00, status **PARTIAL**, remaining 4,500.00 |
| Reversal (OWNER_ADMIN, `RV-{n}`) | PaymentReversal of the 5,000.00 | paidAmount = `Σpayments − Σreversals` = **0.00**, status recomputed → **OVERDUE** |

Invariants asserted at each step: `totalAmount = Σ items.amount`; `paidAmount = Σ payments − Σ reversals`; `paidAmount ≤ totalAmount`.

### 2.2 State-machine transition tests (assert allowed transitions + rejection)
| Machine | Must-pass assertions |
|---|---|
| `InquiryStatus` | Every arrow in §8 passes; any other → **409 `INVALID_STATE_TRANSITION`**; REJECTED/WITHDRAWN require `reason`; direct admit and admin-override-admit-from-FAILED allowed |
| `EnrollmentStatus` | ACTIVE → each terminal; TRANSFERRED_OUT closes old (`endedAt`) + creates new ACTIVE (no field mutation) |
| `ExamStatus` | DRAFT→MARKS_ENTRY→PUBLISHED; publish blocked by completeness gate (**422 `RESULTS_INCOMPLETE`** + missing list); post-publish edit = OWNER_ADMIN + reason + regen + "Corrected" SMS |
| `FeeInvoiceStatus` | PENDING↔PARTIAL→PAID; job→OVERDUE; →WAIVED terminal; PAID reopened only by reversal |
| `LeaveStatus` | PENDING→APPROVED/REJECTED; CANCELLED only while PENDING by requester; overlap → **409 `LEAVE_OVERLAP`**; REJECT needs `rejectionReason` |

### 2.3 Formula/rule edge cases
- Weightage sum ≠ 100 → **422 `WEIGHTAGE_SUM_INVALID`** (listing the sum).
- `marksObtained > totalMarks` → 422; `isAbsent=true` ⇒ `marksObtained IS NULL` (DB CHECK).
- Overpayment (`amountPaid > remaining`) → **422 `OVERPAYMENT_USE_ADVANCE`**.
- Discount cap: total discount ≤ 100% of the head; FIXED applied after PERCENT.
- Absence SMS: fires for ABSENT only, deduped `absence:{enrollmentId}:{date}`, never for ON_LEAVE/opt-out/unverified.

---

## 3. Integration Tests

Supertest against the running app with **ephemeral Postgres/Redis containers** per PR.

- **Module boundaries:** assert modules interact only through exported services (the ESLint boundary rule is the static gate; an integration test verifies runtime wiring for cross-module flows like admit→fees).
- **Prisma extension behavior** (§20): per-operation scoping is exercised —
  - `findMany/findFirst/count/aggregate/groupBy` → `schoolId` merged into `where`.
  - `findUnique` → rewritten to `findFirst` with `schoolId`.
  - `create/createMany` → `schoolId` injected; supplying a different `schoolId` → `TenantViolationError`.
  - `update/updateMany/delete/deleteMany/upsert` → `schoolId` merged into `where` (and upsert `create` arm).
  - **Missing `cls.schoolId` on a tenant-scoped model → throws (fail-closed).**
- **Idempotency (§25.4):** same key + same hash → replay (200); same key + different hash → **409 `IDEMPOTENCY_KEY_REUSED`**; verified on payments, reversals, advances, manual SMS.
- **Bulk partial-failure (§25.3):** attendance/marks/imports return 200 `{succeeded, failed, errors[]}` (not all-or-nothing).
- **Concurrency:** two concurrent payments on one invoice serialize via `SELECT … FOR UPDATE`; no double-spend; receipt numbers gap-free.

---

## 4. Tenant-Isolation Suite (merge-blocking)

Seeds **School A** and **School B** with full fixtures. **Failing this suite blocks merge.** (§21.6)

| # | Test case | Expected |
|---|---|---|
| ISO-1 | Every list/read endpoint with **A's token** targeting **B's rows** | 403 / 404 / empty (404 and cross-tenant are indistinguishable by design) |
| ISO-2 | Every write endpoint with A's token mutating B's rows | 403 / 404; no mutation |
| ISO-3 | Raw-SQL probe inside `withTenant(A)` selecting B's rows | **0 rows** (valid because `set_config` + query share one transaction) |
| ISO-4 | `create`/`update` attempting to set **B's `schoolId`** — extension ON | rejected by the Prisma extension (`TenantViolationError`) |
| ISO-5 | Same as ISO-4 with the **extension toggled OFF** | rejected by **RLS `WITH CHECK`** alone (proves DB layer holds independently) |
| ISO-6 | Request with **no tenant context** (missing `cls.schoolId`) on a tenant model | throws (fail-closed); NULL `current_setting` → 0 rows |
| ISO-7 | Suspended tenant, next request | **403 `TENANT_SUSPENDED`** within one request (cache `DEL`, not TTL) |
| ISO-8 | Any `TENANT_VIOLATION` log line produced in test/prod | pages on-call (alert wired) |

---

## 5. Matrix-to-Route Conformance (merge-blocking)

Automated checklist mapping **every non-`✗` cell in the §23 permission matrix** to at least one route test, so the matrix and the API cannot drift (fixes audit H-5's root cause).

- For each `(module, role, action)` cell that is not `✗`, assert **≥ 1 endpoint** exists (from §24) and a positive test exercises it under the correct role.
- For scoped cells, assert the **ownership guard** enforces the boundary (negative test): e.g. CAMPUS_ADMIN outside own campus → 403 (**CampusScopeGuard**); TEACHER marks for a non-assigned subject → 403 (**SubjectOwnershipGuard**); PARENT reading a non-linked child → 403 (**GuardianOfStudentGuard**); STUDENT/STAFF reading another's resource → 403 (**SelfGuard**).
- `✗` cells get a **negative** assertion: the role is denied (403).

---

## 6. E2E (Playwright)

Golden-path journeys run on **staging** before manual promote (§34). Each maps to a milestone exit.

| Journey | Steps |
|---|---|
| **Admit** | Inquiry → (entry test) → admit with **guardian link-or-create** → Student + ACTIVE enrollment + admission invoice |
| **Collect fee** | Fee counter → open invoices → collect (Idempotency-Key) → **printed receipt** → receipt SMS enqueued |
| **Mark attendance** | Teacher marks section → ON_LEAVE cells locked → absence SMS for ABSENT; cross-teacher diff → conflict banner |
| **Enter + publish marks** | Teacher enters marks (assigned subject) → admin publish (completeness gate) → results visible to parent |
| **Parent views report card** | Children switcher → published results → 10-min pre-signed PDF download |
| **Promote** | Create next year → promotion grid → precondition warnings → 202 batch → progress complete |

Global UX assertions on every screen (§28): loading skeleton, empty state, error+retry, destructive-action confirm with reason, WCAG 2.1 AA, Asia/Karachi times.

---

## 7. Load (k6, pre-release)

k6 profile in-repo (§30) simulating **fee-season peak**: **500 payment VUs + 10k SMS enqueue**. Assert against NFRs:
- P95 read < 300 ms, P95 write < 600 ms (excl. async).
- 500 concurrent payments succeed without double-spend (per-invoice contention, not global).
- 10k SMS cleared **< 30 min** (queue drain + `SmsLog` timestamps).
- Connection pool stays under saturation; pool-exhaustion alert not tripped.

---

## 8. Test Data Strategy

| Asset | Definition |
|---|---|
| **Fixture factories** | One per module (`admissions`, `students`, `fees`, `exams`, `hr`, `comms`, `documents`) producing valid tenant-chained rows (`(parentId, schoolId)` consistent); factories always set `schoolId`. |
| **Demo tenant seed** | Script seeds staging with prod-shaped **demo tenants** (§33): School A + School B, campuses, years, classes/sections/subjects, users per role, fee heads/structures, grade scale, SMS templates, SMS credit grant. |
| **Isolation fixture** | Dedicated 2-school seed for §4 (A and B never share any id). |
| **Appendix-C fixtures** | The three worked examples (§2.1) become locked fixtures with signed-off expected numbers; used verbatim in unit tests. |
| **Staging data hygiene** | Any production-like data loaded to staging is **anonymized** first (name → `REDACTED-{shortid}`, DOB → year-only, phone/CNIC/photo nulled) — mirrors the §32 right-to-erasure job; **PII never lands in a lower environment**. |

---

## 9. Quality Gates

### 9.1 PR review checklist (§34)
- [ ] **Tenant scoping:** new model added to the **RLS migration** + isolation tests? (`school_id` CI grep must pass)
- [ ] **Authz guard on every new route?** (RolesGuard + the correct §22.8 ownership guard)
- [ ] **AuditLog on sensitive mutations?** (action registered in `audit-actions.ts`; old→new + reason)
- [ ] **`$queryRaw` justification** present (no string interpolation of tenant vars)
- [ ] **Error codes registered** in `error-codes.ts` (and surfaced in OpenAPI)
- [ ] **OpenAPI updated** (typed client regenerates; contract drift impossible)
- [ ] Conventional commit; module-boundary lint green

### 9.2 Definition of Done
**Code + tests + OpenAPI updated + docs touched.** A story doesn't enter a sprint without acceptance criteria (the state machines and rules **are** the criteria, e.g. "given an OVERDUE invoice, when payment covers remaining, then status PAID and fine line unchanged"). A milestone exits only with its E2E journeys **green on staging**.

---

## 10. Bug Severity Definitions (§33 SEV classification)

| Severity | Definition | Examples | Response |
|---|---|---|---|
| **SEV-1** | Security/financial integrity breach or data loss risk | **Cross-tenant isolation breach** (`TENANT_VIOLATION`); **payment double-spend**; `fee-integrity-check` mismatch; PII leak (SMS to wrong/unverified number); DLQ nonzero for a critical queue | **Page immediately**; incident + blameless post-mortem ≤ 5 business days; isolation-breach runbook (§33.4, maintenance-mode bypasses tenant cache) |
| **SEV-2** | Core feature broken, no data-integrity risk | Cannot collect a payment; publish blocked incorrectly; attendance save failing; report card generation failing | Fix within the sprint; hotfix if in production |
| **SEV-3** | Minor / cosmetic | UI polish, copy, non-blocking empty-state wording, alignment | Backlog; batched into normal work |

> **QA rule:** anything touching tenant isolation, immutable payments/reversals, or PII delivery is **SEV-1 by default** until proven otherwise — these are the failure modes with the worst blast radius and are individually alertable in production.

---

## Changelog
- **v1.0** — Initial Testing & Quality Strategy. Derived from blueprint v2.0 §34, §21.6, §23, §30, §33, Appendix A/B/C and Consistency Register v1.0. Covers the CI pyramid, worked-example fixtures, isolation + matrix-conformance suites, E2E journeys, load profile, test data strategy, quality gates, and SEV definitions.
