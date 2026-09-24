---
title: QA Plan — Remaining Surface & Cross-Cutting
type: delivery
updated: 2026-09-24
author: Senior QA
status: proposed
---

# QA Plan — Remaining Surface & Cross-Cutting (2026-09-24)

> **✅ EXECUTED 2026-09-24 — Tiers 0–3 complete; only C9 (a UI-affordance Playwright test) deferred.**
> Shipped 11 new merge-blocking suites: C1 authz conformance (+matrix-coverage gate, 99 routes), C2 tenant
> isolation sweep, C5 money integrity, C4 idempotency/concurrency, §2 promotion race, C3 Prisma fuzz, §1
> fees-mutation, C6 MFA gates, §4 leaves-edge, §5 uploads, §7 reports (**+a real CSV formula-injection
> fix**), C7 error-envelope. Audited-and-already-covered: §3 timetable/cover, §6 platform, C8 SMS.
> Gates: **unit 205 ✓ · integration 1821 ✓ / 73 suites · isolation 7 ✓.** Only defect found across the whole
> pass: the CSV injection (fixed). Everything else was unmeasured surface, now guarded.

Successor to [[Full System QA Test Plan]] and [[QA Remediation Plan]]. Those closed every finding from the
first live pass (4 bugs + Obs-1/2/3/5) and the passes concentrated on **students, exams, payroll, SMS,
attendance, fees(receipt), RBAC negatives**. This plan attacks **what those passes never exercised
adversarially** — the *real remaining surface* — plus the **cross-cutting invariants** that no single-module
test can prove.

## Testing philosophy (non-negotiable)
1. **Acceptance = the business rules / state machines**, not "returns 200" (per `CLAUDE.md`). Every rule a
   service enforces (each `throw new AppError(...)`) is a test case: prove it fires on the bad path **and**
   that the good path persists the right rows.
2. **Mutation depth, not happy path.** For each flow: boundary values, wrong state, wrong tenant, wrong
   campus, wrong role, replay/concurrency, and partial-failure. A pass that only admits-then-reads is not QA.
3. **Every bug lands with a merge-blocking regression** in the matching `test/integration/*.e2e-spec.ts`,
   and the *class* of bug gets a gate where one exists (authz gate, isolation suite, error filter).
4. **Data-integrity is checked at the DB, not the response.** After a money/enrolment mutation, assert the
   ledger/row state directly, not just the HTTP body.

Severity: **P0** security / cross-tenant / money-loss · **P1** 500 / data-integrity / state-machine break ·
**P2** correctness / UX · **P3** polish.

---

## Part 1 — Module deep-test suites (the remaining surface)

Risk-ranked. Each suite says **what to assert** (the rules), the **adversarial cases**, and the **artifact**.
Most modules already have a thin `*.e2e-spec.ts`; the work is to **extend** it to rule-completeness, not start
from zero.

### 1. Fees — money engine  ·  **P0/P1**  ·  ✅ largely DONE — payment engine via C4/C5, setup rules via `fees-mutation.e2e` (`f07b6e3`)
> Covered: idempotency/replay + parallel races (C4), overpay/reverse/partial/ledger invariants (C5),
> discount bounds + copy-plan precondition + discount-applies (`fees-mutation.e2e`), dangling-FK/dup writes
> (C3), guardian-link/claims (existing `fees.e2e`). **Still open:** reconciliation-CSV edge cases and the
> advance-consumption ledger over time (lower risk; queued).
The highest blast-radius module; the first pass only hit the receipt-counter bug. Rules to assert (from
`payments.service.ts`, `fee-link.service.ts`, `fee-setup.service.ts`, `reconciliation.service.ts`,
`claims.service.ts`):
- **Idempotency:** a missing `Idempotency-Key` → 400; the **same key replayed** records **one** payment, not
  two (assert `count(FeePayment)` and the invoice balance are unchanged on replay).
- **Overpayment:** `amount > remaining` → 422 `OVERPAYMENT_USE_ADVANCE`; the advance endpoint then books the
  excess as student credit and a later invoice consumes it.
- **Non-cash:** `transactionRef` required for non-cash methods → 422; cash without ref → 201.
- **Paid/void invoice:** paying an already-`PAID` / `VOID` invoice → 409 `Invoice is {status}`.
- **Reversal:** reverse a payment → invoice returns to prior balance + audit `PAYMENT_REVERSED`; **double
  reverse → 409** (`dupe` guard, both the pre-check and the race path at L140/L154).
