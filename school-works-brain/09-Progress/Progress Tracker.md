---
title: Progress Tracker
type: status
updated: 2026-07-08
current_milestone: M6 complete → M7 next (hardening/pilot)
overall: 6 of 7 milestones (GA) — full v1 domain built
---

# 📊 Progress Tracker

> [!info] Living document — update at the **end of every phase**.
> Procedure at the bottom. Related: [[Roadmap & Milestones]] · [[Testing & Quality]].

**Last updated:** 2026-07-08 · **Stack:** Contabo VPS + Coolify + self-hosted Postgres 16 + Redis + Cloudflare R2 (see [[Deployment & Operations]]) · **Repo:** NestJS monorepo (`apps/api`, `apps/worker`, `libs/common`, `libs/database`).

## Milestone status

| Milestone | Status | Gate | Shipped |
|---|---|---|---|
| **M1 — Foundations** (tenancy, auth, CI) | ✅ Done | Tenant-isolation suite green before any feature | 2026-07-04 |
| **M2 — Students & Admissions** | ✅ Done | Admit journey E2E green | 2026-07-04 |
| **M3 — Attendance, Leaves & SMS core** | ✅ Done | Mark attendance E2E + absence SMS verified | 2026-07-06 |
| **M4 — Fees end-to-end** | ✅ Done | Collect-fee E2E + `fee-integrity-check` clean | 2026-07-07 |
| **M5 — Exams & Report Cards** | ✅ Done | Enter/publish marks + parent views report card | 2026-07-07 |
| **M6 — HR, Payroll, Docs, Reports** | ✅ Done | Promotion E2E + all 7 reports export | 2026-07-07 |
| **M7 — Hardening & Pilot → GA** | ⏳ Next | Load + pen test + DR drill + pilot live | — |

**Quality gates (always green):** ✅ tenant-isolation suite · ✅ RLS-coverage check · ✅ lint + strict typecheck · ✅ api + worker builds.
**Test count:** **170 passing** — unit 36 · integration 127 · isolation 7 (+ **11 Playwright e2e** across the 6 tenant screens + the /admin vendor console). `pnpm test` green (3 projects serial, matching CI). *(Integration jumped with the 59-case matrix-conformance harness.)*
> [!note] Fixed a test-infra issue while adding rate limiting: the aggregate **`pnpm test`** ran the integration project **in parallel**, so the SMS e2e suites contended over the shared BullMQ `sms` queue (a job drained/dispatched by the wrong suite → duplicate `SmsLog`). Changed `package.json` `test` to chain `test:unit → test:integration → test:isolation` (integration/isolation `--runInBand`), matching CI exactly. Also note: a **stray `worker` process** (from `pnpm start:worker:dev` whose children survived the parent kill) will consume the queue and cause the same duplicate-dispatch — always confirm no `dist/apps/worker/main` is running before an integration run. Not a product bug (prod jobs have deterministic ids + a single worker fleet).

