# QA Remediation Plan — ideal fix for all findings (2026-09-23)

Built from the live QA run (see [[Full System QA Test Plan]]). The guiding principle is **senior, not
spot-patch**: every finding is treated as an instance of a *class* of defect, and each workstream ships
(a) the systemic root-cause fix, (b) the point fixes where a friendly message adds value, and (c) a
**merge-blocking regression gate** so the class cannot come back.

Findings #1–#4 are already fixed with regression tests; they are folded in here so the plan is complete
and so their *classes* (not just their instances) are closed.

Severity: **P0** security/data-loss · **P1** 500/data-integrity · **P2** correctness/UX · **P3** polish.

---

## Workstream A — No Prisma/DB error ever leaks as a 500 (root cause of #2, #4)
**Why.** #2 (duplicate name → 500) and #4 (enrolment-date CHECK → 500) were the same shape: an
un-translated database error surfaced as a 500. Point-fixing three `create()` calls and one service is
not enough — *any* `create/update` on *any* model can throw `P2002` (unique), `P2003` (FK), `P2025`
(not found) or a `23514` CHECK violation.

**Fix (architect).**
1. Extend the global `AllExceptionsFilter` (or add a `PrismaExceptionFilter` before it) to map
   `PrismaClientKnownRequestError` / `PrismaClientUnknownRequestError`:
   - `P2002` → **409 CONFLICT** (`error.details` names the offending field(s) from `meta.target`);
   - `P2025` → **404 NOT_FOUND**;
   - `P2003` → **409 CONFLICT** ("still referenced by …");
   - Postgres `23514` (CHECK) / `23503` (FK) reaching the filter → **422** with a generic message.
   This is the safety net: a missed pre-check degrades to a clean 4xx, never a 500 or a stack leak.
2. Keep the **explicit find-then-throw pre-checks** (already in campuses/fee-heads/holidays and now
   classes/sections/subjects) — they give a *human* message ("A class named '9th' already exists").
   The filter is the floor; the pre-check is the good UX.
3. Keep the app-layer validations that stop a CHECK being reached at all (e.g. #4's leaving-date≥admission
   check → 422).

**Files.** `libs/common/src/errors/all-exceptions.filter.ts` (or a new `prisma-exception.filter.ts` +
register in `app.module`). No controller changes.
**Tests.** Unit test the filter (feed each Prisma error → assert status/shape). One integration test that
forces a P2002 on a model *without* a pre-check (e.g. a second academic-year with a duplicate name) →
expect 409 from the filter path.
**Risk.** Low — additive; existing 409 pre-checks still win because they throw first. **Effort.** ~0.5d.
**Status.** #2/#4 instances fixed; the filter (the class-level fix) is the remaining work.

## Workstream B — Every route declares its roles (root cause of #3)  ·  **P0**
**Why.** #3 (staff directory readable by students) was a *missing* `@Roles`, not a wrong one. A route
with no `@Roles` silently defaults to "any authenticated principal". The codebase has hit this before
(the SMS routes, per an existing comment). There may be more (`getStaff` was the twin of `listStaff`).