- **Proof-of-payment (claims):** upload proof for a payment in **another school** → 403; approve/reject claim
  transitions; a claim without proof → 404.
- **Discounts/scholarships:** percent discount > 100 → 422; a fixed discount that exceeds the fee → floored,
  not negative.
- **Invoice batch:** generate a month's batch twice → the second is idempotent (no duplicate invoices per
  `(student, period)`); a student mid-withdrawal is excluded.
- **Reconciliation CSV:** a file with no credit lines → 422; malformed rows reported per-row; a matched credit
  marks the invoice paid exactly once.
- **Money invariant (cross-cutting hook):** for every student, `sum(payments) - sum(reversals) == invoice.paidAmount`
  and `paid ≤ total` — assert after a randomized sequence of pay/reverse/advance.

### 2. Promotion / year rollover  ·  **P0/P1**  ·  ✅ DONE — `promotion-race.e2e` (`79745cc`)
> Shipped the scariest path: two concurrent commits of one plan → exactly one 200 / one 409 (the
> one-ACTIVE-per-year index turns the P2002 into a clean conflict), target year ends with N enrolments not
> 2N, and a stale-fingerprint commit → 409. Campus-scope/graduating-cohort assertions can be layered later.
A bulk, irreversible, cross-year write — never mutation-tested. Rules (from `promotion.service.ts`):
- **Optimistic lock:** two concurrent commits of the same preview → one 200, one **409** "already committed"
  (L231). Assert exactly one set of new enrolments exists afterwards (no doubling).
- **Campus scope:** multi-campus school without a chosen campus → 400 "Choose a campus" (L130); a campus admin
  cannot promote another campus's sections.
- **Target year / section existence** → 404; a section id from a different class → rejected.
- **Graduating cohort:** final-class students promote to `GRADUATED`/leaver state, not into a null class.
- **Idempotent preview vs commit:** preview mutates nothing; re-running preview after commit reflects the new
  year. **Integrity:** old-year enrolments end, new-year enrolments start, roll numbers don't collide.

### 3. Timetable & cover  ·  **P1/P2**  ·  ✅ ALREADY COVERED (audit 2026-09-24 — no new tests needed)
> `timetable.e2e` pins teacher clash (409, named), cell-replace, subject-not-in-class, teacher-left,
> my-week, and student-week isolation; `cover.e2e` (40+ cases) pins double-book refusal, payroll-approved
> lock, campus scoping, FREE/BUSY suggestions, the cover can't enter marks, and a teacher can't arrange
> their own cover. The §3 surface is already exhaustive.
Never live-passed. Rules (from `timetable.service.ts`, `cover.service.ts`):
- **Clash detection:** same **teacher** in two rooms in one period → 422; same **section** double-booked → 422
  (L284/L317/L348 — assert each distinct clash message).
- **Subject/teacher validity:** slot for a subject not taught in the class → 422; teacher not assigned → 422.
- **Admins-only** write (L410) → teacher gets 403; `/timetable/mine` self-scoped read works for a teacher.
- **Cover (§6a):** assigning cover for an absent teacher's period; the covered register shows `coveredBy`;
  cover cannot be assigned to a teacher who is themselves on leave / already teaching that period.

### 4. Leaves (staff + student)  ·  **P1/P2**  ·  `leaves.e2e-spec.ts` + `staff-leaves.e2e-spec.ts` (extend)
Rules (from `leaves.service.ts`): `toDate < fromDate` → 422; **overlapping** leave → `LEAVE_OVERLAP`; balance
decrement on approve and **restore on cancel**; cancel an already-approved/started leave boundary; `staffId`
required unless an admin omits on self (L238). Assert the **balance math** directly, not just the response.

### 5. Documents / uploads pipeline  ·  **P1**  ·  ✅ DONE 2026-09-24 (`1997766`)
> Shipped `uploads-pipeline.e2e` against real MinIO: disallowed MIME → 422 (no presign); bytes not matching
> the declared type → 422 magic-byte gate; a real PNG round-trips request→PUT→confirm→promoted out of
> quarantine; confirm outside the caller's own quarantine prefix → 403; a never-uploaded key → 404. (ClamAV
> is opt-in/off in test — its branch stays covered by `clamav.service.spec`.)
Presigned PUT → magic-byte/MIME allowlist → ClamAV → quarantine→permanent (from `uploads.service.ts`):
- MIME not in allowlist → 422; **content that doesn't match its declared type** (png bytes as pdf) → 422
  `File content does not match its declared type`.