## 🔧 M7 / hardening progress (in flight)
- [x] **Object storage + real PDFs** (§22.6, §11/§15): `StorageService` (AWS SDK v3 — MinIO dev, R2 prod) + `PdfService` (pdfkit). Report cards & certificates now render **real PDFs → uploaded → served via 10-min presigned GET**. e2e verifies `%PDF` bytes over MinIO.
- [x] **Upload pipeline** (§22.6): presigned PUT → magic-byte/MIME allowlist validate → **ClamAV scan** → move quarantine→permanent.
- [x] **ClamAV scan wiring** (§22.6): `ClamAvService` speaks clamd **INSTREAM** over TCP (no new dep). `confirmUpload` fetches the object once, magic-byte-validates, then scans (when `CLAMAV_ENABLED=true`); infected → object deleted + **422 `FILE_INFECTED`**; scanner outage → **fail-closed 503 `VIRUS_SCAN_UNAVAILABLE`**. Opt-in (off in dev/test). **Verified against real clamd**: EICAR → FOUND, clean → OK, dead port → 503. Pure `parseResponse` + config covered by unit spec.
- [x] **Backups**: `scripts/backup-postgres.sh` (pg_dump→R2) + `scripts/restore-verify.sh` (weekly restore smoke). *(Wire to Coolify cron on deploy; add WAL archiving for PITR.)*
- [x] **Rate limiting** (§29): Redis **sliding-window** limiter (atomic Lua over a sorted set) + `RateLimitGuard` (global, runs right after `JwtAuthGuard` so authed routes key per-user, `@Public` per-IP). Named policies: login 5/IP/15min **and** 10/email/1h, refresh 60/token/1h, parent-read 600/user/1h, public 60/IP/min, authenticated default 600/user/min. `@RateLimit(name)` / `@SkipRateLimit()` decorators; **429 + `Retry-After`** via the §25.1 envelope; tenant-scoped breaches logged as a compromise signal. Verified live (6th login → 429). Gated by `RATE_LIMIT_ENABLED` (on by default; **off in the test env** so shared-Redis suites stay deterministic). Covered by service + guard unit specs.
- [x] **Next.js frontend scaffold** (`apps/web`, Next 14 App Router): login + dashboard wired to the API (cookie auth + CSRF via `lib/api.ts`); dev proxy preserves the tenant host. Typechecks + `next build` green. Separate install (`cd apps/web && pnpm install`).
- [x] **Frontend: role-based screens** — central nav/page gating (`lib/roles.ts`, `(app)/layout.tsx`) covers Dashboard/Setup/Students/Admissions/Attendance/Fees/Exams/Reports per role. **Admissions** (`app/(app)/admissions/page.tsx`): inquiry list+filter, new-inquiry form, per-row schedule/record-entry-test/admit/reject/withdraw following the inquiry state machine. **Exams** (`app/(app)/exams/page.tsx`): subjects, grade scale editor, terms, exam CRUD, open-marks-entry, bulk marks entry (section roster × class subjects), results view, publish (completeness gate), report-card generate/list. `lib/api.ts` gained `apiPatch` + `Inquiry/EntryTest/Subject/Term/GradeBand/Exam/ExamResult/ReportCard` types.
- [x] **Playwright E2E** (`playwright.config.ts`, `test/e2e/`) — **all 6 tenant screens + the vendor console covered**: `smoke` (login flow, role nav, students table), `admissions` (inquiry → entry test → admit → shows in Students), `exams` (class/section/student → subject+term+exam → open marks entry → enter marks → results → publish → report cards), `attendance` (mark LATE on a safe date, persisted on reload), `fees` (generate invoice batch → partial + full payment → PAID), `reports` (class-strength table + CSV export), and **`admin`** (platform admin → provision a throwaway tenant → list → suspend → reactivate). **11 tests green across 3 consecutive full runs** (`npx playwright test`, ~23–28s). Specs assert the POST payload at the **network layer** where a value is easy to drop (exam marks, attendance status, payment amount, provisioned subdomain) — this caught + now guards a real marks-entry state-clobber race (marks posted as 0). **Shared auth via two setup projects + `storageState`** (`auth.setup.ts` for the tenant owner, `platform-auth.setup.ts` for the platform admin; feature specs reuse the tenant session, `admin.spec.ts` overrides to the platform one): the whole suite makes ~3 form logins total so it stays under the §29 login limiter (5/IP/15min) — the earlier per-test login design blew the limit at 8 logins/run. See [[Key Decisions]].
- [x] **Campus scoping — deny-by-default** (§22.8, security playbook **P1.7**): closed a privilege gap where non-OWNER_ADMIN roles were only role-gated, not campus-scoped (a campus-A admin could list/read/act on campus-B data via a client-supplied `?campusId=B`). New shared helper `libs/common/src/authz/campus-scope.ts` (`restrictedCampusId` → `null` for OWNER_ADMIN else the user's `campusId`, **fail-closed to the nil-UUID `NO_CAMPUS` when a non-owner has no campusId**; `effectiveCampusFilter`, `assertCampusAccess`). Enforced **in services** (§22.8 — guards run before the `withTenant` tx). **Done:** Students (`search` force-scope, `getOne` 403 → also gates update/delete/all guardian ops, `createStudentCore` campus check → covers direct add **and** admissions admit), Attendance (`markBulk`/`patch` 403, `query` force-scope), Fees (`invoicing.list` force-scope, `get` 403, `createBatch` 403; `payments.pay` 403, `listPayments` force-scope). **Now also rolled out (2nd pass):** Admissions (`createInquiry`/`list` scoped, `getOne` 403 → gates schedule/record/reject/withdraw/admit), Exams (`getExam` 403 → gates open-marks/enterMarks/getResults/publish; `createExam` + `listExams` scoped), Reports (6 of 7 force-scoped via the enrollment/class campus join; `smsUsage` left school-wide — no campus dimension), HR staff (`createStaff`/`getStaff`/`listStaff`/salary/teacher-assignments scoped), Setup (`createClass`/`createSection`/`createSubject`/`updateCampus` 403, `listClasses`/`listSections`/`listSubjects` force-scoped). **Still deferred (owner-only or no campus dimension):** payroll-runs (OWNER_ADMIN-only), `payments.deposit` (parent-level advance), academic-years/terms/grade-scales (school-wide). OWNER_ADMIN unchanged (no regression). Covered by `test/integration/campus-scope.e2e-spec.ts` (2 campuses; CAMPUS_ADMIN + ACCOUNTANT bound to A) — **10 cases green** (students/attendance/fees + inquiry/exam/class+section/staff cross-campus denials); full `pnpm test` green. See [[Key Decisions]].
- [x] **Matrix-conformance harness** (§23, playbook **P1.14**): `test/matrix/permission-matrix.ts` encodes the role×endpoint policy as data; `test/integration/matrix-conformance.e2e-spec.ts` seeds one user per role (OWNER_ADMIN/CAMPUS_ADMIN/ACCOUNTANT/TEACHER/PARENT) and drives every row against live routes — a non-admitted role **must** 403, an admitted role must not role-403. **59 cases green.** Building it **surfaced 4 real under-gating gaps, now fixed:** `GET /students` directory (was any-authenticated → PII leak), `/reports/*`, the fees read endpoints (`GET /fees/invoices|invoices/:id|payments|advances|defaulters`), and `GET /dashboard` — all now `@Roles`-gated to the intended consumers. A future `@Roles` change that diverges from the matrix fails this suite (wire it as the CI `matrix` job — currently runs inside `test:integration`). See [[Key Decisions]].
- [x] **Teacher / parent / self ownership** (§22.8, **P1.7** — the non-campus half): **teacher** scoping was already enforced in-service (attendance `assertCanMark` requires a `TeacherAssignment` for the section; exams `validateRow` requires the assigned subject) and **self** too (`payslips/mine`). Added the **guardian-of-student** checks that were missing: `libs/common/src/authz/ownership.ts` (`isAdminRole`); `report-cards.listByStudent` now 403s a non-admin who isn't a guardian of the student (was readable by any authenticated user — a real per-student leak); `leaves.createStudentLeave` requires a PARENT be the child's guardian, and `leaves.listStudentLeaves` force-scopes a PARENT to their own children. Covered by `test/integration/ownership.e2e-spec.ts` (a seeded PARENT linked to student1) — 4 cases green (own child 200 / other 403 for report-cards + leave-create; list scoped; OWNER_ADMIN unrestricted).
- [x] **Sentry error monitoring** (§31): `@sentry/node` initialised at both api + worker bootstrap; `AllExceptionsFilter` reports unhandled **500s** with tenant/request tags (`schoolId`/`userId`/`requestId` + method/url, never PII); worker captures **exhausted** SMS jobs (final attempt only). Opt-in — **no-op unless `SENTRY_DSN` is set** (dev/test/CI untouched). `flushSentry()` on worker shutdown. Covered by a mocked-SDK unit spec.
- [x] **Observability — structured logs + metrics** (§31): **Pino** wired as the app logger in api + worker (`nestjs-pino` `LoggerModule` + `pinoConfig` in `libs/common/observability/logger.config.ts`, `app.useLogger` in both bootstraps). Every log line is JSON carrying **`requestId` (the CLS id, same as the §25.1 envelope) + `schoolId` + `userId`**; **PII redacted** (`authorization`/`cookie`/`set-cookie` headers + `password`/`cnic`/`phone`/`bankAccount`/`ownerPassword` body paths → `[redacted]`; bodies aren't logged by default anyway). **Prometheus** via `prom-client`: `MetricsService` (isolated registry + default node metrics + `http_request_duration_seconds` histogram labelled `method`/`route`/`status`), recorded by `MetricsMiddleware` on `res 'finish'` (so guard-403s/404s count too); scraped at **`GET /api/v1/metrics`** (`@Public` + `@SkipRateLimit` + host-exempt). **Verified live under Playwright-driven traffic**: JSON logs with requestId/schoolId/userId, cookie → `[redacted]`, and the metric captured every route/status (GET /students 200, POST /students 201, /dashboard, /fees/invoices, …). *(Remaining observability: OpenTelemetry tracing + guard-denial/rate-limit counters — deferred.)*
- [x] **Payslip PDF** (§13, §15): `PayrollService.payslipPdf()` renders via `PdfService.payslip`, uploads to `payslips/{sid}/{id}.pdf`, returns a 10-min presigned GET. `GET /payslips/:id/pdf` — **owner-or-admin check in the service** (§22.8, reads inside the RLS tx, not a guard). Verified e2e: real `%PDF` bytes fetched over MinIO.
- [ ] Production Coolify deploy, WAL archiving/PITR

---

## ✅ M1 — Foundations (Done)
Blueprint §16–§22, §34. See [[Multi-Tenancy & Isolation]], [[Security & Compliance]].
- [x] NestJS monorepo (api + worker + libs), webpack bundling, path aliases, docker-compose (pg/redis/minio/clamav)
- [x] Full Prisma schema (48 models, §17) + SQL companions: RLS policies (FORCE, fail-closed), partial uniques, CHECKs, trigram, grants; two DB roles (`app_user` no-BYPASSRLS, `platform_admin` BYPASSRLS)
- [x] 3-layer tenant isolation: Prisma client extension + `withTenant` tx wrapper + RLS + **merge-blocking isolation suite**
- [x] Auth (§22): argon2id + HIBP, JWT httpOnly/SameSite cookies + `kid` rotation, single-use refresh rotation w/ family-reuse detection, lockout, TOTP MFA, CSRF, AES-256-GCM field encryption, Redis access denylist
- [x] Tenant resolution middleware, guards (Jwt/TenantScope/Roles/Csrf), §25.1 error envelope, Zod env + SchoolSettings validation
- [x] CI pipeline (`.github/workflows/ci.yml`) in §34 order
- **Tests:** 7 isolation + 6 auth e2e green.
- **Hardening beyond blueprint:** RLS policy uses `NULLIF(current_setting(...),'')::uuid` to fail closed on a reset pooled connection.

## ✅ M2 — Students & Admissions (Done)
Blueprint §7–§8. See [[Enrollment & Admissions]].
- [x] Setup: academic years (+set-current), campuses, classes, sections, subjects
- [x] Platform provisioning (`ProvisioningService`) + dev seed (`pnpm db:seed` → tenant `demo`)
- [x] Students directory (name/GR/guardian-phone search), CRUD + soft delete, guardians (one-primary invariant), phone-normalized parent **link-or-create** (no silent merge)
- [x] Admissions: inquiry state machine, entry tests, **transactional admit** (guardian + GR + student + primary link + enrollment + admission, atomic), age-band eligibility, audit
- [x] Enrollment: list + **transfer** (close-old/open-new)
- **Tests:** admit-journey e2e + inquiry state-machine unit green.

## ✅ M3 — Attendance, Leaves & SMS core (Done)
Blueprint §9, §10, §14, §26–§27. See [[Attendance & Leaves]], [[HR, Payroll, Comms & Documents]].
- [x] SMS/comms core: pluggable gateway adapter (`console`; Telenor/Jazz later), GSM-7/UCS-2 segment calc, template render, **credit ledger + overdraft for critical sends**, SmsLog, templates CRUD, manual send, **HMAC delivery webhook**, retry
- [x] **BullMQ `sms` queue** (producer in api) + `SmsProcessor` Worker in the worker deployable (runs each job in tenant context + `withTenant`)
- [x] Attendance (§9): bulk mark with future/holiday/weekly-off validation, edit-lock window, cross-teacher conflict, **partial-failure contract**, absence-SMS enqueue; admin post-window edit; staff attendance
- [x] Leaves (§10): student + staff state machine, overlap guard, staff quota → auto-UNPAID, **ON_LEAVE written + locked on approve**
- [x] Provisioning seeds default SMS templates + BASIC 1000-credit grant
- **Tests:** attendance e2e (w/ live SMS dispatch) + leaves e2e + segment/render unit green. Worker boots clean.
- **Findings:** §22.8 ownership checks that read tenant data run as **service-level checks, not guards** (guards run before the withTenant tx → RLS returns 0 rows). BullMQ uses parsed-URL connection options to dodge a dup-ioredis-version type clash.

---

## ✅ M4 — Fees end-to-end (Done)
Blueprint §12. See [[Fees & Payments]]. Gate met: collect-fee E2E green + `fee-integrity-check` clean throughout.
- [x] Fee heads / structures / late-fee policy CRUD
- [x] **Idempotent invoice batches** (`[schoolId, classId, month, year]`; duplicate → existing, `generated:0`) — synchronous generation in the request tx *(async batching = later scale optimisation)*
- [x] Discounts (PERCENT then FIXED, capped at base) applied as negative line items; **fines** via `mark-overdue` (FLAT/PER_DAY, single upserted FINE line, total recomputed)
- [x] **Payments:** reusable **IdempotencyService** (reserve-then-run, replay, 409 on hash mismatch) + `SELECT … FOR UPDATE` row lock + **gap-free per-school receiptNo** + partial→paid status; overpayment → `OVERPAYMENT_USE_ADVANCE`
- [x] **Reversals** (OWNER_ADMIN, `RV-` receipt, invoice recomputed), **waivers** (WAIVER line zeroes remaining), advances (GuardianCredit deposit + balance), defaulters
- [x] **Receipt SMS** (FEE_RECEIPT) via the BullMQ pipeline (critical send, overdraft-eligible)
- [x] `fee-integrity-check` (totalAmount = Σ items; paidAmount = Σ payments − Σ reversals)
- **Tests:** fees e2e (batch → idempotent payment replay → overpay guard → PAID → integrity → receipt SMS → reversal → mark-overdue+fine → waiver → advance) green.
- **Findings:** in a **nested** `items.create` under an invoice, do NOT pass `schoolId` — it's part of the invoice's composite relation FK and Prisma derives it (passing it → `Unknown argument schoolId`). See [[Key Decisions]]. Money uses JS-number arithmetic rounded to 2dp; switch to decimal.js for production rigor (noted).
- **M4 deferred:** advance **auto-application** to new invoices (oldest-first), sibling-discount auto-calc, reconciliation CSV import, wiring `mark-overdue`/`fee-integrity-check` to the worker cron (currently service methods + admin triggers).

## ✅ M5 — Exams & Report Cards (Done)
Blueprint §11. See [[Exams & Report Cards]]. Gate met: enter/publish marks + report card served (parent view).
- [x] **Pure grading module** (`exam-grading.ts`): grade-from-scale, subject term percent (weighted, absent→0), overall = mean, **dense rank** — unit-tested with the worked example
- [x] Grade scales (set/replace bands per year), terms CRUD
- [x] Exam definitions + `open-marks-entry` + **publish** with the **completeness gate** (`RESULTS_INCOMPLETE` lists missing student×subject) and weightage-sum check at generation (`WEIGHTAGE_SUM_INVALID`)
- [x] **Marks entry** bulk (partial-failure; `marks ≤ total`; absent XOR marks; teacher assigned-subject check in-service)
- [x] **Report cards generate**: compute term results + dense rank per section → `ReportCard` + `Document` rows → **RESULT_READY SMS**; read by term and by student
- **Tests:** grading unit (worked example) + exams e2e (define → marks partial-failure → publish gate → generate → overall 85 / grade A / rank 1 → parent read → result SMS) green.
- **Findings:** `ReportCard` has no `enrollment` relation in the schema — resolve enrollment ids first when querying by student. Added `RESULT_READY` to the SMS job union + dispatcher.
- **M5 deferred:** actual **PDF render + R2 upload** (`Document.fileKey` is a placeholder; needs upload pipeline §22.6), post-publish mark **correction** flow (OWNER_ADMIN + regen + "Corrected" SMS), per-subject grade breakdown on the card.

## ✅ M6 — HR, Payroll, Documents, Reports (Done)
Blueprint §13, §15, §28, §7. See [[HR, Payroll, Comms & Documents]], [[Enrollment & Admissions]]. Gate met: promotion E2E + all seven reports export.
- [x] **Staff HR:** staff CRUD (User+StaffProfile, employeeCode unique), salary structures (effective-dated), teacher assignments
- [x] **Payroll:** run compute (gross = basic + Σ allowances; attendance-linked deduction = (unpaidLeaveDays+absentDays) × basic/workingDays; net), DRAFT payslips → approve (locks) → mark-paid; my-payslips
- [x] **Promotion (§7):** batch close-old/open-new to the next class (by `Class.order`) in the target year; fee-clearance precondition (override + `PROMOTION_OVERRIDE` audit); idempotent (already-in-target-year skipped)
- [x] **Documents/certificates:** issue LEAVING/CHARACTER/FEE_CLEARANCE (LEAVING_CERT fee-clearance gate + override); **withdrawal workflow** (FEE_CLEARANCE → LEAVING_CERT → close enrollment WITHDRAWN → disable portal)
- [x] **Seven reports** (daily-collection, fee-ledger, attendance-register, class-strength, defaulters, exam-summary, sms-usage) with **JSON + CSV** export
- [x] **Dashboard** (owner-view metrics) + **audit-log browser** (filters + pagination)
- **Tests:** m6 e2e (promotion idempotent + all 7 reports json/csv + payroll compute 60000 + certificates + dashboard + audit) green.
- **Findings:** after promotion the source section has no ACTIVE enrollments, so a re-run is a natural no-op (the already-in-target guard is a belt-and-suspenders for partial re-runs).
- **M6 deferred:** ~~PDF render + R2 upload for certificates/payslips~~ **✅ done in M7** (certificates & report cards via the storage/PDF pipeline; payslips via `payslipPdf()`), report **PDF** format (json+csv only), sibling-discount/report-card promotion precondition, role-shaping the dashboard per non-owner roles, wiring `payroll`/report jobs to worker cron.

## ⏳ M7 — Hardening & Pilot → GA (Next)
Load (k6), pen test, DR drill, pilot onboarding via feature flags. **Plus the cross-cutting backlog below** — several items are now prerequisites for a real pilot.

---

## 🧾 Cross-cutting backlog (not milestone-blocking)
- [ ] **M1 remainder:** nightly `pg_dump` + WAL → R2 backups + weekly restore-test *(do before real fee data)*
- [ ] Students CSV import (needs upload pipeline §22.6) — deferred from M2
- [ ] Phone OTP verification flow (§14) — deferred from M3
- [ ] Swagger/OpenAPI explorer + generated typed client
- [x] Frontend (Next.js) — scaffold + role-based screens + Playwright E2E done (see M7 in-flight above); UI/UX in [[05-ui-ux-specification]]. Remaining: OpenAPI-generated typed client (kept hand-written types in `lib/api.ts` for now).
- [x] **Vendor console (PLATFORM_ADMIN) — auth + tenant management API + UI done** (§24): new `PlatformUser` table (no RLS), cross-tenant auth on the host-exempt `platform/*` routes (separate `platform_access_token`/`platform_csrf` cookies, `typ:'platform'` JWT, `PlatformAuthGuard` + CSRF), and `GET /platform/tenants` · **`POST /platform/tenants`** (provision → `{id, subdomain}`; 409 CONFLICT on dup subdomain, 400 on bad subdomain — delegates to the shared `ProvisioningService`) · `POST /platform/tenants/:id/suspend|reactivate` (BYPASSRLS reads + host-cache invalidation → suspend is immediate). Seed adds `admin@platform.pk` / `Admin!Secret12`. **UI** (`apps/web/app/admin/*`, separate from the tenant `(app)` group): `/admin/login`, `/admin/layout` (checks `GET /platform/auth/me`, own shell not the tenant sidebar), `/admin` tenants table (name/subdomain/plan/status/users/students + Suspend/Reactivate per row + New-tenant form). Platform writes use a dedicated `apps/web/lib/platform-api.ts` that reads the **`platform_csrf`** cookie (not the tenant `csrf`). 10-test integration e2e (incl. provision → list → owner-login, dup 409, bad-subdomain 400) + a Playwright `admin.spec.ts` green. **Remaining:** SMS-credit grants, analytics/export, §22.9 break-glass support sessions, platform refresh-token rotation (currently an 8h access token, no refresh).
- [x] Rate limiting (Redis sliding window, §29) — done (see M7 in-flight above)
- [ ] Observability (Sentry + Coolify logs)
- [ ] **Test infra fix:** `jest.config.js` unit `testMatch` changed from a `{apps,libs}` brace glob (matched **0** tests on Windows) to two explicit patterns — the unit project now actually runs. Worth verifying CI counts.

---

## 🔁 How to update this file (every phase)
1. Move the milestone row to ✅ with the ship date; set the next one to ⏳.
2. Fill its checklist, list the tests that went green, and note any findings/deviations.
3. Update the header (`updated`, `current_milestone`, test count) and the top gates line.
4. Update any brain note whose **Implementation status** changed, and [[Roadmap & Milestones]] if sequencing shifted.
5. Commit with the phase (the repo history + this file must agree).
