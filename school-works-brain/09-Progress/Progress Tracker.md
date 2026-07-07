---
title: Progress Tracker
type: status
updated: 2026-07-07
current_milestone: M6 complete → M7 next (hardening/pilot)
overall: 6 of 7 milestones (GA) — full v1 domain built
---

# 📊 Progress Tracker

> [!info] Living document — update at the **end of every phase**.
> Procedure at the bottom. Related: [[Roadmap & Milestones]] · [[Testing & Quality]].

**Last updated:** 2026-07-07 · **Stack:** Contabo VPS + Coolify + self-hosted Postgres 16 + Redis + Cloudflare R2 (see [[Deployment & Operations]]) · **Repo:** NestJS monorepo (`apps/api`, `apps/worker`, `libs/common`, `libs/database`).

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
**Test count:** **64 passing** across 12 suites (unit + integration/e2e + isolation).

## 🔧 M7 / hardening progress (in flight)
- [x] **Object storage + real PDFs** (§22.6, §11/§15): `StorageService` (AWS SDK v3 — MinIO dev, R2 prod) + `PdfService` (pdfkit). Report cards & certificates now render **real PDFs → uploaded → served via 10-min presigned GET**. e2e verifies `%PDF` bytes over MinIO.
- [x] **Upload pipeline** (§22.6): presigned PUT → magic-byte/MIME allowlist validate → move quarantine→permanent. *(ClamAV scan still a TODO — docker service exists.)*
- [x] **Backups**: `scripts/backup-postgres.sh` (pg_dump→R2) + `scripts/restore-verify.sh` (weekly restore smoke). *(Wire to Coolify cron on deploy; add WAL archiving for PITR.)*
- [x] **Swagger explorer** at `/api/docs` (dev only; CSP relaxed off-prod; `csrf` apiKey scheme; `withCredentials`). 104 paths.
- [x] **Next.js frontend scaffold** (`apps/web`, Next 14 App Router): login + dashboard wired to the API (cookie auth + CSRF via `lib/api.ts`); dev proxy preserves the tenant host. Typechecks + `next build` green. Separate install (`cd apps/web && pnpm install`).
- [ ] Frontend: role-based screens (admissions, students, attendance, fees counter, exams, reports) — generate from OpenAPI
- [ ] Rate limiting, observability (Sentry), production Coolify deploy, ClamAV wiring, payslip PDF, WAL archiving/PITR

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
- **M6 deferred:** PDF render + R2 upload for certificates/payslips (fileKey placeholders; needs §22.6 upload pipeline), report **PDF** format (json+csv only), sibling-discount/report-card promotion precondition, role-shaping the dashboard per non-owner roles, wiring `payroll`/report jobs to worker cron.

## ⏳ M7 — Hardening & Pilot → GA (Next)
Load (k6), pen test, DR drill, pilot onboarding via feature flags. **Plus the cross-cutting backlog below** — several items are now prerequisites for a real pilot.

---

## 🧾 Cross-cutting backlog (not milestone-blocking)
- [ ] **M1 remainder:** nightly `pg_dump` + WAL → R2 backups + weekly restore-test *(do before real fee data)*
- [ ] Students CSV import (needs upload pipeline §22.6) — deferred from M2
- [ ] Phone OTP verification flow (§14) — deferred from M3
- [ ] Swagger/OpenAPI explorer + generated typed client
- [ ] Frontend (Next.js) — not started; UI/UX in [[05-ui-ux-specification]]
- [ ] Vendor console (PLATFORM_ADMIN) HTTP surface + auth
- [ ] Rate limiting (Redis sliding window, §29), observability (Sentry + Coolify logs)

---

## 🔁 How to update this file (every phase)
1. Move the milestone row to ✅ with the ship date; set the next one to ⏳.
2. Fill its checklist, list the tests that went green, and note any findings/deviations.
3. Update the header (`updated`, `current_milestone`, test count) and the top gates line.
4. Update any brain note whose **Implementation status** changed, and [[Roadmap & Milestones]] if sequencing shifted.
5. Commit with the phase (the repo history + this file must agree).