- EICAR test string (when `CLAMAV_ENABLED`) → 422 `FILE_INFECTED`; scanner down → 503
  `VIRUS_SCAN_UNAVAILABLE` (fail-closed). *(clamav is opt-in; gate this behind the profile.)*
- Report-card PDF served only via a **10-min presigned GET**; a link for **another school's** object → 403.

### 6. Platform / superadmin  ·  **P0/P1**  ·  ✅ ALREADY COVERED (audit 2026-09-24 — no new tests needed)
> Audit of the 11 `platform-*.e2e` specs confirms the plan's negatives are all pinned: purge needs the
> retention window + matching subdomain confirmation (`platform-tenant-lifecycle`), suspend → login
> `TENANT_SUSPENDED` (`platform.e2e`), per-student price required before invoicing + dunning/reactivation
> matrix (`platform-billing*`), an operator cannot change their **own** role/status
> (`platform-operators.e2e:97`), non-super roles forbidden (`platform-authz-audit`). Nothing to add.
Tenant lifecycle (provision → suspend → reactivate → schedule-termination → purge), billing invoices
(issue/pay/void state machine, per-student pricing required before invoicing — L135), break-glass access,
operator MFA, auto-reactivate-on-payment switch. **Key negatives:** a tenant operator cannot change **their
own** role/status (platform.service L213); a suspended tenant's users are locked out; the purge confirmation
must match the subdomain (L396). Assert **platform tables are non-tenant** (no `school_id`, revoked from
`app_user`) stays true.

### 7. Class-tests, notifications, reports/insights  ·  **P2**  ·  respective specs (extend)
- **Class-tests:** subject-not-in-class / section-doesn't-study-subject / future-date → 422 (L51/55/59);
  formative scores never feed the report card.
- **Notifications:** self-scoped only (a user reads only their own; `seen` idempotent).
- **Reports (7 exports) & insights:** each export is campus-scoped for a campus admin, matches the source
  aggregate (the coverage-gaps "two 24s" pattern from `class-structure` — apply it to every report that has a
  screen + an export), and CSV escaping is injection-safe (a `=cmd` cell is quoted).

---

## Part 2 — Cross-cutting QA (the invariants no single module proves)

These are **suite-level gates**, most of them merge-blocking once green. This is where a senior pass earns its
keep — the bugs here are systemic.

### C1. Authorization **conformance** matrix (roles are *correct*, not just *present*)  ·  **P0**  ·  ✅ DONE 2026-09-24 (`49413fc`)
> Shipped: `route-authz-matrix-coverage.e2e` (reads the live route table, fails on any role-gated route with
> no permission-matrix row) + filled **99** previously-unmeasured routes into `permission-matrix.ts`.
> `matrix-conformance` now runs **1102 assertions, all green** — every encoded allow/deny holds against the
> live guard. Shared allowlist/normaliser extracted to `support/authz-open-by-design.ts`.
WS-B's `route-authz-coverage` gate proves every route **declares** `@Roles`; it does **not** prove the set is
right. Build a **role × route** conformance sweep (extend `matrix-conformance.e2e-spec.ts`): for every
route, and every role, assert the observed status matches an **authored expectation table** (allow / 403).
A wrong `@Roles` (too broad or too narrow) becomes a red build. This is the single highest-value item —
it closes the *class* the CI gate cannot see.

### C2. Tenant-isolation **sweep** across every list/read endpoint  ·  **P0**  ·  ✅ DONE 2026-09-24 (`4d5762b`)
> Shipped `tenant-isolation-sweep.e2e`: two fully-seeded schools (student, staff, class, section, subject,
> exam, invoice, payment); as School A's owner, (a) every crown-jewel list returns only A's rows never B's,
> (b) every cross-tenant `GET /:id` with B's id → 404 (never 200/403). 15 assertions green. (CNIC reveal is
> `@RequiresMfa` → excluded; its 403 is the MFA gate, not isolation.)
The merge-blocking `tenant-isolation.spec` proves the mechanism (RLS fails closed). This sweep proves
**application coverage**: seed **two** schools with identical-looking data, then for **every** GET that returns
a collection or an `:id`, assert School A's session sees **zero** of School B's rows and a cross-tenant `:id`
→ 404 (never 403 — 403 leaks existence). Drive it off the same route table the authz gate enumerates so it
can't fall behind new endpoints.