**Fix (architect).**
1. **Audit** every controller method for a missing `@Roles` (or an explicit `@Public`/portal marker).
   Fix each to its correct role set (as #3 did for `/staff` + `/staff/:id`).
2. **Gate it in CI** — a new test (sibling to `route-coverage.e2e`) that reads the live route table and
   fails on any non-public route whose handler/controller carries **no `Roles` metadata** and is not on
   a small, commented allowlist (`/auth/*`, `/portal/*`, `/webhooks/*`, health). "Forgot @Roles" becomes
   a red build, exactly as "forgot a UI" already is.
3. Consider a **default-deny** posture as a follow-up (a global guard requiring `@Roles` unless
   `@Public`) — stronger, but a larger change; the CI gate delivers 90% of the value now.

**Files.** the controllers found by the audit; `test/integration/route-authz-coverage.e2e-spec.ts` (new).
**Tests.** the new coverage gate is itself the test; plus the #3 regression already added.
**Risk.** Medium — tightening roles can break a legitimate caller, so each change is checked against its
frontend callers (as #3 was). **Effort.** ~1d. **Status.** #3 instance fixed + tested; audit + gate pending.

## Workstream C — Input validation matches the data model (Obs-1, #4 class)  ·  **P1/P2**
**Why.** Obs-1: exam marks entry accepts `marksObtained > totalMarks` and returns **200 without
persisting** — a silent no-op that hides a data-entry error and *should* be a 422. More broadly, every
DB CHECK deserves a matching app validation that returns 422 *before* the row is written.

**Fix.**
1. Validate `marksObtained ≤ totalMarks` in `MarkRowDto` (custom `@ValidateIf`/validator) **and** in the
   marks service, returning 422 with the offending row — never a silent 200.
2. Audit the schema's CHECK constraints (`chk_enrollment_dates`, marks, fee amounts, date ranges) and
   ensure each has a mirrored app validation → 422 (WS-A is the backstop for any that slip through).

**Files.** `apps/api/src/modules/exams/dto/exams.dto.ts`, `exams.service.ts`; audit note in the brain.
**Tests.** integration: marks 150/100 → 422; a valid 80/100 still 200 and persists.
**Risk.** Low. **Effort.** ~0.5d.

## Workstream D — Seed realism so comms are testable (Obs-2, Obs-5)  ·  **P2/P3**
**Why.** Obs-2: seeded guardian phones are unverified, so SMS/broadcast reach **0** recipients and can't
be exercised. Obs-5: QA left exam-definition debris and there is no delete-exam path.

**Fix.**
1. `seed-real-school.ts`: set `phoneVerifiedAt` on the seeded guardians (and leave 1–2 unverified on
   purpose, to exercise the withheld/unverified path) → broadcast preview shows real recipients.
2. Add a **guarded delete-exam** endpoint (OWNER/CAMPUS_ADMIN) that refuses a published exam or one with
   results (mirroring delete-class), so test/admin debris is removable; then clean the current demo's
   `QA …` exams.
**Files.** `scripts/seed-real-school.ts`; `apps/api/src/modules/exams/*` (delete route + service guard).
**Tests.** integration: delete empty exam → 204; delete published/with-results → 409.
**Risk.** Low. **Effort.** ~0.5d.

## Workstream E — Teacher section picker scoped to assignments (Obs-3)  ·  **P3**
**Why.** The teacher attendance dropdown lists **all** sections; the roster load is server-scoped so
there is no data leak, but it lets a teacher pick a section they can't mark (confusing) and leans on the
server as the only guard.
**Fix.** Populate the teacher attendance `SearchableSelect` from the teacher's own sections
(`/teaching/my-classes`) instead of the school-wide section list. Defence in depth + clearer UX.
**Files.** `packages/school-ui/src/app/attendance/page.tsx` (teacher branch).
**Tests.** e2e/Playwright: a teacher sees only their assigned sections in the picker.
**Risk.** Low. **Effort.** ~0.5d.

## Non-actions (documented, no change)
- **Obs-4** — owner cannot admit (403): **by design** (admission is a per-campus delegated seat).
- **Obs-6** — login-form submit flakiness: **automation harness only**, real users unaffected.

---

## Sequencing & acceptance
| Order | Workstream | Ships | Merge gate |
|-------|-----------|-------|------------|
| 1 | **B** — route @Roles audit + CI gate (P0 security) | correct roles everywhere + red-build on missing @Roles | new route-authz-coverage spec |
| 2 | **A** — Prisma/DB exception filter (P1 robustness) | no DB error is ever a 500 | filter unit + P2002 integration |
| 3 | **C** — marks/CHECK validation (P1/P2) | 422 not silent-200 / not 500 | marks>total integration |
| 4 | **D** — seed verified phones + delete-exam (P2/P3) | comms testable, debris removable | delete-exam integration |
| 5 | **E** — teacher section picker (P3) | scoped dropdown | teacher-picker e2e |

**Definition of done (whole plan):** every finding closed by a *systemic* fix, each guarded by a
merge-blocking test; `pnpm verify` + integration + isolation green; the QA plan's issue table all ✅;
no new 500 reachable by a fuzz of create/update across modules.

**Effort:** ~3 developer-days total. **Risk posture:** B and C are the load-bearing ones (security +
data integrity); A is a pure safety net; D/E are polish. Do B and A first — they retire the two *classes*
(missing-authz, un-translated DB error) that produced 3 of the 4 real bugs.