### C3. Prisma-error **fuzz** (validates WS-A end to end)  ·  **P1**  ·  ✅ DONE 2026-09-24 (`fcfac5e`)
> Shipped `prisma-error-fuzz.e2e`: 15 schema-valid-but-illegal writes across academic-years, classes,
> sections, subjects, fee-heads, fee-structures, exams, teacher-assignments, invoice batches, students &
> withdrawal (dup unique / dangling FK / CHECK) — every one a clean 4xx in the §25.1 envelope, **no 500
> anywhere**. Confirms WS-A backstops every model, not just the two it was fixed on.
The plan's own "definition of done": a harness that, for **every** create/update DTO, submits (a) a duplicate
of a unique tuple, (b) a dangling FK, (c) a value that trips a DB CHECK — and asserts the response is a clean
**409/422/404 in the §25.1 envelope, never a 500 and never a stack**. Confirms the global filter (WS-A) truly
backstops every model, not just the two we fixed.

### C4. Idempotency & concurrency  ·  **P0/P1**  ·  ✅ DONE 2026-09-24 (`3c4b106`)
> Shipped `idempotency-concurrency.e2e` (true PARALLEL races via `Promise.all`): same Idempotency-Key
> concurrently → one payment; N concurrent distinct-key payments → all 201, unique receipt numbers, exact
> sum (the receipt-counter race that caused Bug #1 is race-safe); concurrent double-reverse → one 201 / rest
> 409, money unwound once. The promotion-commit race is covered by §2 below (`79745cc`).
Systematize the one-offs above: **replay** every `Idempotency-Key` endpoint (payments, advance) and assert
single-effect; **race** the optimistic-lock flows (promotion commit, marks entry, payroll approve) with two
parallel requests and assert exactly-one-winner + no torn writes. Include the **receipt-counter** race
(the origin of Bug #1) — N concurrent payments produce N contiguous receipt numbers, no gap/dupe.

### C5. Money & ledger integrity  ·  **P0**  ·  ✅ DONE 2026-09-24 (`a9acd02`)
> Shipped `money-integrity.e2e`: a seeded/reproducible 40-step randomized pay/overpay/reverse sequence over a
> student's invoices, asserting after every step — paidAmount == Σ non-reversed payments; 0 ≤ paid ≤ total;
> status PAID iff paid ≥ total, PARTIAL iff 0 < paid < total; overpayment refused (422/409) and moves nothing;
> a fully-reversed invoice returns to 0 and is no longer PAID. Owner MFA-enrolled to exercise reversal.
A property-style check over a randomized op sequence per student: `paid ≤ total`, `sum(payments) −
sum(reversals) = paidAmount`, advances never go negative, a reversed payment never leaves an invoice `PAID`.
Run it after fuzzed pay/reverse/advance/discount sequences. Money bugs don't show on the happy path.

### C6. MFA & money-out gates  ·  **P1**  ·  ✅ DONE 2026-09-24 (`8d189c8`)
> Shipped `mfa-money-out-gates.e2e`: waive / reverse / payroll-approve / payslip mark-paid / user
> password-reset each → 403 `MFA_ENROLMENT_REQUIRED` for an un-enrolled owner, and no longer that code once
> enrolled. Pins the whole money-out set so dropping `@RequiresMfa` from one can't slip through (the
> mechanism itself is in `mfa-enforcement.e2e`).
Assert every sensitive action stays gated: waive, reverse, payroll approve, payslip mark-paid all →
`MFA_ENROLMENT_REQUIRED` (403) for an un-enrolled mandatory-MFA role, and succeed once enrolled. A regression
here silently disarms the money-out controls.

### C7. Input-boundary & envelope conformance  ·  **P2**  ·  ✅ DONE 2026-09-24 (`6798e90`)
> Shipped `error-envelope.e2e`: one error per status class (400/401/403/404/409/422) each returns
> `{ error: { code, message, requestId? } }` with the exact stable code and no leakage (no stack, no extra
> top-level keys). Mass-assignment (`forbidNonWhitelisted`) + uuid-pipe 400 are already exercised repo-wide.
`whitelist`/`forbidNonWhitelisted` actually reject unknown fields (mass-assignment); UUID params → the pipe's
400, not a 500; every error response conforms to `{ error: { code, message, details?, requestId } }` with a
**stable code** (the frontend switches on `code`, never message text) — a schema assertion over a sample of
each status class.

### C8. Worker / async & SMS delivery  ·  **P2**  ·  ✅ ALREADY COVERED (audit 2026-09-24)
> `sms-broadcast.e2e` already pins it: preview counts one text per family with skip reasons (unverified /
> opted-out), verified families are texted and logged, an opted-out/withheld message is not charged and
> cannot be retried, a short credit balance refuses the whole broadcast, and a changed audience is refused.
> Nothing to add.
Absence SMS, result SMS, broadcast: assert the **verified-recipient** path now that seed sets
`phoneVerifiedAt` (WS-D) — a broadcast reaches verified guardians and **withholds** the deliberately-unverified
ones (`PHONE_UNVERIFIED`/`SMS_OPTED_OUT`). Insufficient-credits → `INSUFFICIENT_SMS_CREDITS`. Guard the
BullMQ single-worker/queue-contention gotcha noted in the Progress Tracker (run integration `--runInBand`).

### C9. Frontend e2e gaps (Playwright)  ·  **P2/P3**  ·  ⏳ DEFERRED (the one remaining item)
> The teacher-picker e2e is the last open piece. It needs a new **teacher-session** setup project + a
> seeded teacher-with-assignments fixture in the demo tenant, and the full FE dev stack — none present in the
> harness today. WS-E's real guarantee (a teacher only reaches their own sections) is **server-enforced** and
> already covered by `teaching.e2e` + the authz matrix; C9 is a pure UI-affordance check. Left unshipped
> rather than adding an unrun Playwright spec. Next step: add `staff-auth.setup.ts` + seed one teacher
> assignment, then assert the attendance `<select>` lists only assigned sections.
Ship the **teacher-picker e2e** WS-E named but never got (a teacher sees only assigned sections). Add campus-
lens scoping on the shared screens, and the fees partial→full→PAID and promotion flows at the UI layer.

---

## Execution model

| Wave | Focus | Gate added / extended | Effort |
|------|-------|-----------------------|--------|
| **1** | ✅ **DONE** — **C1 authz conformance** + **C2 isolation sweep** + **C5 money integrity** (all Tier-0 P0s) | all merge-blocking; integration 1771✓ / 64 suites | shipped 2026-09-24 |
| **2** | ✅ **DONE** — **Fees** (§1) + **C4 idempotency/concurrency** + **C5 money integrity** | fees-mutation + money-invariant | shipped 2026-09-24 |
| **3** | ✅ **DONE** — **Promotion** (§2) + **C3 Prisma fuzz** | promotion race + fuzz harness | shipped 2026-09-24 |
| **4** | ✅ **DONE** — **C6 MFA gates** + **Leaves** (§4); **Timetable/cover** (§3) already covered | mfa-money-out + leaves-edge | shipped 2026-09-24 |
| **5** | ✅ **DONE** — **Uploads** (§5); **Platform** (§6) already covered; **C8 SMS** → Tier-3 | uploads-pipeline | shipped 2026-09-24 |
| **6** | ✅ **DONE** — **Reports** (§7, +CSV-injection fix) + **C7 envelope**; **C8 SMS** already covered; **C9 Playwright** deferred | reports-export + error-envelope | shipped 2026-09-24 |

**Tooling.** All server tests are `test/integration/*.e2e-spec.ts` on the existing supertest + provisioning
harness (`class-structure.e2e` is the reference pattern: two campuses, multiple roles, `loginRequest`). The
authz/isolation sweeps enumerate the route table via `DiscoveryService` (reuse the `route-authz-coverage`
scanner) so they can't drift behind new routes. Concurrency uses `Promise.all` of parallel supertest calls.
Property checks use a seeded PRNG for reproducibility. FE uses the existing Playwright config + `storageState`
(stay under the login limiter — ≤3 form logins/run).

## Exit criteria (definition of done for the whole plan)
- **C1 + C2 + C3 green and merge-blocking** — the three classes (wrong-role, cross-tenant leak, un-translated
  DB error) cannot regress.
- Every business rule in the §1 modules has an asserting test on **both** the bad and good path.
- The money-integrity property (C5) holds across a 1,000-op fuzzed sequence.
- No 500 reachable by the create/update fuzz (C3) across all modules.
- `pnpm test` (unit → integration → isolation) + `typecheck` + `lint` + Playwright all green in CI order.
- Every bug found is fixed with a named regression; findings logged one-by-one here with severity + status,
  then rolled into a remediation plan (as the last pass did).

## Non-goals (explicitly out of scope here)
Load/soak (fee-season driver `scripts/load-fees.mjs` covers this separately), DR-drill/PITR restore, and the
external pen-test — all VPS-bound M7 items tracked in the [[Progress Tracker]]. This plan is functional +
security + data-integrity QA on the running app.
