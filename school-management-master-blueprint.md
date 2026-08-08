# Multi-Tenant School Management System — Master Blueprint (v2.1)

**Status:** AUTHORITATIVE. **v2.1 (2026-08-08)** — see Appendix E. This document supersedes `school-management-saas-architecture.md` (Part 1) and `school-management-detailed-design.md` (Part 2). It is the single source of truth. Where this document conflicts with any earlier artifact, this document wins.

**Purpose:** A senior engineering team — or an AI coding agent — must be able to build, test, deploy, and operate the complete system from this document alone, without asking fundamental architectural or business questions.

**Change control:** This document is versioned in the repository at `/school-management-master-blueprint.md` (repository root). Changes require a PR approved by the Tech Lead and Product Manager. Every change updates the changelog in **Appendix E**.

> **Note on the path (2026-08-08).** The path above used to read `/docs/blueprint.md`. The document has never lived there, and `docs/` holds the frozen numbered briefs this document supersedes — so anyone following the pointer would have found the superseded material instead of the authoritative copy. Appendix E exists and now carries a dated entry per change; before today it held a single line for v2.0 and nothing since, so four weeks of decisions had gone unrecorded.

---

# PART I — PRODUCT DEFINITION

## 1. Vision & Positioning

A multi-tenant SaaS platform for private schools in Pakistan (v1 market), covering the full daily operations of a school: admissions, enrollment across academic years, attendance, examinations and report cards, fee management with fines and discounts, staff HR and payroll, parent communication (SMS-first), and document issuance. Sold per-school on subscription tiers. English UI in v1; Urdu SMS content supported; full i18n deferred (see §4).

**Primary buyers:** school owners/principals of 200–3,000-student private schools, often multi-campus.
**Primary daily users:** front-desk/admissions staff, accountants at fee counters, teachers (attendance + marks), campus admins, students (read-mostly portal).

> **Parents are reached by SMS, not by a login (2026-07-28).** They were a primary user of a read-mostly portal here; that portal was removed and guardians became contact records rather than accounts. Everything a family needs — absence, fee receipt, result-ready, leave decision — goes to the phone they already carry, and a fee-proof upload works from a signed link with no account at all. In this market a parent will open an SMS and will not maintain a password.

## 2. Tenancy Model (decision)

**Pooled multi-tenancy: one PostgreSQL database, shared schema, every tenant-scoped row carries `school_id`.** Isolation is enforced by three independent layers (defense in depth), each specified fully in Part IV:

1. Application: request-scoped tenant context + Prisma client extension injecting/asserting `school_id` on every operation.
2. Database: PostgreSQL Row-Level Security (RLS) on every tenant table — non-bypassable by application bugs.
3. CI: a mandatory tenant-isolation test suite that seeds two schools and asserts every cross-tenant access fails. Failing this suite blocks merge.

**Rejected alternatives:** schema-per-tenant (migration fan-out pain at 1,000+ schools) and database-per-tenant (cost + ops overhead disproportionate for this market). **Known cost of the pooled choice:** single-tenant restore is non-trivial; §33.5 defines the tenant-export/restore procedure that compensates.

Tenants are addressed by subdomain (`{slug}.platform.pk`) or a verified custom domain. Resolution order and edge cases: §21.1.

## 3. Technology Stack (decision)

| Layer | Choice | Notes |
|---|---|---|
| Backend | Node.js 22 LTS, NestJS 10, TypeScript strict | Modular monolith (§16), not microservices |
| ORM | Prisma with **snake_case DB mapping** (`@map`/`@@map` on every model/field) | Snake_case is mandatory: RLS policies and raw SQL depend on predictable column names |
| Database | PostgreSQL 16 (AWS RDS Multi-AZ) | RLS enabled; UUID PKs (`@db.Uuid`) |
| Cache / queues | Redis 7 (ElastiCache) + BullMQ | Redis is ephemeral; nothing recovery-critical lives only in Redis |
| Frontend | Next.js 14 (App Router), TypeScript, typed API client generated from OpenAPI | Single web app serving all roles; responsive (teachers/parents are mobile-heavy) |
| Files | S3 (versioned) + CloudFront | Uploads pipeline in §22.6 |
| Auth | JWT access (15 min) + rotating refresh tokens (httpOnly cookies) | Full design §22 |
| SMS | Pluggable gateway adapter (Telenor/Jazz aggregator behind an interface) | §26 |
| Infra | AWS: ECS Fargate, ALB, CloudFront + WAF, Secrets Manager, KMS | IaC in Terraform |
| Observability | Pino → CloudWatch/Loki, Prometheus + Grafana, OpenTelemetry → Jaeger, Sentry | §31 |

## 4. Scope by Release (decision — resolves all "dangling module" ambiguity)

| Module | v1.0 (GA) | v1.5 | v2.0 | Never / re-evaluate |
|---|---|---|---|---|
| Multi-campus, academic years, enrollment & promotion | ✅ | | | |
| Admissions pipeline (inquiry → test → admit) | ✅ | | | |
| Students, guardians, kinship, student portal login | ✅ | | | |
| Attendance (student + staff) with lock windows | ✅ | | | |
| Leaves (student + staff) with approval/rejection | ✅ | | | |
| Exams, grade scales, terms, report cards (PDF) | ✅ | | | |
| Fees: structures, invoices, payments, receipts, fines, discounts, advances, reversals, defaulters | ✅ | | | |
| SMS (transactional + manual) with credits & delivery webhooks | ✅ | | | |
| Staff HR (all staff types) + payroll (basic + attendance-linked deductions) | ✅ | | | |
| Certificates (leaving, character, fee clearance) | ✅ | | | |
| Audit log, dashboards, reports suite (§28) | ✅ | | | |
| Timetable & teacher-subject assignment | ✅ (assignment) | ✅ (visual timetable) | | |
| Homework / diary | | ✅ | | |
| In-app + email notifications | | ✅ | | |
| Library | | | ✅ | |
| Transport (routes, stops, transport fees) | | | ✅ | |
| Data import wizard (students/marks CSV) | ✅ (students) | ✅ (marks) | | |
| Hostel | | | | Re-evaluate on demand. **The `isHostelized` flag from the old schema is removed.** |
| Inventory | | | | Out of scope |
| Online payment gateway (cards/wallets self-serve) | | | ✅ | v1 records payments taken at counter or via bank; gateway integration is v2 |
| Multi-language UI | | | ✅ | |

Everything marked v1.5/v2.0 has schema stubs only where noted; no half-features ship. No model carries flags for descoped modules.

## 5. Roles & Actors (decision — resolves multi-role and staff-type gaps)

Application roles (a User holds **one or more** roles — stored as a Postgres enum array):

| Role | Scope | Summary |
|---|---|---|
| `PLATFORM_ADMIN` | Vendor-side, cross-tenant | Provisions/suspends tenants, manages plans & SMS credits, views platform analytics. Operates through a separate vendor console (`admin.platform.pk`) with its own permission checks; never impersonates without an audited break-glass flow (§22.9). |
| `OWNER_ADMIN` | Whole school | Full control of one tenant |
| `CAMPUS_ADMIN` | One campus (`User.campusId` required) | Admin limited to their campus |
| `ACCOUNTANT` | School or campus | Fees, payments, financial reports |
| `TEACHER` | Own assignments | Attendance, marks, homework for assigned sections/subjects |
| `STAFF` | Self | Non-teaching employee: sees own payslips, files own leaves |
| `ADMISSION_CONTROLLER` | One campus's admissions | Runs the admission desk: inquiries, entry tests, admitting, CSV import. **One seat per campus** — a change of holder is a single audited handover, not two unrelated grants. |
| `HR_MANAGER` | Staff records | Owns the campus staff register; **reads** staff attendance but never marks it, because attendance feeds pay. |
| `PARENT` | — (legacy) | **No login. Retained in the enum for rows created before 2026-07-28 and never issued to new accounts.** A guardian is a contact record (`ParentProfile`, `userId` nullable since 2026-07-29), reached by SMS. See the note below. |
| `STUDENT` | Self | Read portal (own attendance, results, invoices, timetable) |

> **The parent portal was removed on 2026-07-28.** It is the one role in this table that no longer signs in, and the change was product-led, not technical: guardians in this market do not maintain passwords, and a portal nobody opens is a surface to secure for no return. What replaced it costs the family nothing to use — SMS for every event, and a signed link for uploading proof of a bank transfer.
>
> **The enum value stays.** Deleting it would orphan historic rows and rewrite audit history; it is simply never granted now. `ParentProfile` also stays — it is how a school records who to call about a child, which it always was.
>
> **Two consequences worth naming, because both look like dead code and are not:** the guardian check in `leaves.service` and the one in `report-cards.service` carry no `@Roles` above them, so they are the *only* thing standing between a signed-in non-admin and another student's record. Removing them as "parent leftovers" would widen access, not tidy it.

**Multi-role rule:** one person = one User row per school; `roles` is an array (e.g. an owner who also teaches is `[OWNER_ADMIN, TEACHER]` with a StaffProfile). Effective permission = union of role grants; scope checks still apply per role (a TEACHER+HR_MANAGER sees marks-entry only for assigned subjects, and reads the staff register without being able to mark it).

Full permission matrix: §23. Ownership-scope enforcement design: §22.8.

## 6. Glossary

**GR number** — General Register number, the student's permanent registration ID, unique per school, assigned at admission and never reused. **CNIC** — Pakistani national identity card number (guardian PII; encrypted at rest, §32). **Session (attendance)** — a marked slot within a day (MORNING/EVENING); schools configure one or two. **Term** — a grading period within an academic year (e.g., Term 1, Term 2) into which exams roll up. **Fee head** — a category of charge (Tuition, Annual Fund, Exam Fee…). **Defaulter** — student with ≥1 invoice past due and unpaid. **Tenant** — one school (all campuses included).

---

# PART II — DOMAIN MODEL & BUSINESS RULES

## 7. Domain Spine: Academic Years & Enrollment

This is the structural core (audit C-1). **Students are never linked directly to a section.** Placement is always through an enrollment row scoped to an academic year.

- `AcademicYear`: per school; `name` ("2026–27"), `startDate`, `endDate`, `isCurrent` (exactly one per school, enforced by partial unique index). Years never overlap (service validation).
- `StudentEnrollment`: (`studentId`, `academicYearId`, `campusId`, `classId`, `sectionId`, `rollNumber`, `status`). One ACTIVE enrollment per student per year (partial unique). All attendance, invoices, exam results, and timetables reference the enrollment's year; historical queries join through enrollment, never through "current section."
- `EnrollmentStatus`: `ACTIVE → { PROMOTED | RETAINED | TRANSFERRED_OUT | WITHDRAWN | COMPLETED }` (terminal states). `TRANSFERRED_OUT` covers campus/section moves mid-year: the old enrollment is closed with `endedAt` and a new ACTIVE enrollment is created — moves are new rows, never destructive field updates.

**Promotion workflow (year-end, OWNER_ADMIN/CAMPUS_ADMIN):**
1. Admin creates the next `AcademicYear` and its class/section structure (clone-from-previous tool provided).
2. Bulk promotion screen per section: default target = next class (by `Class.order`); per-student override to RETAINED (same class next year) or WITHDRAWN.
3. Preconditions per student (server-enforced, overridable only by OWNER_ADMIN with audited reason): final-term report card published; fee clearance (no unpaid invoices) — configurable per school (`Setting.promotionRequiresFeeClearance`, default true).
4. Execution is a queued, idempotent job (`promotion-batch` keyed by sectionId+targetYearId): closes old enrollments (PROMOTED/RETAINED), creates new ACTIVE enrollments, assigns roll numbers (carry or re-sequence per school setting). Partial failure: the job is transactional per section; re-run skips already-processed students.
5. Section capacity: enforcement mode per school setting `sectionCapacityMode = HARD | ADVISORY` (default ADVISORY: warn but allow; HARD blocks with 422).

## 8. Admissions Pipeline

State machine for `Inquiry.status` (single source of truth — `EntryTest.passed` is removed; outcome lives in the status + `EntryTest.score`):

```
INQUIRY ──schedule test──▶ ENTRY_TEST_SCHEDULED ──record result──▶ ENTRY_TEST_PASSED
   │                              │                                     │
   │                              └──record fail──▶ ENTRY_TEST_FAILED ──┤ (admin override admit, audited)
   ├──reject──▶ REJECTED (terminal)                                     ▼
   ├──withdraw──▶ WITHDRAWN (terminal)                    ──admit──▶ ADMITTED (terminal)
   └──admit directly (no test; schools may skip tests)──▶ ADMITTED
```

Allowed transitions are exactly the arrows above; anything else → 409 `INVALID_STATE_TRANSITION`. Rejection/withdrawal require a `reason`.

**Admit action (`POST /admissions` — transactional):**
1. Guardian resolution: request carries guardian details incl. phone. Server searches existing `ParentProfile` by normalized phone within the school; UI shows match ("Link to existing parent Ali Khan? Their children: …") — explicit choice: link or create new. **Never silently auto-merges.** New guardian ⇒ create a `ParentProfile` only: name, phone, optional email. **No `User` row, no account, no invite SMS.** Existing guardian ⇒ link only, which is what makes siblings share one guardian record.
   - *Changed 2026-07-28/29.* This step used to mint a `User(roles=[PARENT])` in `INVITED` state and text a 30-minute set-password link. With the portal gone there is nothing to log into, and creating login-less accounts left placeholder emails colliding in the unique index — a real 500 on admission when a guardian's email already belonged to someone. `ParentProfile.userId` is nullable; legacy rows keep their link.
2. Create `Student` (GR number: auto-sequenced per school from `School.nextGrNumber` with configurable prefix, or manual entry when `Setting.grNumberMode=MANUAL`; uniqueness `[schoolId, grNumber]` either way).
3. Create `StudentGuardian` link(s) with `relation` enum and exactly one `isPrimary=true` per student (primary receives SMS; §26.4).
4. Create ACTIVE `StudentEnrollment` in the current academic year.
5. Create `Admission` row linking inquiry→student; inquiry → ADMITTED.
6. If the school defines an ADMISSION-type fee structure for the class, generate the admission invoice in the same transaction.
7. Eligibility validation: DOB vs class age band if the school configured `Class.minAgeYears/maxAgeYears` (nullable = skip).

## 9. Attendance Rules

- One record per (enrollment, date, session). Sessions per school: `Setting.attendanceSessions = [MORNING]` or `[MORNING, EVENING]` (enum, not free text).
- **Validation on write:** date not in the future; date not a `Holiday` and not a weekly-off day (`Setting.weeklyOffDays`, default `[SUNDAY]`) — override only via admin with `allowHolidayOverride` flag on request (audited); student's enrollment must be ACTIVE and within the enrollment's year; section must be among the writing teacher's assignments for that date's year (§22.8).
- **Edit lock:** records editable by the marking teacher for `Setting.attendanceEditWindowDays` (default 3) after the date; afterwards only CAMPUS_ADMIN/OWNER_ADMIN may edit; every post-window edit requires a reason and writes AuditLog. Concurrent submissions: rows are upserted per (enrollment, date, session); a change of an existing value by a *different* user is allowed only for admins within-window or per the lock rule, and always audited with old→new values. "Silent last-write-wins between two teachers" is removed: a second teacher (co-assigned) submitting differing values gets 409 `ATTENDANCE_CONFLICT` listing the diffs, resolvable by admin.
- **Leave integration:** when a student Leave is APPROVED, a job writes/overwrites `ON_LEAVE` for each in-range (date, session) and locks those cells against teacher edits for the leave range. Absence SMS never fires for ON_LEAVE.
- **Absence SMS:** fires for `ABSENT` only (not LATE/HALF_DAY), to the primary guardian, once per (student, date) — deduplicated by an idempotency key `absence:{enrollmentId}:{date}` even if attendance is re-submitted. Batch guardian lookup (one query per section submission, no N+1).
- **Staff attendance:** per (staffId, date, session) mirroring student sessions; check-in/out timestamps optional; feeds payroll deductions (§13).

## 10. Leave Management

`Leave` rows are **either** student or staff leaves — modeled as two tables (`StudentLeave`, `StaffLeave`) to eliminate the XOR-nullable defect. Common machine: `PENDING → APPROVED | REJECTED` (terminal; `CANCELLED` allowed by requester while PENDING). Rejection requires `rejectionReason`. Overlap rule: a new leave overlapping an existing PENDING/APPROVED leave for the same person → 409. Staff leaves carry `leaveType (CASUAL|SICK|UNPAID|OTHER)` with per-type annual quotas in `Setting.staffLeaveQuotas`; exceeding quota auto-flags the request `UNPAID` unless admin overrides. Approvers: CAMPUS_ADMIN/OWNER_ADMIN (student & staff); a teacher may file for their own section's student on a parent's behalf (source recorded).

## 11. Examinations, Grading & Report Cards

- `GradeScale` per school (rows: label "A+", minPercent, maxPercent, gradePoint). Exactly one active scale per school per year; grades are **computed at read/publish time** from the scale — `ExamResult.grade` stored column is removed (derived data).
- `Term` per academic year (e.g., Term 1, Term 2). Each `ExamDefinition` belongs to a term and has `weightagePercent`. **Validation:** the sum of weightages of a class's exams within a term must equal 100 before that term's report cards can be generated (checked at generation, error `WEIGHTAGE_SUM_INVALID` listing the sum).
- **Term result formula (authoritative):** for each subject, `termPercent = Σ over exams (marksObtained/totalMarks × weightagePercent)`; absent-in-exam ⇒ `isAbsent=true`, `marksObtained=null`, contributes 0 to that exam's weighted share and the report card prints "ABS" for that exam. Overall = mean of subject termPercents (equal subject weighting v1; per-subject credit weighting is v2). Rank = dense rank by overall percent within the section (ties share rank; next rank skips: 1,1,3); students absent from **all** exams are unranked.
- **Marks entry:** teachers enter marks only for assigned (section, subject) pairs (§22.8); `marksObtained ≤ totalMarks` (422 otherwise); bulk endpoint is upsert with per-row error reporting (§25 partial-failure contract).
- **Publication & locking:** `ExamDefinition.status: DRAFT → MARKS_ENTRY → PUBLISHED` (admin action). Students see results **only when PUBLISHED**, and guardians learn of them by the result-ready SMS rather than in a portal (§5). After PUBLISHED, a mark change requires OWNER_ADMIN, a reason, writes AuditLog (old→new), regenerates the affected report-card PDF (old S3 object version retained), and re-sends the result SMS flagged "Corrected". Completeness gate for publishing: every (enrolled student × subject assigned to the class) has a mark or `isAbsent` — the publish endpoint returns the missing list otherwise (422 `RESULTS_INCOMPLETE`).
- **Report cards:** generated per term by a queued job; PDFs to S3; a `Document` row (type `REPORT_CARD`) per student; parents access via short-lived pre-signed URLs (§22.6). SMS "result ready" to primary guardian after PDF upload succeeds.

## 12. Fee Management (complete rules)

**Fee structures.** `FeeStructure` per (school, campus, class, feeHead, academicYear): `amount`, `frequency (MONTHLY|ANNUAL|ONE_TIME|ADMISSION)`. Editing a structure never mutates already-generated invoices; it affects future generation only.

**Invoice generation.** `POST /fees/invoice-batches` with `{classId, month, year}` creates a `FeeInvoiceBatch` (unique `[schoolId, classId, month, year]` → duplicate attempt returns the existing batch, 200, `alreadyExists: true` — inherently idempotent; audit C-5). The queued job creates one invoice per ACTIVE enrollment: line items from MONTHLY structures (+ ANNUAL in the configured month), applies discounts/scholarships (below), sets `dueDate = Setting.feeDueDay` of the month. Per-student idempotency: partial unique `[schoolId, studentId, month, year] WHERE batch_generated = true`. New mid-month admissions: pro-rating per `Setting.midMonthProration (FULL|HALF|DAILY)`, default FULL.

**Discounts & scholarships (unified).** `Discount`: (`studentId`, `type PERCENT|FIXED`, `value`, `appliesTo feeHeadId|ALL`, `validFrom/To`, `reason`, `approvedById` FK, `status ACTIVE|REVOKED`). Sibling discount: a school-level rule (`Setting.siblingDiscountPercent`, applied automatically to the 2nd+ enrolled sibling by guardian linkage, shown as a distinct line). Discounts apply **at generation time** as negative line items on the invoice (transparent on the printed bill). Stacking: FIXED applied after PERCENT; total discount capped at 100% of the head. Revoking a discount affects future invoices only.

**Fines / late fees.** `LateFeePolicy` per school (nullable = no fines): `graceDays`, `mode FLAT|PER_DAY`, `amount`, `maxAmount`. The nightly `mark-overdue` job (§27) sets `status=OVERDUE` past `dueDate+graceDays` and appends/updates a single FINE line item per policy. Fine waiver = admin action reducing/removing the fine line, requires reason + AuditLog.

**Payments.** `POST /fees/invoices/:id/payments` requires header `Idempotency-Key` (§25.4). Inside one serializable transaction: lock the invoice row (`SELECT … FOR UPDATE`), validate `amountPaid ≤ remaining` (overpayment → 422 directing to the advance endpoint), insert `FeePayment` with school-scoped sequential `receiptNo` (per-school counter, gap-free within the transaction), recompute `paidAmount` (stored on invoice) and status (`PARTIAL`/`PAID`), write AuditLog if any waiver involved, enqueue receipt SMS. `transactionRef` mandatory for non-CASH methods; unique `[schoolId, method, transactionRef]` where present.

**Advances & credits.** `GuardianCredit` ledger per parent: deposits (`POST /fees/advances`), auto-application to newly generated invoices (oldest first) before SMS reminder, refundable by reversal. This is the `FeeAdvance` the old doc referenced but never modeled.

**Reversals / refunds.** Payments are immutable. Corrections via `PaymentReversal` (FK to payment, reason, approvedById, own receipt number prefixed `RV-`); invoice `paidAmount`/status recomputed. Only OWNER_ADMIN approves reversals. Nightly reconciliation job compares gateway/bank records vs DB (v1: CSV import reconciliation; v2: gateway API).

**Waivers.** `status=WAIVED` set only by OWNER_ADMIN with reason; a waiver zeroes remaining balance via a WAIVER line item (auditable, printable), never by editing totals.

**Invariants (DB-checked where possible, service-checked otherwise):** `invoice.totalAmount = Σ items.amount` (recomputed on any item change); `invoice.paidAmount = Σ payments − Σ reversals` (maintained transactionally, verified by nightly integrity job); status derives strictly from `paidAmount` vs `totalAmount` and due date.

**Status machine:** `PENDING → PARTIAL → PAID`; `PENDING|PARTIAL → OVERDUE` (job) `→ PARTIAL|PAID` on payment; `PENDING|PARTIAL|OVERDUE → WAIVED` (terminal); `PAID` terminal except reversal reopening to PARTIAL/PENDING.

## 13. Staff, HR & Payroll

`StaffProfile` replaces TeacherProfile and covers **all** employees (`staffType TEACHER|ADMIN|ACCOUNTANT|CLERK|SUPPORT`), with `employeeCode` unique per school, `designation`, `employmentStatus (ACTIVE|ON_LEAVE|TERMINATED)`, `joinedAt`, `leftAt?`. Users with TEACHER/ACCOUNTANT/CAMPUS_ADMIN/STAFF roles must have a StaffProfile (service invariant).

`SalaryStructure` per staff (effective-dated): `basic`, `allowances Json` (name→amount), `deductionsFixed Json`. **Payroll run** (monthly, per campus, OWNER_ADMIN triggers; queued job; unique `[schoolId, campusId, month, year]`): per staff, `gross = basic + Σ allowances`; attendance-linked deduction = `(unpaidLeaveDays + unexcusedAbsentDays) × (basic / workingDaysInMonth)` where workingDays excludes holidays/weekly-offs; `netPay = gross − fixedDeductions − attendanceDeduction`. Output `Payslip` rows in DRAFT; OWNER_ADMIN reviews and marks the run APPROVED (locks payslips); disbursement recorded per payslip (`paidAt`, `method`, `reference`). Bank account numbers encrypted (§32). Payslip PDF via the document pipeline; staff see own payslips only.

## 14. Communication (SMS v1; in-app/email v1.5)

Templates: `SmsTemplate` per school per trigger (`FEE_REMINDER`, `FEE_RECEIPT`, `ABSENCE`, `RESULT_READY`, `LEAVE_STATUS`, `ACCOUNT_INVITE`, `MANUAL`) with `{placeholders}`; defaults seeded, editable by OWNER_ADMIN. Length/segmentation computed for GSM-7 vs UCS-2 (Urdu) and shown before send; credits charged per segment.
Credits: `SmsCreditLedger` per school (top-ups by PLATFORM_ADMIN per plan/purchase; every send debits; balance ≤ 0 blocks non-critical sends — ABSENCE and FEE_RECEIPT still send into a small negative buffer, `Setting.smsOverdraftSegments`, default 100). Plan tiers cap monthly included credits (BASIC 1k / PLUS 5k / PRO 20k) — this is the concrete meaning of `PlanTier` for SMS.
Every `SmsLog` row links `studentId?`, `userId?`, `invoiceId?`, `templateKey`, `segments`, `gatewayMessageId`. Delivery webhooks: `POST /webhooks/sms/:provider` (HMAC-verified) updates QUEUED→SENT→DELIVERED/FAILED. Failed sends retry ×3 exponential backoff then surface in the admin "Failed messages" screen with one-click re-queue. Recipient rules: primary guardian only, `phoneVerifiedAt` set via one-time OTP at first invite (unverified numbers receive only the invite OTP, nothing containing student PII — closes the mistyped-number leak). Opt-out flag per guardian honored for MANUAL sends; transactional sends always allowed.

## 15. Documents & Certificates

`Document` model (renames Certificate): `type` enum `LEAVING_CERT | CHARACTER_CERT | FEE_CLEARANCE | REPORT_CARD | PAYSLIP | RECEIPT`. Issuance endpoints for the three certificates require: fee clearance check (LEAVING_CERT blocked while unpaid invoices exist unless OWNER_ADMIN overrides with reason). Student withdrawal workflow: admin initiates → system checks fees → issues FEE_CLEARANCE then LEAVING_CERT → closes enrollment as WITHDRAWN → deactivates student portal account. All files in S3 with versioning; access only via 10-minute pre-signed URLs issued after an ownership check.

---

# PART III — DATA MODEL

## 16. Architecture Shape

A **modular monolith**: one NestJS deployable with strict module boundaries (`admissions`, `students`, `attendance`, `exams`, `fees`, `hr`, `comms`, `documents`, `platform`, `common`). Modules communicate through exported services only (ESLint boundary rules enforce import direction). Background work runs in a second deployable (`worker`) sharing the codebase, consuming BullMQ queues. This preserves microservice-extraction optionality without paying distributed-systems cost at this scale.

## 17. Prisma Schema (authoritative)

Conventions (mandatory): every model `@@map`s to snake_case table; every field `@map`s to snake_case; PKs `String @id @default(uuid()) @db.Uuid`; every tenant table's first scalar is `schoolId String @db.Uuid` **with a real relation to School**; every mutable table has `createdAt`, `updatedAt @updatedAt`, `createdById String? @db.Uuid`; money is `Decimal @db.Decimal(12, 2)`; soft delete via `deletedAt DateTime?` (models noted); Prisma relation default `onDelete: Restrict` everywhere except explicitly noted `Cascade` on pure child tables (invoice items, guardian links). Child rows that carry a denormalized `schoolId` also carry a composite FK `(parentId, schoolId)` to the parent's `@@unique([id, schoolId])` — the DB itself guarantees the tenant chain is consistent (audit H-3).

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

// ── Enums ────────────────────────────────────────────────
// PARENT is retained for pre-2026-07-28 rows and never granted to new accounts (§5).
enum Role { PLATFORM_ADMIN OWNER_ADMIN CAMPUS_ADMIN ADMISSION_CONTROLLER HR_MANAGER ACCOUNTANT TEACHER STAFF PARENT STUDENT }
enum PlanTier { BASIC PLUS PRO }
enum Gender { MALE FEMALE OTHER }
enum InquiryStatus { INQUIRY ENTRY_TEST_SCHEDULED ENTRY_TEST_PASSED ENTRY_TEST_FAILED ADMITTED REJECTED WITHDRAWN }
enum EnrollmentStatus { ACTIVE PROMOTED RETAINED TRANSFERRED_OUT WITHDRAWN COMPLETED }
enum GuardianRelation { FATHER MOTHER GUARDIAN }
enum FeeFrequency { MONTHLY ANNUAL ONE_TIME ADMISSION }
enum FeeInvoiceStatus { PENDING PARTIAL PAID OVERDUE WAIVED }
enum InvoiceItemType { FEE DISCOUNT FINE WAIVER }
enum PaymentMethod { CASH BANK_TRANSFER EASYPAISA JAZZCASH CARD CHEQUE }
enum AttendanceStatus { PRESENT ABSENT LATE HALF_DAY ON_LEAVE }
enum AttendanceSession { MORNING EVENING }
enum LeaveStatus { PENDING APPROVED REJECTED CANCELLED }
enum StaffLeaveType { CASUAL SICK UNPAID OTHER }
enum ExamType { MONTHLY MID_TERM FINAL SURPRISE_TEST }
enum ExamStatus { DRAFT MARKS_ENTRY PUBLISHED }
enum SmsStatus { QUEUED SENT DELIVERED FAILED }
enum StaffType { TEACHER ADMIN ACCOUNTANT CLERK SUPPORT }
enum EmploymentStatus { ACTIVE ON_LEAVE TERMINATED }
enum DocumentType { LEAVING_CERT CHARACTER_CERT FEE_CLEARANCE REPORT_CARD PAYSLIP RECEIPT }
enum UserStatus { INVITED ACTIVE LOCKED DISABLED }
enum PayrollRunStatus { DRAFT APPROVED }
enum DiscountType { PERCENT FIXED }
enum DiscountStatus { ACTIVE REVOKED }

// ── Tenant root & platform ───────────────────────────────
model School {
  id            String   @id @default(uuid()) @db.Uuid
  name          String
  subdomain     String   @unique
  customDomain  String?  @unique @map("custom_domain")
  planTier      PlanTier @default(BASIC) @map("plan_tier")
  isActive      Boolean  @default(true) @map("is_active")
  suspendedAt   DateTime? @map("suspended_at")
  grNumberMode  String   @default("AUTO") @map("gr_number_mode") // AUTO | MANUAL
  grPrefix      String   @default("") @map("gr_prefix")
  nextGrNumber  Int      @default(1) @map("next_gr_number")
  nextReceiptNo Int      @default(1) @map("next_receipt_no")
  settings      Json     @default("{}") // typed via Zod schema `SchoolSettings` in code (see §17.1)
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")
  // relations: campuses, users, students, academicYears, ... (every tenant model)
  @@map("schools")
}

model Campus {
  id        String  @id @default(uuid()) @db.Uuid
  schoolId  String  @map("school_id") @db.Uuid
  school    School  @relation(fields: [schoolId], references: [id])
  name      String
  address   String?
  isActive  Boolean @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  @@unique([id, schoolId])          // composite target for child tenant-chain FKs
  @@unique([schoolId, name])
  @@map("campuses")
}

model AcademicYear {
  id        String   @id @default(uuid()) @db.Uuid
  schoolId  String   @map("school_id") @db.Uuid
  school    School   @relation(fields: [schoolId], references: [id])
  name      String                     // "2026-27"
  startDate DateTime @map("start_date") @db.Date
  endDate   DateTime @map("end_date") @db.Date
  isCurrent Boolean  @default(false) @map("is_current")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  @@unique([id, schoolId])
  @@unique([schoolId, name])
  // Partial unique in SQL migration: one is_current=true per school
  @@map("academic_years")
}

model Class {
  id          String  @id @default(uuid()) @db.Uuid
  schoolId    String  @map("school_id") @db.Uuid
  school      School  @relation(fields: [schoolId], references: [id])
  campusId    String  @map("campus_id") @db.Uuid
  campus      Campus  @relation(fields: [campusId, schoolId], references: [id, schoolId])
  name        String                    // "Grade 5"
  order       Int                       // Nursery=0, Grade1=1 …
  minAgeYears Int?    @map("min_age_years")
  maxAgeYears Int?    @map("max_age_years")
  isActive    Boolean @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  @@unique([id, schoolId])
  @@unique([campusId, name])
  @@index([schoolId, campusId])
  @@map("classes")
}

model Section {
  id        String  @id @default(uuid()) @db.Uuid
  schoolId  String  @map("school_id") @db.Uuid
  school    School  @relation(fields: [schoolId], references: [id])
  classId   String  @map("class_id") @db.Uuid
  class     Class   @relation(fields: [classId, schoolId], references: [id, schoolId])
  name      String                      // "A"
  capacity  Int     @default(40)
  isActive  Boolean @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  @@unique([id, schoolId])
  @@unique([classId, name])
  @@index([schoolId, classId])
  @@map("sections")
}

model Subject {
  id       String  @id @default(uuid()) @db.Uuid
  schoolId String  @map("school_id") @db.Uuid
  school   School  @relation(fields: [schoolId], references: [id])
  classId  String  @map("class_id") @db.Uuid
  class    Class   @relation(fields: [classId, schoolId], references: [id, schoolId])
  name     String
  isActive Boolean @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  @@unique([id, schoolId])
  @@unique([classId, name])
  @@map("subjects")
}

model Holiday {
  id       String   @id @default(uuid()) @db.Uuid
  schoolId String   @map("school_id") @db.Uuid
  school   School   @relation(fields: [schoolId], references: [id])
  date     DateTime @db.Date
  name     String
  campusId String?  @map("campus_id") @db.Uuid   // null = all campuses
  @@unique([schoolId, date, campusId])
  @@map("holidays")
}

// ── Identity ─────────────────────────────────────────────
model User {
  id                 String     @id @default(uuid()) @db.Uuid
  schoolId           String     @map("school_id") @db.Uuid
  school             School     @relation(fields: [schoolId], references: [id])
  campusId           String?    @map("campus_id") @db.Uuid
  campus             Campus?    @relation(fields: [campusId, schoolId], references: [id, schoolId])
  email              String
  phone              String?
  passwordHash       String?    @map("password_hash")        // null while INVITED
  roles              Role[]
  status             UserStatus @default(INVITED)
  failedLoginCount   Int        @default(0) @map("failed_login_count")
  lockedUntil        DateTime?  @map("locked_until")
  mfaSecretEnc       String?    @map("mfa_secret_enc")       // encrypted TOTP secret
  mfaEnabled         Boolean    @default(false) @map("mfa_enabled")
  passwordChangedAt  DateTime?  @map("password_changed_at")
  lastLoginAt        DateTime?  @map("last_login_at")
  deletedAt          DateTime?  @map("deleted_at")
  createdAt          DateTime   @default(now()) @map("created_at")
  updatedAt          DateTime   @updatedAt @map("updated_at")
  @@unique([id, schoolId])
  @@unique([schoolId, email])
  @@index([schoolId], map: "users_school_idx")
  @@map("users")
}

model RefreshToken {
  id          String    @id @default(uuid()) @db.Uuid
  schoolId    String    @map("school_id") @db.Uuid
  userId      String    @map("user_id") @db.Uuid
  user        User      @relation(fields: [userId, schoolId], references: [id, schoolId])
  tokenHash   String    @unique @map("token_hash")   // SHA-256 of the token; raw never stored
  familyId    String    @map("family_id") @db.Uuid   // rotation family; reuse ⇒ revoke family
  expiresAt   DateTime  @map("expires_at")
  revokedAt   DateTime? @map("revoked_at")
  ip          String?
  userAgent   String?   @map("user_agent")
  createdAt   DateTime  @default(now()) @map("created_at")
  @@index([userId, familyId])
  @@map("refresh_tokens")
}

model PasswordResetToken {
  id        String    @id @default(uuid()) @db.Uuid
  schoolId  String    @map("school_id") @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  tokenHash String    @unique @map("token_hash")
  expiresAt DateTime  @map("expires_at")            // 30 min
  usedAt    DateTime? @map("used_at")
  createdAt DateTime  @default(now()) @map("created_at")
  @@map("password_reset_tokens")
}

// ── People ───────────────────────────────────────────────
model ParentProfile {
  id              String   @id @default(uuid()) @db.Uuid
  schoolId        String   @map("school_id") @db.Uuid
  school          School   @relation(fields: [schoolId], references: [id])
  // Nullable since 2026-07-29: a guardian is a contact record, not an account. New rows are null;
  // rows created before the parent portal was removed keep their link.
  userId          String?  @map("user_id") @db.Uuid
  user            User?    @relation(fields: [userId, schoolId], references: [id, schoolId])
  fullName        String   @map("full_name")
  // The guardian's own contact email. Not a login: no uniqueness, and no auth path reads it.
  email           String?
  phone           String                              // normalized E.164
  phoneVerifiedAt DateTime? @map("phone_verified_at")
  smsOptOut       Boolean  @default(false) @map("sms_opt_out")
  cnicEnc         String?  @map("cnic_enc")           // AES-256-GCM, per-tenant KMS data key
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")
  @@unique([id, schoolId])
  @@unique([userId])
  @@index([schoolId, phone])
  @@map("parent_profiles")
}

model Student {
  id          String   @id @default(uuid()) @db.Uuid
  schoolId    String   @map("school_id") @db.Uuid
  school      School   @relation(fields: [schoolId], references: [id])
  userId      String?  @unique @map("user_id") @db.Uuid   // student portal login (audit C-8)
  grNumber    String   @map("gr_number")
  fullName    String   @map("full_name")
  gender      Gender
  dateOfBirth DateTime @map("date_of_birth") @db.Date
  photoKey    String?  @map("photo_key")
  isActive    Boolean  @default(true) @map("is_active")
  deletedAt   DateTime? @map("deleted_at")
  createdById String?  @map("created_by_id") @db.Uuid
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  @@unique([id, schoolId])
  @@unique([schoolId, grNumber])
  @@map("students")
}

model StudentGuardian {
  id        String           @id @default(uuid()) @db.Uuid
  schoolId  String           @map("school_id") @db.Uuid
  studentId String           @map("student_id") @db.Uuid
  student   Student          @relation(fields: [studentId, schoolId], references: [id, schoolId], onDelete: Cascade)
  parentId  String           @map("parent_id") @db.Uuid
  parent    ParentProfile    @relation(fields: [parentId, schoolId], references: [id, schoolId])
  relation  GuardianRelation
  isPrimary Boolean          @default(false) @map("is_primary")
  @@unique([studentId, parentId])
  // Partial unique in SQL migration: one is_primary=true per student
  @@index([schoolId, parentId])
  @@map("student_guardians")
}

model StudentEnrollment {
  id             String           @id @default(uuid()) @db.Uuid
  schoolId       String           @map("school_id") @db.Uuid
  school         School           @relation(fields: [schoolId], references: [id])
  studentId      String           @map("student_id") @db.Uuid
  student        Student          @relation(fields: [studentId, schoolId], references: [id, schoolId])
  academicYearId String           @map("academic_year_id") @db.Uuid
  academicYear   AcademicYear     @relation(fields: [academicYearId, schoolId], references: [id, schoolId])
  campusId       String           @map("campus_id") @db.Uuid
  classId        String           @map("class_id") @db.Uuid
  sectionId      String           @map("section_id") @db.Uuid
  section        Section          @relation(fields: [sectionId, schoolId], references: [id, schoolId])
  rollNumber     Int?             @map("roll_number")
  status         EnrollmentStatus @default(ACTIVE)
  startedAt      DateTime         @default(now()) @map("started_at")
  endedAt        DateTime?        @map("ended_at")
  createdAt      DateTime         @default(now()) @map("created_at")
  updatedAt      DateTime         @updatedAt @map("updated_at")
  @@unique([id, schoolId])
  // Partial unique in SQL migration: one status=ACTIVE per (student, academic_year)
  @@unique([sectionId, academicYearId, rollNumber])
  @@index([schoolId, academicYearId, sectionId, status])
  @@index([studentId])
  @@map("student_enrollments")
}

model StaffProfile {
  id               String           @id @default(uuid()) @db.Uuid
  schoolId         String           @map("school_id") @db.Uuid
  school           School           @relation(fields: [schoolId], references: [id])
  userId           String           @unique @map("user_id") @db.Uuid
  user             User             @relation(fields: [userId, schoolId], references: [id, schoolId])
  staffType        StaffType        @map("staff_type")
  employeeCode     String           @map("employee_code")
  designation      String
  employmentStatus EmploymentStatus @default(ACTIVE) @map("employment_status")
  joinedAt         DateTime         @map("joined_at") @db.Date
  leftAt           DateTime?        @map("left_at") @db.Date
  bankAccountEnc   String?          @map("bank_account_enc")
  createdAt        DateTime         @default(now()) @map("created_at")
  updatedAt        DateTime         @updatedAt @map("updated_at")
  @@unique([id, schoolId])
  @@unique([schoolId, employeeCode])
  @@map("staff_profiles")
}

model TeacherAssignment {
  id             String       @id @default(uuid()) @db.Uuid
  schoolId       String       @map("school_id") @db.Uuid
  school         School       @relation(fields: [schoolId], references: [id])
  staffId        String       @map("staff_id") @db.Uuid
  staff          StaffProfile @relation(fields: [staffId, schoolId], references: [id, schoolId])
  academicYearId String       @map("academic_year_id") @db.Uuid
  sectionId      String       @map("section_id") @db.Uuid
  subjectId      String?      @map("subject_id") @db.Uuid   // null ⇒ homeroom/class-teacher of the section
  createdAt      DateTime     @default(now()) @map("created_at")
  @@unique([staffId, academicYearId, sectionId, subjectId])
  @@index([schoolId, academicYearId, sectionId])
  @@map("teacher_assignments")
}

// ── Admissions ───────────────────────────────────────────
model Inquiry {
  id             String        @id @default(uuid()) @db.Uuid
  schoolId       String        @map("school_id") @db.Uuid
  school         School        @relation(fields: [schoolId], references: [id])
  campusId       String        @map("campus_id") @db.Uuid
  campus         Campus        @relation(fields: [campusId, schoolId], references: [id, schoolId])
  guardianName   String        @map("guardian_name")
  guardianPhone  String        @map("guardian_phone")     // normalized E.164
  studentName    String        @map("student_name")
  desiredClassId String        @map("desired_class_id") @db.Uuid
  status         InquiryStatus @default(INQUIRY)
  statusReason   String?       @map("status_reason")      // required for REJECTED/WITHDRAWN
  createdById    String?       @map("created_by_id") @db.Uuid
  createdAt      DateTime      @default(now()) @map("created_at")
  updatedAt      DateTime      @updatedAt @map("updated_at")
  @@unique([id, schoolId])
  @@index([schoolId, campusId, status])
  @@index([schoolId, guardianPhone])
  @@map("inquiries")
}

model EntryTest {
  id          String   @id @default(uuid()) @db.Uuid
  schoolId    String   @map("school_id") @db.Uuid
  inquiryId   String   @unique @map("inquiry_id") @db.Uuid
  inquiry     Inquiry  @relation(fields: [inquiryId, schoolId], references: [id, schoolId])
  scheduledAt DateTime @map("scheduled_at")
  score       Decimal? @db.Decimal(5, 2)
  remarks     String?
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  @@map("entry_tests")
}

model Admission {
  id         String   @id @default(uuid()) @db.Uuid
  schoolId   String   @map("school_id") @db.Uuid
  inquiryId  String   @unique @map("inquiry_id") @db.Uuid
  inquiry    Inquiry  @relation(fields: [inquiryId, schoolId], references: [id, schoolId])
  studentId  String   @unique @map("student_id") @db.Uuid
  student    Student  @relation(fields: [studentId, schoolId], references: [id, schoolId])
  admittedAt DateTime @default(now()) @map("admitted_at")
  admittedById String @map("admitted_by_id") @db.Uuid
  @@map("admissions")
}

// ── Fees ─────────────────────────────────────────────────
model FeeHead {
  id       String @id @default(uuid()) @db.Uuid
  schoolId String @map("school_id") @db.Uuid
  school   School @relation(fields: [schoolId], references: [id])
  name     String            // "Tuition", "Annual Fund", "Exam Fee"
  @@unique([id, schoolId])
  @@unique([schoolId, name])
  @@map("fee_heads")
}

model FeeStructure {
  id             String       @id @default(uuid()) @db.Uuid
  schoolId       String       @map("school_id") @db.Uuid
  school         School       @relation(fields: [schoolId], references: [id])
  campusId       String       @map("campus_id") @db.Uuid
  classId        String       @map("class_id") @db.Uuid
  class          Class        @relation(fields: [classId, schoolId], references: [id, schoolId])
  feeHeadId      String       @map("fee_head_id") @db.Uuid
  feeHead        FeeHead      @relation(fields: [feeHeadId, schoolId], references: [id, schoolId])
  academicYearId String       @map("academic_year_id") @db.Uuid
  amount         Decimal      @db.Decimal(12, 2)
  frequency      FeeFrequency
  isActive       Boolean      @default(true) @map("is_active")
  createdAt      DateTime     @default(now()) @map("created_at")
  updatedAt      DateTime     @updatedAt @map("updated_at")
  @@unique([classId, feeHeadId, academicYearId, frequency])
  @@index([schoolId, campusId, classId])
  @@map("fee_structures")
}

model FeeInvoiceBatch {
  id             String   @id @default(uuid()) @db.Uuid
  schoolId       String   @map("school_id") @db.Uuid
  school         School   @relation(fields: [schoolId], references: [id])
  classId        String   @map("class_id") @db.Uuid
  academicYearId String   @map("academic_year_id") @db.Uuid
  month          Int
  year           Int
  status         String   @default("QUEUED") // QUEUED | RUNNING | DONE | FAILED
  createdById    String   @map("created_by_id") @db.Uuid
  createdAt      DateTime @default(now()) @map("created_at")
  @@unique([schoolId, classId, month, year])   // idempotent generation (audit C-5)
  @@map("fee_invoice_batches")
}

model FeeInvoice {
  id           String           @id @default(uuid()) @db.Uuid
  schoolId     String           @map("school_id") @db.Uuid
  school       School           @relation(fields: [schoolId], references: [id])
  studentId    String           @map("student_id") @db.Uuid
  student      Student          @relation(fields: [studentId, schoolId], references: [id, schoolId])
  enrollmentId String           @map("enrollment_id") @db.Uuid
  enrollment   StudentEnrollment @relation(fields: [enrollmentId, schoolId], references: [id, schoolId])
  batchId      String?          @map("batch_id") @db.Uuid
  totalAmount  Decimal          @map("total_amount") @db.Decimal(12, 2)
  paidAmount   Decimal          @default(0) @map("paid_amount") @db.Decimal(12, 2)  // stored, maintained transactionally
  dueDate      DateTime         @map("due_date") @db.Date
  status       FeeInvoiceStatus @default(PENDING)
  month        Int?
  year         Int
  createdAt    DateTime         @default(now()) @map("created_at")
  updatedAt    DateTime         @updatedAt @map("updated_at")
  items        FeeInvoiceItem[]
  payments     FeePayment[]
  @@unique([id, schoolId])
  // Partial unique in SQL migration: one batch-generated invoice per (student, month, year)
  @@index([schoolId, studentId, status])
  @@index([schoolId, status, dueDate])
  @@map("fee_invoices")
}

model FeeInvoiceItem {
  id        String          @id @default(uuid()) @db.Uuid
  schoolId  String          @map("school_id") @db.Uuid
  invoiceId String          @map("invoice_id") @db.Uuid
  invoice   FeeInvoice      @relation(fields: [invoiceId, schoolId], references: [id, schoolId], onDelete: Cascade)
  type      InvoiceItemType @default(FEE)
  feeHeadId String?         @map("fee_head_id") @db.Uuid
  description String
  amount    Decimal         @db.Decimal(12, 2)   // negative for DISCOUNT/WAIVER
  @@index([invoiceId])
  @@map("fee_invoice_items")
}

model FeePayment {
  id             String        @id @default(uuid()) @db.Uuid
  schoolId       String        @map("school_id") @db.Uuid
  school         School        @relation(fields: [schoolId], references: [id])
  invoiceId      String        @map("invoice_id") @db.Uuid
  invoice        FeeInvoice    @relation(fields: [invoiceId, schoolId], references: [id, schoolId])
  receiptNo      Int           @map("receipt_no")           // per-school sequence
  amountPaid     Decimal       @map("amount_paid") @db.Decimal(12, 2)
  method         PaymentMethod
  transactionRef String?       @map("transaction_ref")
  collectedById  String        @map("collected_by_id") @db.Uuid
  collectedBy    User          @relation(fields: [collectedById, schoolId], references: [id, schoolId])
  paidAt         DateTime      @default(now()) @map("paid_at")
  @@unique([id, schoolId])
  @@unique([schoolId, receiptNo])
  // Partial unique in SQL migration: [schoolId, method, transactionRef] where transaction_ref not null
  @@index([schoolId, paidAt])
  @@map("fee_payments")
}

model PaymentReversal {
  id           String     @id @default(uuid()) @db.Uuid
  schoolId     String     @map("school_id") @db.Uuid
  paymentId    String     @unique @map("payment_id") @db.Uuid
  payment      FeePayment @relation(fields: [paymentId, schoolId], references: [id, schoolId])
  receiptNo    Int        @map("receipt_no")               // shares the school sequence, printed "RV-{n}"
  reason       String
  approvedById String     @map("approved_by_id") @db.Uuid
  createdAt    DateTime   @default(now()) @map("created_at")
  @@unique([schoolId, receiptNo])
  @@map("payment_reversals")
}

model Discount {
  id           String         @id @default(uuid()) @db.Uuid
  schoolId     String         @map("school_id") @db.Uuid
  school       School         @relation(fields: [schoolId], references: [id])
  studentId    String         @map("student_id") @db.Uuid
  student      Student        @relation(fields: [studentId, schoolId], references: [id, schoolId])
  type         DiscountType
  value        Decimal        @db.Decimal(12, 2)   // percent (0–100) or fixed amount
  feeHeadId    String?        @map("fee_head_id") @db.Uuid   // null = all heads
  reason       String
  status       DiscountStatus @default(ACTIVE)
  validFrom    DateTime       @map("valid_from") @db.Date
  validTo      DateTime?      @map("valid_to") @db.Date
  approvedById String         @map("approved_by_id") @db.Uuid
  approvedBy   User           @relation(fields: [approvedById, schoolId], references: [id, schoolId])
  createdAt    DateTime       @default(now()) @map("created_at")
  updatedAt    DateTime       @updatedAt @map("updated_at")
  @@index([schoolId, studentId, status])
  @@map("discounts")
}

model LateFeePolicy {
  id        String  @id @default(uuid()) @db.Uuid
  schoolId  String  @unique @map("school_id") @db.Uuid
  school    School  @relation(fields: [schoolId], references: [id])
  graceDays Int     @default(0) @map("grace_days")
  mode      String                                 // FLAT | PER_DAY
  amount    Decimal @db.Decimal(12, 2)
  maxAmount Decimal? @map("max_amount") @db.Decimal(12, 2)
  isActive  Boolean @default(true) @map("is_active")
  @@map("late_fee_policies")
}

model GuardianCredit {
  id        String   @id @default(uuid()) @db.Uuid
  schoolId  String   @map("school_id") @db.Uuid
  parentId  String   @map("parent_id") @db.Uuid
  amount    Decimal  @db.Decimal(12, 2)     // positive = deposit, negative = applied/refunded
  refType   String   @map("ref_type")       // DEPOSIT | APPLIED_TO_INVOICE | REFUND
  refId     String?  @map("ref_id") @db.Uuid
  createdById String @map("created_by_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")
  @@index([schoolId, parentId])
  @@map("guardian_credits")
}

// ── Attendance & leaves ──────────────────────────────────
model AttendanceRecord {
  id           String            @id @default(uuid()) @db.Uuid
  schoolId     String            @map("school_id") @db.Uuid
  school       School            @relation(fields: [schoolId], references: [id])
  enrollmentId String            @map("enrollment_id") @db.Uuid
  enrollment   StudentEnrollment @relation(fields: [enrollmentId, schoolId], references: [id, schoolId])
  date         DateTime          @db.Date
  session      AttendanceSession
  status       AttendanceStatus
  markedById   String            @map("marked_by_id") @db.Uuid
  markedBy     User              @relation(fields: [markedById, schoolId], references: [id, schoolId])
  lockedByLeaveId String?        @map("locked_by_leave_id") @db.Uuid
  createdAt    DateTime          @default(now()) @map("created_at")
  updatedAt    DateTime          @updatedAt @map("updated_at")
  @@unique([enrollmentId, date, session])
  @@index([schoolId, date])
  @@map("attendance_records")
}

model StaffAttendance {
  id       String            @id @default(uuid()) @db.Uuid
  schoolId String            @map("school_id") @db.Uuid
  staffId  String            @map("staff_id") @db.Uuid
  staff    StaffProfile      @relation(fields: [staffId, schoolId], references: [id, schoolId])
  date     DateTime          @db.Date
  session  AttendanceSession @default(MORNING)
  status   AttendanceStatus
  checkIn  DateTime?         @map("check_in")
  checkOut DateTime?         @map("check_out")
  createdAt DateTime         @default(now()) @map("created_at")
  updatedAt DateTime         @updatedAt @map("updated_at")
  @@unique([staffId, date, session])
  @@index([schoolId, date])
  @@map("staff_attendance")
}

model StudentLeave {
  id              String      @id @default(uuid()) @db.Uuid
  schoolId        String      @map("school_id") @db.Uuid
  school          School      @relation(fields: [schoolId], references: [id])
  studentId       String      @map("student_id") @db.Uuid
  student         Student     @relation(fields: [studentId, schoolId], references: [id, schoolId])
  fromDate        DateTime    @map("from_date") @db.Date
  toDate          DateTime    @map("to_date") @db.Date
  reason          String
  status          LeaveStatus @default(PENDING)
  rejectionReason String?     @map("rejection_reason")
  requestedById   String      @map("requested_by_id") @db.Uuid
  decidedById     String?     @map("decided_by_id") @db.Uuid
  decidedAt       DateTime?   @map("decided_at")
  createdAt       DateTime    @default(now()) @map("created_at")
  updatedAt       DateTime    @updatedAt @map("updated_at")
  @@index([schoolId, status])
  @@index([studentId, fromDate, toDate])
  @@map("student_leaves")
}

model StaffLeave {
  id              String         @id @default(uuid()) @db.Uuid
  schoolId        String         @map("school_id") @db.Uuid
  school          School         @relation(fields: [schoolId], references: [id])
  staffId         String         @map("staff_id") @db.Uuid
  staff           StaffProfile   @relation(fields: [staffId, schoolId], references: [id, schoolId])
  leaveType       StaffLeaveType @map("leave_type")
  fromDate        DateTime       @map("from_date") @db.Date
  toDate          DateTime       @map("to_date") @db.Date
  reason          String
  status          LeaveStatus    @default(PENDING)
  isUnpaid        Boolean        @default(false) @map("is_unpaid")
  rejectionReason String?        @map("rejection_reason")
  decidedById     String?        @map("decided_by_id") @db.Uuid
  decidedAt       DateTime?      @map("decided_at")
  createdAt       DateTime       @default(now()) @map("created_at")
  updatedAt       DateTime       @updatedAt @map("updated_at")
  @@index([schoolId, status])
  @@map("staff_leaves")
}

// ── Examinations ─────────────────────────────────────────
model GradeScale {
  id             String  @id @default(uuid()) @db.Uuid
  schoolId       String  @map("school_id") @db.Uuid
  school         School  @relation(fields: [schoolId], references: [id])
  academicYearId String  @map("academic_year_id") @db.Uuid
  label          String                    // "A+"
  minPercent     Decimal @map("min_percent") @db.Decimal(5, 2)
  maxPercent     Decimal @map("max_percent") @db.Decimal(5, 2)
  gradePoint     Decimal @map("grade_point") @db.Decimal(3, 1)
  @@unique([schoolId, academicYearId, label])
  @@map("grade_scales")
}

model Term {
  id             String       @id @default(uuid()) @db.Uuid
  schoolId       String       @map("school_id") @db.Uuid
  school         School       @relation(fields: [schoolId], references: [id])
  academicYearId String       @map("academic_year_id") @db.Uuid
  academicYear   AcademicYear @relation(fields: [academicYearId, schoolId], references: [id, schoolId])
  name           String                    // "Term 1"
  startDate      DateTime     @map("start_date") @db.Date
  endDate        DateTime     @map("end_date") @db.Date
  @@unique([id, schoolId])
  @@unique([academicYearId, name])
  @@map("terms")
}

model ExamDefinition {
  id               String     @id @default(uuid()) @db.Uuid
  schoolId         String     @map("school_id") @db.Uuid
  school           School     @relation(fields: [schoolId], references: [id])
  termId           String     @map("term_id") @db.Uuid
  term             Term       @relation(fields: [termId, schoolId], references: [id, schoolId])
  classId          String     @map("class_id") @db.Uuid
  class            Class      @relation(fields: [classId, schoolId], references: [id, schoolId])
  name             String
  examType         ExamType   @map("exam_type")
  weightagePercent Decimal    @map("weightage_percent") @db.Decimal(5, 2)
  examDate         DateTime   @map("exam_date") @db.Date
  status           ExamStatus @default(DRAFT)
  publishedAt      DateTime?  @map("published_at")
  publishedById    String?    @map("published_by_id") @db.Uuid
  createdAt        DateTime   @default(now()) @map("created_at")
  updatedAt        DateTime   @updatedAt @map("updated_at")
  @@unique([id, schoolId])
  @@index([schoolId, classId, termId])
  @@map("exam_definitions")
}

model ExamResult {
  id            String            @id @default(uuid()) @db.Uuid
  schoolId      String            @map("school_id") @db.Uuid
  school        School            @relation(fields: [schoolId], references: [id])
  examId        String            @map("exam_id") @db.Uuid
  exam          ExamDefinition    @relation(fields: [examId, schoolId], references: [id, schoolId])
  enrollmentId  String            @map("enrollment_id") @db.Uuid
  enrollment    StudentEnrollment @relation(fields: [enrollmentId, schoolId], references: [id, schoolId])
  subjectId     String            @map("subject_id") @db.Uuid
  subject       Subject           @relation(fields: [subjectId, schoolId], references: [id, schoolId])
  marksObtained Decimal?          @map("marks_obtained") @db.Decimal(6, 2)  // null when absent
  totalMarks    Decimal           @map("total_marks") @db.Decimal(6, 2)
  isAbsent      Boolean           @default(false) @map("is_absent")
  enteredById   String            @map("entered_by_id") @db.Uuid
  createdAt     DateTime          @default(now()) @map("created_at")
  updatedAt     DateTime          @updatedAt @map("updated_at")
  @@unique([examId, enrollmentId, subjectId])
  @@index([schoolId, enrollmentId])
  @@map("exam_results")
}

model ReportCard {
  id             String   @id @default(uuid()) @db.Uuid
  schoolId       String   @map("school_id") @db.Uuid
  termId         String   @map("term_id") @db.Uuid
  enrollmentId   String   @map("enrollment_id") @db.Uuid
  overallPercent Decimal  @map("overall_percent") @db.Decimal(5, 2)
  gradeLabel     String   @map("grade_label")
  sectionRank    Int?     @map("section_rank")
  documentId     String?  @map("document_id") @db.Uuid
  generatedAt    DateTime @default(now()) @map("generated_at")
  @@unique([termId, enrollmentId])
  @@map("report_cards")
}

// ── Timetable (v1: assignments feed it; visual grid v1.5) ─
model TimetableSlot {
  id             String  @id @default(uuid()) @db.Uuid
  schoolId       String  @map("school_id") @db.Uuid
  academicYearId String  @map("academic_year_id") @db.Uuid
  sectionId      String  @map("section_id") @db.Uuid
  dayOfWeek      Int     @map("day_of_week")        // 1=Mon … 7=Sun
  periodNo       Int     @map("period_no")
  subjectId      String  @map("subject_id") @db.Uuid
  staffId        String  @map("staff_id") @db.Uuid
  @@unique([sectionId, academicYearId, dayOfWeek, periodNo])
  @@index([schoolId, staffId, dayOfWeek])            // teacher clash check
  @@map("timetable_slots")
}

// ── HR / payroll ─────────────────────────────────────────
model SalaryStructure {
  id              String       @id @default(uuid()) @db.Uuid
  schoolId        String       @map("school_id") @db.Uuid
  staffId         String       @map("staff_id") @db.Uuid
  staff           StaffProfile @relation(fields: [staffId, schoolId], references: [id, schoolId])
  basic           Decimal      @db.Decimal(12, 2)
  allowances      Json         @default("{}")        // { "House Rent": 5000 }
  fixedDeductions Json         @default("{}") @map("fixed_deductions")
  effectiveFrom   DateTime     @map("effective_from") @db.Date
  createdAt       DateTime     @default(now()) @map("created_at")
  @@index([schoolId, staffId, effectiveFrom])
  @@map("salary_structures")
}

model PayrollRun {
  id           String           @id @default(uuid()) @db.Uuid
  schoolId     String           @map("school_id") @db.Uuid
  campusId     String           @map("campus_id") @db.Uuid
  month        Int
  year         Int
  status       PayrollRunStatus @default(DRAFT)
  approvedById String?          @map("approved_by_id") @db.Uuid
  createdById  String           @map("created_by_id") @db.Uuid
  createdAt    DateTime         @default(now()) @map("created_at")
  @@unique([schoolId, campusId, month, year])
  @@map("payroll_runs")
}

model Payslip {
  id                  String       @id @default(uuid()) @db.Uuid
  schoolId            String       @map("school_id") @db.Uuid
  runId               String       @map("run_id") @db.Uuid
  run                 PayrollRun   @relation(fields: [runId, schoolId], references: [id, schoolId])
  staffId             String       @map("staff_id") @db.Uuid
  staff               StaffProfile @relation(fields: [staffId, schoolId], references: [id, schoolId])
  gross               Decimal      @db.Decimal(12, 2)
  attendanceDeduction Decimal      @default(0) @map("attendance_deduction") @db.Decimal(12, 2)
  otherDeductions     Decimal      @default(0) @map("other_deductions") @db.Decimal(12, 2)
  netPay              Decimal      @map("net_pay") @db.Decimal(12, 2)
  breakdown           Json                            // full line-item detail for the PDF
  paidAt              DateTime?    @map("paid_at")
  paymentMethod       PaymentMethod? @map("payment_method")
  paymentRef          String?      @map("payment_ref")
  @@unique([runId, staffId])
  @@index([schoolId, staffId])
  @@map("payslips")
}

// ── Communication ────────────────────────────────────────
model SmsTemplate {
  id          String  @id @default(uuid()) @db.Uuid
  schoolId    String  @map("school_id") @db.Uuid
  school      School  @relation(fields: [schoolId], references: [id])
  triggerKey  String  @map("trigger_key")   // FEE_REMINDER | FEE_RECEIPT | ABSENCE | RESULT_READY | LEAVE_STATUS | ACCOUNT_INVITE | MANUAL
  body        String                        // with {placeholders}
  updatedById String? @map("updated_by_id") @db.Uuid
  updatedAt   DateTime @updatedAt @map("updated_at")
  @@unique([schoolId, triggerKey])
  @@map("sms_templates")
}

model SmsLog {
  id               String    @id @default(uuid()) @db.Uuid
  schoolId         String    @map("school_id") @db.Uuid
  school           School    @relation(fields: [schoolId], references: [id])
  recipient        String
  studentId        String?   @map("student_id") @db.Uuid
  userId           String?   @map("user_id") @db.Uuid
  invoiceId        String?   @map("invoice_id") @db.Uuid
  templateKey      String    @map("template_key")
  message          String
  segments         Int       @default(1)
  status           SmsStatus @default(QUEUED)
  gatewayMessageId String?   @map("gateway_message_id")
  failReason       String?   @map("fail_reason")
  sentAt           DateTime? @map("sent_at")
  deliveredAt      DateTime? @map("delivered_at")
  createdAt        DateTime  @default(now()) @map("created_at")
  @@index([schoolId, status])
  @@index([schoolId, createdAt])               // purge job
  @@index([gatewayMessageId])                  // webhook lookup
  @@map("sms_logs")
}

model SmsCreditLedger {
  id        String   @id @default(uuid()) @db.Uuid
  schoolId  String   @map("school_id") @db.Uuid
  delta     Int                                   // + top-up, − send debit
  refType   String   @map("ref_type")             // PLAN_MONTHLY | PURCHASE | SEND
  refId     String?  @map("ref_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")
  @@index([schoolId, createdAt])
  @@map("sms_credit_ledger")
}

// ── Documents ────────────────────────────────────────────
model Document {
  id         String       @id @default(uuid()) @db.Uuid
  schoolId   String       @map("school_id") @db.Uuid
  school     School       @relation(fields: [schoolId], references: [id])
  studentId  String?      @map("student_id") @db.Uuid
  staffId    String?      @map("staff_id") @db.Uuid
  type       DocumentType
  fileKey    String       @map("file_key")        // S3 key
  issuedById String       @map("issued_by_id") @db.Uuid
  issuedAt   DateTime     @default(now()) @map("issued_at")
  @@index([schoolId, studentId])
  @@map("documents")
}

// ── Platform / cross-cutting ─────────────────────────────
model AuditLog {
  id         String   @id @default(uuid()) @db.Uuid
  schoolId   String   @map("school_id") @db.Uuid
  school     School   @relation(fields: [schoolId], references: [id])
  userId     String   @map("user_id") @db.Uuid
  action     String              // enum-like constant catalog in code: audit-actions.ts
  entityType String   @map("entity_type")
  entityId   String   @map("entity_id") @db.Uuid
  oldValue   Json?    @map("old_value")
  newValue   Json?    @map("new_value")
  reason     String?
  ip         String?
  userAgent  String?  @map("user_agent")
  requestId  String?  @map("request_id")
  createdAt  DateTime @default(now()) @map("created_at")
  @@index([schoolId, createdAt])
  @@index([schoolId, userId])
  @@index([entityType, entityId])
  @@map("audit_logs")
}

model IdempotencyKey {
  id           String   @id @default(uuid()) @db.Uuid
  schoolId     String   @map("school_id") @db.Uuid
  key          String
  requestHash  String   @map("request_hash")
  responseCode Int?     @map("response_code")
  responseBody Json?    @map("response_body")
  createdAt    DateTime @default(now()) @map("created_at")
  @@unique([schoolId, key])
  @@index([createdAt])                          // 48h purge job
  @@map("idempotency_keys")
}
```

### 17.1 Raw-SQL migration companions (shipped alongside the Prisma migration)

Constraints Prisma cannot express — each is a checked-in SQL migration:
1. Partial uniques: one `is_current` AcademicYear per school; one `is_primary` guardian per student; one ACTIVE enrollment per (student, year); one batch-generated invoice per (student, month, year); `[school_id, method, transaction_ref]` where ref not null.
2. CHECKs: `fee_invoices.paid_amount <= total_amount + 0.00`; `exam_results (is_absent = true AND marks_obtained IS NULL) OR (is_absent = false AND marks_obtained IS NOT NULL)`; `student_leaves.to_date >= from_date` (and staff); `grade_scales.max_percent >= min_percent`.
3. RLS enablement + policies for every tenant table (§21.3).
4. Trigram index `students USING gin (full_name gin_trgm_ops)` for name search; `pg_trgm` extension.
5. `SchoolSettings` (the `School.settings` Json) is validated by a Zod schema in code; keys: `attendanceSessions`, `weeklyOffDays`, `attendanceEditWindowDays`, `feeDueDay`, `midMonthProration`, `siblingDiscountPercent`, `sectionCapacityMode`, `promotionRequiresFeeClearance`, `smsOverdraftSegments`, `staffLeaveQuotas`. Unknown keys rejected. Defaults documented in §9–§13.

---

# PART IV — SECURITY & TENANT ISOLATION (corrected, working designs)

## 18. Threat Model

The threat table from the prior design is carried forward intact (cross-tenant leak, JWT theft/replay, credential stuffing, SQLi, key exposure, insider threat, compromised admin, DDoS, ransomware, payment double-spend, malicious upload, supply chain) **with these corrections and additions**: (a) every mitigation referenced now has a concrete design in this document — idempotency (§25.4), MFA (§22.5), lockout (§22.3), refresh rotation (§22.4), file scanning (§22.6); (b) added threats: **XSS** (mitigated by httpOnly token cookies §22.2, CSP §22.7, React default escaping, sanitization of the few rich-text fields), **CSRF** (SameSite=Strict cookies + double-submit CSRF token on state-changing routes §22.7), **SMS PII to wrong number** (OTP phone verification §14), **stale-cache tenant suspension bypass** (cache invalidation §21.1). One wording correction: RLS protects against application bugs and non-superuser DB roles; a Postgres superuser can disable it — superuser access is therefore restricted to the break-glass workflow (§22.9), and the doc makes no "curious DBA" absolutism.

## 19. Tenant Context Lifecycle (authoritative order — fixes audit C-4)

1. **TenantResolutionMiddleware** (every request, pre-auth): resolve tenant from Host header (§21.1); set `cls.schoolId` and `cls.planTier` from the resolved school. This — not the auth guard — populates tenant context, so `/auth/login` works.
2. **JwtAuthGuard** (all routes except the public list): validate JWT, attach `req.user = { userId, schoolId, roles[], campusId? }`.
3. **TenantScopeGuard**: assert `req.user.schoolId === cls.schoolId`; mismatch ⇒ 403 `TENANT_MISMATCH` before any DB call.
4. **RolesGuard** then **ownership guards** (§22.8).
5. Every DB operation for the request runs inside a transaction that sets the RLS variable (§21.4).

Public (no-JWT) routes, exhaustively: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /webhooks/sms/:provider` (HMAC-authenticated instead), `GET /health/live`, `GET /health/ready` (host-exempt from tenant resolution).

## 20. Application-Layer Scoping (Prisma Client Extension)

The old `$use` middleware is replaced by a **client extension** covering **all** operations (fixes audit C-4 bypass holes). Behavior per operation on tenant-scoped models:

| Operations | Behavior |
|---|---|
| `findMany, findFirst, count, aggregate, groupBy` | merge `where: { schoolId }` |
| `findUnique, findUniqueOrThrow` | rewritten to `findFirst` with `schoolId` merged (unique-by-PK cannot carry an extra where) |
| `create, createMany` | inject `schoolId` into `data` (each element for createMany); if caller supplied a different schoolId ⇒ throw `TenantViolationError` |
| `update, updateMany, delete, deleteMany, upsert` | merge `schoolId` into `where` (and into `create` arm of upsert) |

Missing `cls.schoolId` on a tenant-scoped model ⇒ throw (fail closed). Worker/jobs set CLS context explicitly from the job payload's `schoolId` before touching Prisma; cross-tenant platform jobs use the separate `platformPrisma` client connected as the `platform_admin` role (§21.5) — the request-path client never can.

## 21. Database-Layer Isolation (RLS — corrected)

### 21.1 Tenant resolution & caching (fixes audit C-7, M-8)
Resolution order for `Host`: (1) exact `custom_domain` match; (2) if host ends with the platform apex, first label = subdomain; (3) otherwise 404. Reserved labels (`www`, `api`, `admin`, `app`) never resolve to tenants. Cache: `tenant:{host} → {id, planTier, isActive}` JSON, TTL 60s, **and** an explicit `DEL` fired by the suspend/reactivate/domain-change service methods (event hook, covered by an integration test: suspend ⇒ next request 403 within one request, not within TTL). `isActive` is re-checked from the cached value on every request. Suspended tenant ⇒ 403 `TENANT_SUSPENDED` (not 404 — parents deserve a truthful error page).

### 21.2 Session variable — parameterized, transaction-scoped
```sql
SELECT set_config('app.current_school_id', $1, true);  -- true = transaction-local
```
Never string-interpolated (fixes the `$executeRawUnsafe` injection smell); `$1` is the CLS schoolId, validated as a UUID before use.

### 21.3 Policies (correct column names & types — fixes audit C-2)
Tables are snake_case with `school_id uuid` per §17 conventions, so:
```sql
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE students FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON students
  FOR ALL
  USING (school_id = current_setting('app.current_school_id', true)::uuid)
  WITH CHECK (school_id = current_setting('app.current_school_id', true)::uuid);
```
`current_setting(…, true)` returns NULL (not an error) when unset ⇒ zero rows, fail-closed, and migrations/health checks don't explode. A generated migration applies this to **every** table carrying `school_id` (a CI check greps the schema and fails if any `school_id`-bearing table lacks a policy). `schools` itself is not RLS'd (resolution needs it); it contains no child data.

### 21.4 Wiring — every request in one transaction (fixes audit C-3)
`SET LOCAL`/`set_config(…, true)` only works if the setting and the queries share a transaction on the same connection. Therefore the request pipeline wraps handler DB work in an interactive transaction:

```typescript
// prisma/tenant-prisma.service.ts (core mechanism)
async withTenant<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const schoolId = this.cls.get('schoolId');
  if (!isUuid(schoolId)) throw new TenantViolationError('No tenant context');
  return this.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
    return fn(tx);
  });
}
```
A NestJS interceptor opens `withTenant` per request and exposes `tx` via CLS so services transparently use the transaction-bound client; long-running/queued work opens its own `withTenant` per unit of work (never holds a transaction across queue waits). If PgBouncer is introduced later it must run in **session pooling** mode for these connections, or be bypassed — documented as an ops constraint.

### 21.5 Bypass role & platform reads
`app_user` role (the API's connection) has **no** `BYPASSRLS`. `platform_admin` role (BYPASSRLS, read-mostly) is used only by: the vendor console service, cross-tenant analytics jobs, and the tenant-export job — each connection tagged and logged. Credentials live in Secrets Manager under a separate secret; the API container never receives them.

### 21.6 Isolation test suite (merge-blocking)
Seeds School A and School B with full fixtures; asserts: every list/read/write endpoint with A's token against B's rows ⇒ 403/404/empty; raw-SQL probe inside a `withTenant(A)` transaction selecting B's rows ⇒ 0 rows (this test is now valid because the set_config and query share a transaction — the prior version proved nothing); create/update attempting to set B's schoolId ⇒ rejected by extension AND by RLS `WITH CHECK` (both asserted independently by toggling the extension off in one test variant). Any production log line tagged `TENANT_VIOLATION` pages on-call (§31).

## 22. Authentication & Authorization (complete design — fixes audit H-6, H-1)

### 22.1 JWT claims (authoritative shape)
`{ sub: userId, sid: schoolId, roles: Role[], cid: campusId|null, iat, exp (15 min), kid }`. Two signing keys active during quarterly rotation, selected by `kid`.

### 22.2 Token transport & storage
Access + refresh tokens are set as **httpOnly, Secure, SameSite=Strict cookies** scoped to the tenant domain (refresh cookie path-limited to `/api/v1/auth/refresh`). Nothing token-shaped in localStorage ⇒ XSS cannot exfiltrate sessions. Because cookies are used, **CSRF protection is required**: a non-httpOnly `csrf` cookie + `X-CSRF-Token` header double-submit on every state-changing request, validated by middleware (exempt: the HMAC-verified webhook).

### 22.3 Login, lockout, passwords
Password policy: min 10 chars, checked against the HaveIBeenPwned k-anonymity range API on set/change (soft-fail if the API is down — log and allow). Hashing: **argon2id** (memory 64MB, iterations 3); legacy bcrypt hashes (if any imports) rehashed on first successful login. Lockout: 10 consecutive failures ⇒ `status=LOCKED`, `lockedUntil = now()+15min`, self-heals after expiry; OWNER_ADMIN can unlock early. Rate limits per §29 apply beneath lockout. Login response never distinguishes "no such user" from "wrong password". Role changes and password changes revoke all refresh-token families immediately (stale-privilege window ≤ access-token life, 15 min; acceptable and documented).

### 22.4 Refresh rotation & logout
Refresh tokens: 30-day expiry, single-use; each refresh issues a new token in the same `familyId` and revokes the used one. **Reuse of a revoked token ⇒ revoke the entire family** (theft signal) and log `REFRESH_REUSE_DETECTED`. Logout revokes the presented token's family and clears cookies. Access tokens are not denylisted (15-min blast radius accepted) **except** on account-disable and role-downgrade, which insert the userId into a Redis denylist checked by the auth guard (TTL = access-token life).

### 22.5 MFA
TOTP (RFC 6238). **Mandatory** for users holding OWNER_ADMIN or ACCOUNTANT; optional otherwise. Enrollment: `POST /auth/mfa/setup` (returns provisioning URI) → `POST /auth/mfa/verify`. Ten single-use recovery codes issued (hashed at rest). Login becomes two-step when enabled: password ⇒ short-lived `mfaPending` token ⇒ `POST /auth/mfa/challenge`.

### 22.6 File uploads
Single pipeline for all uploads (student photos, marks-import CSVs, logo): client requests `POST /uploads` with filename+mime ⇒ server returns a pre-signed S3 PUT (10MB cap enforced by S3 policy) to a **quarantine prefix** ⇒ client PUTs ⇒ client confirms ⇒ worker validates magic bytes vs declared MIME (allowlist: jpeg/png/pdf/csv), runs ClamAV, then moves to the permanent prefix and creates the referencing row. Files are served only via 10-minute pre-signed GETs after an ownership check, from a cookieless domain, `Content-Disposition: attachment` for anything non-image.

### 22.7 Web hardening
CSP (`default-src 'self'`; no inline script), HSTS, X-Content-Type-Options, Referrer-Policy, frame-ancestors 'none'. CORS: same-origin only (the app is served from the tenant domain); the API rejects cross-origin browser requests. All input validated with class-validator DTOs + a global whitelist ValidationPipe (`forbidNonWhitelisted: true`).

### 22.8 Ownership guards (row-level authorization — fixes audit H-1)
Role checks alone are insufficient; these guards run after RolesGuard, each a small class with the same test rigor as TenantScopeGuard:
- **CampusScopeGuard** — for CAMPUS_ADMIN (and campus-bound ACCOUNTANT): every route touching a campus-owned resource resolves the resource's `campusId` and asserts it equals `req.user.cid`. List endpoints force-inject `campusId` filter.
- **SectionOwnershipGuard** — TEACHER writes to attendance/homework: asserts a `TeacherAssignment` row exists for (staffId, current year, sectionId) — homeroom (`subjectId=null`) or any subject assignment qualifies for attendance.
- **SubjectOwnershipGuard** — TEACHER marks entry: asserts assignment for (staffId, year, sectionId, subjectId) exactly.
- **Guardian-of-student check** — asserts a `StudentGuardian` link between the caller and the target student. **Now a deny-by-default check inside the service, not a guard, and no longer about parents.** Two endpoints (`GET /student-leaves`, `GET /students/:id/report-cards`) carry no `@Roles`, so any signed-in caller reaches them and this check is the *only* protection: a non-admin who is not a guardian is refused. With the portal gone nobody can satisfy it, which means it now denies rather than scopes — and that is exactly why it must not be deleted as "parent leftovers". Removing it would let a STUDENT read every leave and every report card in the school.
  - It lives in the service and not in a guard for a structural reason (§22.8): guards run **before** the `withTenant` transaction, so a guard that reads tenant data sees zero rows under RLS and would pass everything.
- **SelfGuard** — STUDENT/STAFF reads: target resource must belong to the requester's own Student/StaffProfile.
Every guard failure returns 403 with a stable error code and writes a structured log line (no AuditLog row — too noisy — but counted as a metric; a spike alerts).

### 22.9 Vendor break-glass
PLATFORM_ADMIN read access to a tenant requires an explicit "support session": created with a reason, hard 4-hour expiry, visible to the school's OWNER_ADMIN in their audit view, every action logged. Direct production DB access follows the same break-glass ticket + logged `platform_admin` role session. Quarterly access reviews.

---

# PART V — API CONTRACT

## 23. Permission Matrix (authoritative)

`C/R/U/D` = create/read/update/delete, `A`=approve, `T`=trigger job, `—`=403. Scopes in parentheses are enforced by §22.8 guards.

| Module | OWNER_ADMIN | CAMPUS_ADMIN | ACCOUNTANT | TEACHER | STAFF | STUDENT |
|---|---|---|---|---|---|---|
| School settings, academic years, terms, holidays, grade scales | CRUD | R | R | R | R | R |
| Campuses / classes / sections / subjects | CRUD | CRUD (own campus; not campuses) | R | R | — | — |
| Inquiries & admissions | CRUD | CRUD (own campus) | — | — | — | — |
| Students & guardians | CRUD | CRUD (own campus) | R | R (assigned sections) | — | R (self) |
| Enrollments & promotion | CRUD, T | CRUD, T (own campus) | R | R (assigned) | — | R (self) |
| Teacher assignments & timetable | CRUD | CRUD (own campus) | — | R (own) | — | R (self) |
| Fee heads / structures / late-fee policy | CRUD | R | R | — | — | — |
| Invoice batches (generate) | C,R,T | R | C,R,T | — | — | — |
| Invoices | R,U(waive) | R (own campus) | R | — | — | R (self) |
| Payments & receipts | R | R (own campus) | C,R | — | — | R (self) |
| Payment reversals | C(A),R | R | request only | — | — | — |
| Discounts | CRUD,A | R | R | — | — | — |
| Guardian credits (advances) | R | R | C,R | — | — | — |
| Student attendance | R,U(post-window) | R,U (own campus) | — | C,R,U (assigned, in-window) | — | R (self) |
| Staff attendance | CRUD | CRU (own campus) | — | R (self) | R (self) | — |
| Student leaves | R,A | R,A (own campus) | — | C(own section),R | — | R (self) |
| Staff leaves | R,A | R,A (own campus) | — | C,R (self) | C,R (self) | — |
| Exams (definitions, publish) | CRUD,T | CRUD,T (own campus) | — | R | — | R (published) |
| Exam results | R,U(post-publish, audited) | R | — | C,R,U (assigned subject, pre-publish) | — | R (published, self) |
| Report cards | R,T | R,T (own campus) | — | R (assigned) | — | R (self) |
| Payroll (structures, runs, payslips) | CRUD,A | R (own campus) | R | R (own payslips) | R (own payslips) | — |
| SMS: templates, manual send, logs, credits | CRUD | C(send),R (own campus) | R (fee-related) | — | — | — |
| Documents/certificates | C,R | C,R (own campus) | R | — | R (own) | R (self) |
| Users & roles | CRUD | C,R (own campus; roles ≤ TEACHER/STAFF/ACCOUNTANT) | — | — | — | — |
| Audit log | R | R (own campus) | — | — | — | — |
| Dashboards | R (all) | R (own campus) | R (financial) | R (own sections) | — | R (self) |
| Reports (§28) | R | R (own campus) | R (financial) | R (assigned) | — | — |

**`PARENT` column removed 2026-08-08** — guardians have no logins (§5). Every cell that read `R (own child)` is now unreachable by anybody; where the underlying endpoint has no `@Roles`, the in-service guardian check refuses non-admins outright (§22.8).

**`ADMISSION_CONTROLLER` and `HR_MANAGER` are missing from this table.** Both are real, shipped roles (§5) and neither has ever had a column here. They are deliberately **not** invented into 27 rows each: the authoritative statement of what they may reach is the executable matrix in `test/matrix/permission-matrix.ts`, which asserts both denial and positive reachability per route and fails the build on a regression. Broadly — an ADMISSION_CONTROLLER has CRUD on inquiries/admissions and students for their own campus and nothing else; an HR_MANAGER has CRUD on the staff register and **R** on staff attendance, never marking it. Filling these columns in properly is tracked work, not a documentation nicety.

Rule: **every non-`—` cell should have at least one endpoint in §24, and `test/matrix/permission-matrix.ts` maps rows → routes in CI.**

> ⚠️ That rule used to end "so matrix and API can't drift". They did drift, which is how two whole roles came to be missing from this table — so the claim has been softened to what is actually true. The executable matrix covers the six roles it seeds (OWNER_ADMIN, CAMPUS_ADMIN, ADMISSION_CONTROLLER, ACCOUNTANT, TEACHER, PARENT); **STUDENT and STAFF are not seeded**, so no row here can speak for them and anything that must be denied to a student is proved with a real student session in `test/integration/student-portal.e2e-spec.ts` instead. (fixes audit H-5's root cause).

## 24. Endpoint Inventory

Base `/api/v1`, JSON, JWT-cookie auth per §22, tenant-scoped per §19. Only signatures listed; every DTO is defined in the OpenAPI spec generated from code decorators (`@nestjs/swagger`) — **the generated OpenAPI file is a build artifact and the frontend's typed client is generated from it** (contract drift impossible). Conventions in §25 apply to all.

**Auth** — `POST /auth/login` · `POST /auth/mfa/challenge` · `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/forgot-password` · `POST /auth/reset-password` · `POST /auth/change-password` · `POST /auth/mfa/setup` · `POST /auth/mfa/verify` · `DELETE /auth/mfa` (with password + code) · `GET /auth/me`

**Setup** — CRUD: `/academic-years` (+ `POST /academic-years/:id/set-current`, `POST /academic-years/:id/clone-structure`) · `/terms` · `/holidays` · `/grade-scales` · `/campuses` · `/classes` · `/sections` · `/subjects` · `GET/PATCH /settings`

**Users & staff** — `POST/GET /users` · `GET/PATCH /users/:id` (incl. roles change → audit) · `POST /users/:id/unlock` · `POST /users/:id/disable` · CRUD `/staff` (creates User+StaffProfile) · CRUD `/staff/:id/salary-structures` · CRUD `/teacher-assignments` · CRUD `/timetable-slots` (server rejects teacher clashes 409)

**Admissions** — `POST/GET /inquiries` · `GET/PATCH /inquiries/:id` · `POST /inquiries/:id/entry-test` (schedule) · `PATCH /inquiries/:id/entry-test` (record score ⇒ status PASSED/FAILED) · `POST /inquiries/:id/reject` `{reason}` · `POST /inquiries/:id/withdraw` `{reason}` · `POST /admissions` (the transactional admit, §8; body includes inquiryId, student fields, guardian resolution choice)

**Students** — `GET /students` (filters: campusId, classId, sectionId, status, `search` = name-trigram OR exact GR OR guardian phone) · `POST /students` (direct add without inquiry — same guardian/enrollment steps) · `GET/PATCH /students/:id` · `DELETE /students/:id` (soft) · `POST/DELETE /students/:id/guardians` · `PATCH /students/:id/guardians/:gid` (relation/isPrimary) · `GET /students/:id/ledger` (all invoices+payments) · `POST /imports/students` (CSV via upload pipeline; row-level error report)

**Enrollment** — `GET /enrollments` · `POST /enrollments/transfer` `{studentId, toSectionId}` (close+create, §7) · `POST /promotions` `{sectionId, targetYearId, overrides[]}` → 202 batch · `GET /promotions/:batchId`

**Attendance** — `POST /attendance/bulk` `{sectionId, date, session, records[]}` (validations §9; returns per-row results; 200 on resubmit-no-change, 409 ATTENDANCE_CONFLICT on cross-teacher diff) · `GET /attendance` (by section+date or by student+range) · `PATCH /attendance/:id` (admin post-window, `{status, reason}`) · Staff: `POST /staff-attendance/bulk` · `POST /staff-attendance/check-in|check-out` · `GET /staff-attendance`

**Leaves** — `POST/GET /student-leaves` · `POST /student-leaves/:id/approve|reject|cancel` · same trio under `/staff-leaves`

**Exams** — CRUD `/exams` (DRAFT only editable) · `POST /exams/:id/open-marks-entry` · `POST /exams/:id/results/bulk` (upsert; per-row errors) · `GET /exams/:id/results` (teacher grid) · `POST /exams/:id/publish` (completeness gate §11) · `PATCH /exams/:id/results/:rid` (post-publish = OWNER_ADMIN + reason) · `GET /terms/:id/report-cards` · `POST /terms/:id/report-cards/generate` → 202 · `GET /students/:id/report-cards`

**Fees** — CRUD `/fee-heads`, `/fee-structures`, `/late-fee-policy` · `POST /fees/invoice-batches` (idempotent, §12) · `GET /fees/invoice-batches/:id` · `GET /fees/invoices` (filters: studentId, status, month, year, campusId) · `GET /fees/invoices/:id` · `POST /fees/invoices/:id/waive` `{reason}` · `POST /fees/invoices/:id/payments` (**Idempotency-Key required**) · `GET /fees/payments` (filters: date range, method, collectedById) · `GET /fees/payments/:id/receipt` (PDF) · `POST /fees/payments/:id/reversals` · CRUD `/discounts` (+ `/discounts/:id/revoke`) · `POST /fees/advances` · `GET /fees/advances?parentId=` · `GET /fees/defaulters` (campusId, minDays)

**Payroll** — `POST /payroll-runs` `{campusId, month, year}` → 202 · `GET /payroll-runs` · `GET /payroll-runs/:id` (payslips) · `POST /payroll-runs/:id/approve` · `PATCH /payslips/:id/mark-paid` · `GET /payslips/mine`

**Communication** — CRUD `/sms/templates` · `POST /sms/send` `{recipientQuery | userIds[], templateKey|customBody}` → 202 with segment/credit estimate · `GET /sms/logs` (status, templateKey, range) · `POST /sms/logs/:id/retry` · `GET /sms/credits` · `POST /webhooks/sms/:provider` (public, HMAC)

**Documents** — `POST /uploads` (§22.6) · `POST /documents/certificates` `{studentId, type}` (rules §15) · `GET /documents?studentId=` · `GET /documents/:id/url` (pre-signed) · `POST /students/:id/withdraw` (workflow §15)

**Dashboards & reports** — `GET /dashboard` (role-shaped payload; metric list §28) · `GET /reports/{daily-collection|fee-ledger|attendance-register|class-strength|defaulters|exam-summary|sms-usage}` (each: filters + `format=json|csv|pdf`; pdf → 202 + document)

**Audit** — `GET /audit-logs` (from, to, action, userId, entityType+entityId)

**Vendor console (`admin.platform.pk`, PLATFORM_ADMIN)** — `POST /platform/schools` (provisioning: creates School, first campus, OWNER_ADMIN invite, seeds default templates/settings) · `GET /platform/schools` · `POST /platform/schools/:id/suspend|reactivate` (cache-invalidated, §21.1) · `POST /platform/schools/:id/sms-credits` · `POST /platform/schools/:id/export` → 202 (tenant export job §33.5) · `POST /platform/support-sessions` (§22.9) · `GET /platform/analytics`

## 25. API Conventions

### 25.1 Envelope & errors
Success: resource JSON or `{ data, total, page, pageSize }` for lists. Error (all non-2xx):
```json
{ "error": { "code": "RESULTS_INCOMPLETE", "message": "human-readable", "details": [{ "field": "records[3].status", "issue": "invalid enum" }], "requestId": "…" } }
```
Stable machine codes; catalog maintained in `error-codes.ts` and published in OpenAPI. Status usage: 200 read/idempotent-replay · 201 create · 202 queued · 204 delete/logout · 400 malformed · 401 unauthenticated · 403 authz/tenant · 404 not found or cross-tenant (indistinguishable by design) · 409 conflict/state-transition/duplicate · 422 validation/business-rule · 429 rate limited (+Retry-After) · 500/503.

### 25.2 Pagination, filtering, sorting
All lists: `page` (1-based), `pageSize` (default 25, **max 100**), `sort` (`field:asc|desc`, allowlisted fields per endpoint), documented filters only (unknown query params rejected). Date filters are ISO dates in the school's timezone (Asia/Karachi fixed in v1; per-school TZ is a v2 setting).

### 25.3 Bulk partial-failure contract
Bulk endpoints (attendance, marks, imports) return 200 with `{ succeeded: n, failed: m, errors: [{index, code, message}] }`; the request is **not** all-or-nothing unless stated (invoice batches and promotions are transactional per unit as specified).

### 25.4 Idempotency
`Idempotency-Key` header (UUID) **required** on: payments, reversals, advances, manual SMS send. Server stores `[schoolId, key]` with request hash; replay with same hash ⇒ replay stored response (200); same key, different hash ⇒ 409 `IDEMPOTENCY_KEY_REUSED`. Keys purge after 48h.

### 25.5 Concurrency
Payments: serializable transaction + invoice row lock (§12) — sized for the 500-concurrent-payments NFR because contention is per-invoice, not global. Marks entry: last-write-wins within pre-publish window per (exam, enrollment, subject) with `updatedAt` returned; the UI warns on stale overwrite (optimistic concurrency via `If-Unmodified-Since` optional in v1.5). Attendance: §9 conflict rule.

---

# PART VI — WORKFLOWS & JOBS

## 26. Key Sequence Flows (corrected)

### 26.1 Fee payment (counter)
```mermaid
sequenceDiagram
    participant Acc as Accountant (UI)
    participant API
    participant DB as PostgreSQL
    participant Q as BullMQ
    Acc->>API: POST /fees/invoices/:id/payments (Idempotency-Key)
    API->>API: guards (§19) + idempotency check
    API->>DB: BEGIN; set_config(school); SELECT invoice FOR UPDATE
    API->>DB: validate amount ≤ remaining; INSERT payment (receiptNo=next); UPDATE invoice paid_amount/status; INSERT AuditLog if waiver-adjacent; COMMIT
    API->>Q: enqueue fee-receipt-sms {smsIdempotency: receipt:{paymentId}}
    API-->>Acc: 201 (receipt payload; printable)
    Q->>Q: render template, debit credits, call gateway, write SmsLog
```

### 26.2 Attendance + absence SMS
```mermaid
sequenceDiagram
    participant T as Teacher (UI)
    participant API
    participant DB
    participant Q as BullMQ
    T->>API: POST /attendance/bulk
    API->>API: SectionOwnershipGuard; date/holiday/enrollment validation
    API->>DB: single upsert statement (INSERT … ON CONFLICT), conflict-diff check
    API-->>T: 200 {succeeded, failed, errors[]}
    API->>Q: one absence-sms job per newly-ABSENT enrollment (key absence:{enrollmentId}:{date})
    Q->>DB: batch-fetch primary guardians for the section (one query)
    Q->>Q: skip ON_LEAVE/opt-out/unverified; send; SmsLog
```

### 26.3 Admission — see §8 numbered transaction. The parent User INSERT happens only after explicit link-or-create choice; the invite SMS is enqueued post-commit.

### 26.4 Report cards — trigger is an **Admin** action `POST /terms/:id/report-cards/generate` (the old diagram wrongly showed the API calling itself). Job: verify all class exams in term are PUBLISHED and weightages sum to 100 → compute per §11 → PDF per student → S3 → Document + ReportCard rows → result-ready SMS per primary guardian (idempotency `rc:{termId}:{enrollmentId}`). Re-run after a correction regenerates only affected students and re-notifies flagged "Corrected".

## 27. Scheduled & Queued Jobs Inventory (authoritative — closes the missing-jobs gap)

| Job | Schedule/trigger | Idempotency | Failure behavior |
|---|---|---|---|
| `invoice-batch-generate` | on batch create | batch unique + per-student partial unique | retry ×3; batch status FAILED surfaces in UI |
| `mark-overdue` | nightly 01:00 PKT | rerunnable (set-based update; fine line upserted) | alert if skipped >24h |
| `absence-sms`, `fee-receipt-sms`, `result-ready-sms`, `leave-status-sms`, `invite-sms`, `manual-sms` | event | per-event key (§26) | ×3 backoff → FAILED + admin retry UI |
| `report-cards-generate` | admin trigger | per (term, enrollment) | per-student retry; partial progress visible |
| `promotion-batch` | admin trigger | per (section, targetYear); per-student skip-if-done | resumable |
| `payroll-run` | admin trigger | unique (school,campus,month,year) | run FAILED status |
| `sms-log-purge` | nightly | date-based delete <90d | notify |
| `idempotency-purge` | hourly | <48h | notify |
| `attendance-archive` | monthly | partition move >2y to cold storage | notify |
| `audit-log-rotate` | annual | partition rotation >3y | notify |
| `fee-integrity-check` | nightly | verifies invoice invariants (§12); mismatch ⇒ page | — |
| `reconciliation` | nightly | bank/gateway CSV vs payments | report to accountant |
| `sms-monthly-credit` | 1st monthly | plan-tier grant per school | notify |
| `tenant-export` | vendor trigger | per school per request | resumable |
| `db-backup-verify` | weekly | restore latest snapshot to scratch, smoke test | page on failure |

All jobs: BullMQ, `attempts:3` default, dead-letter queue monitored (§31), every job payload carries `schoolId` (or is a platform job on `platformPrisma`), and workers open `withTenant` per unit (§21.4).

---

# PART VII — UI/UX SPECIFICATION

## 28. Screens by Role (complete inventory)

Global UX rules: every list has loading skeleton, empty state with primary action, error state with retry; every destructive/irreversible action (waive, reverse, publish, promote, withdraw, delete) has a confirmation dialog stating consequences and requiring the reason where the API requires one; every form disables submit while pending and surfaces field-level 422 details inline; mobile-first responsive (teachers/parents are phone users); WCAG 2.1 AA (semantic HTML, keyboard nav, 4.5:1 contrast, form labels); all times Asia/Karachi.

**Auth:** login (+MFA step), forgot/reset password, first-time set-password (invite link), locked-account screen. **Owner/Campus Admin:** dashboard (enrollment count, today's attendance %, month collections vs target, defaulter count, pending leaves, failed SMS count — each card links through); school setup wizard (year → campuses → classes/sections → subjects → fee heads/structures → grade scale → templates); academic-year & promotion screen (section-by-section grid with per-student overrides, precondition warnings, progress of the batch job); admissions pipeline (kanban by status; inquiry detail with test scheduling/scoring, reject/withdraw with reason; admit form with guardian-match step §8); student directory (search, filters) + student profile (tabs: info, guardians, enrollment history, attendance, results, fee ledger, documents); attendance overview & post-window edit (reason-required); leave approval queues (student/staff, approve/reject with reason); exams (definitions per term with weightage-sum indicator, publish screen showing completeness gaps, post-publish correction flow); reports hub (the seven §24 reports with export buttons); users & roles; teacher assignments & timetable editor (clash warnings); SMS center (templates with placeholder preview + segment counter, manual send with recipient query builder, credit balance, failed-messages queue with retry); audit log browser (filter by user/action/entity, old→new diff view); settings. **Accountant:** fee counter (student lookup by GR/name/phone → open invoices → collect with method/ref → print receipt), invoice batch generation (duplicate-safe messaging), defaulters list with bulk-reminder SMS, advances/credits, reversal request, daily collection report, financial dashboard. **Teacher:** my sections/timetable, attendance marking grid (whole-section single screen, ON_LEAVE cells locked, conflict banner), marks entry grid per (exam, subject) with absent toggle and per-row validation, my students, homework (v1.5), own leaves, own payslips. **Student:** own portal — attendance calendar, published results & report-card downloads, fee invoices with paid/pending state ("pay at counter/bank"; online pay is the aggregator seam, §12). **No leave request:** leave is filed by the office or the class teacher, never by the child (decision 2026-08-05). *(The **Parent** portal described here was removed 2026-07-28 — guardians are reached by SMS and by a signed fee-proof upload link, with no account: §5.)* **Staff:** own attendance, leaves, payslips. **Vendor console:** tenant list/provisioning wizard, plan & SMS credit management, suspend/reactivate, support sessions, platform analytics, export trigger. **System pages:** 403 tenant-suspended page (school-facing, truthful), maintenance-mode page, generic error page with requestId displayed for support.

---

# PART VIII — NON-FUNCTIONALS & OPERATIONS

## 29. NFR Targets & Rate Limits
Carried forward and confirmed: P95 <300ms reads / <600ms writes (excl. async); 99.9% uptime; 500 concurrent payment submissions (design basis §25.5); 10k SMS cleared <30 min; RPO ≤30 min (PITR 5-min granularity); RTO ≤4h; zero cross-tenant exposure (CI-enforced §21.6); uploads ≤10MB (§22.6). Rate limits (Redis sliding window): login 5/IP/15min and 10/user/1h; refresh 60/user/1h; manual SMS 100/school/h and 10k recipients/school/day; parent reads 600/user/h (raised from 300 — result-day traffic); public 60/IP/min; authenticated default 600/user/min. 429 + Retry-After; repeated tenant-level limit hits alert (compromise indicator).

## 30. Performance Design Notes
Stored `paid_amount` avoids per-read payment aggregation; dashboard payload served from a 5-minute Redis cache per (school, campus, role-shape), invalidated on payment/attendance writes only for the affected school; attendance bulk = one `INSERT … ON CONFLICT` statement; absence-SMS guardian fetch batched; defaulters query covered by `(school_id, status, due_date)` index; report PDFs always queued; monthly partitioning applied to `attendance_records`, `sms_logs`, `audit_logs` from day one (they dominate row growth); trigram index for name search; connection pool sized `(2 × vCPU) + spare` per app instance with pool-exhaustion alerting; k6 load profile in repo simulates fee-season peak (500 payment VUs + 10k SMS enqueue) and runs before each major release.

## 31. Observability
Pino JSON logs with `requestId, schoolId, userId, route, latencyMs`, correlation ID propagated HTTP→service→Prisma→BullMQ; global redaction list (`password, cnic, authorization, token, phone, bankAccount`); CloudWatch/Loki. Prometheus metrics: golden signals per route + business metrics (collections/hour/tenant, SMS queue depth & failure rate, active users/school, guard-denial counters, per-tenant rate-limit hits). Grafana dashboards per functional area + per-tenant health meta-dashboard. OpenTelemetry traces (HTTP, Prisma, BullMQ, outbound gateways) → Jaeger. **Sentry** for exception tracking (release-tagged). Synthetic uptime check hits `/health/ready` + one read flow per minute. Alerts: 5xx>1%/5min page; P95>1s/10min page; queue depth>5k/15min page; **DLQ nonzero page**; failed-SMS>10%/30min notify; pool>90% page; RDS disk>80% notify; any `TENANT_VIOLATION` log ⇒ page (security incident, runbook §33.4); `fee-integrity-check` mismatch ⇒ page. Health endpoints reveal nothing internal.

## 32. Data Protection & Compliance
Field-level AES-256-GCM (per-tenant KMS data keys) for `cnic_enc`, `bank_account_enc`, `mfa_secret_enc`; encrypt/decrypt in a Prisma extension so services see plaintext; key rotation via KMS re-wrap annually; tenant deletion crypto-shreds the tenant data key. Passwords: §22.3. PII never logged (§31 redaction). Data export by a school: vendor-triggered full export (§33.5) + school-admin self-serve CSV exports per report; every export writes `DATA_EXPORTED` audit with row count. Retention: active student records — anonymize (not delete) on request (below); attendance 7y (cold-archived after 2y); payments 7y minimum, immutable + reversals only; SMS logs 90d; audit logs 3y immutable then cold; suspended tenant: 90d grace → export offered → deletion. **Right-to-erasure (fixes the contradiction):** verified request ⇒ export offered ⇒ **anonymization job**: student/guardian name→"REDACTED-{shortid}", DOB→year-only, phone/CNIC/photo nulled, portal accounts disabled; invoices, payments, attendance, and results **retain their skeleton** (legal/financial retention obligations override erasure for those records — stated policy, communicated in the privacy notice); audit row `PII_ANONYMIZED` (metadata only) as proof. No cascade hard-delete exists in the product.

## 33. Deployment, DR & Runbooks
**Deploys:** blue/green at the ALB; DB migrations run first and must be backward-compatible with N−1 (expand/contract; column drops ship one release later); feature flags (per-tenant) gate new modules — pilot school → 10% → all, kill-switch per flag; every deploy PR contains a rollback section. **Environments:** local (docker-compose: pg+redis+localstack), CI-ephemeral, staging (prod-shaped, seeded demo tenants), production. **Backups:** RDS automated 35d + PITR 5-min; daily snapshot copied to a second AWS account; S3 versioning + cross-region replication + MFA-delete; Redis ephemeral by design; weekly automated restore-verify job (§27). **33.4 Runbooks** carried forward verbatim with two fixes: full-restore step 6 retitled "Repoint application DB endpoint" (it was never DNS), and the isolation-breach runbook's maintenance-mode flag now explicitly bypasses the tenant cache. SEV classification, quarterly restore drills, annual full failover drill, blameless post-mortems ≤5 business days — all retained. **33.5 Tenant export/restore:** `tenant-export` job dumps all rows `WHERE school_id=X` across every tenant table to versioned JSONL + S3 files manifest, encrypted, checksummed — this is both the customer-export deliverable and the single-tenant-restore input (restore = replay into a clean tenant id via an ops CLI; drilled quarterly with a test tenant). This is the accepted mitigation for pooled-tenancy's single-tenant-restore weakness (§2).

---

# PART IX — SDLC & DELIVERY

## 34. Process
**Requirements:** every feature in this blueprint maps to user stories in the tracker; each story carries acceptance criteria derived from Parts II–V (the state machines and rules ARE the criteria — e.g., "given an invoice OVERDUE, when payment covers remaining, then status PAID and fine line unchanged"). No story enters a sprint without criteria. **Design changes:** any deviation from this document requires a blueprint PR first (change control, header). **Development standards:** TypeScript strict; ESLint + Prettier + module-boundary rules; conventional commits; trunk-based with short-lived branches; PR review checklist includes: tenant scoping (new model added to RLS migration + isolation tests?), authz guard on every new route, AuditLog on sensitive mutations, `$queryRaw` justification, error codes registered; definition of done = code + tests + OpenAPI updated + docs touched. **Testing pyramid:** unit (Jest, business rules incl. every state machine and the fee/payroll/grading formulas with worked-example fixtures from §11–§13) → integration (Supertest + ephemeral Postgres/Redis containers, per PR) → **tenant-isolation suite (merge-blocking)** → matrix-to-route conformance test (§23) → E2E (Playwright: admit, collect fee, mark attendance, enter+publish marks, parent views report card, promotion) → load (k6 profile §30, pre-release). CI order: lint → unit → integration → isolation → matrix-conformance → build → staging deploy → E2E → manual promote to prod. **Delivery roadmap:** M1 foundations (tenancy stack §19–§21, auth §22, setup module, provisioning) — the isolation suite passes before any domain feature is written; M2 students/admissions/enrollment; M3 attendance+leaves+SMS core; M4 fees end-to-end; M5 exams+report cards; M6 HR/payroll+documents+reports/dashboards; M7 hardening (load, pen test, DR drill, pilot school); GA. Each milestone exits only with its E2E journeys green on staging.

## 35. Deliberately Deferred (with owners)
Redis eviction tuning, SMS aggregator contract specifics (adapter interface fixed now, provider config later), i18n, rate-limit threshold tuning from observed traffic, reserved-instance cost work, online payment gateway (v2), per-school timezone (v2). Each has a tracker epic; nothing else is deferred implicitly.

---

# APPENDICES

**A. Error-code catalog** — maintained in `error-codes.ts`, published via OpenAPI; seed set: `TENANT_MISMATCH, TENANT_SUSPENDED, INVALID_STATE_TRANSITION, ATTENDANCE_CONFLICT, ATTENDANCE_LOCKED, RESULTS_INCOMPLETE, WEIGHTAGE_SUM_INVALID, IDEMPOTENCY_KEY_REUSED, OVERPAYMENT_USE_ADVANCE, SECTION_FULL, GR_NUMBER_TAKEN, LEAVE_OVERLAP, INSUFFICIENT_SMS_CREDITS, PHONE_UNVERIFIED`.
**B. Audit-action catalog** — `audit-actions.ts`: FEE_WAIVED, FINE_WAIVED, PAYMENT_REVERSED, GRADE_CHANGED_POST_PUBLISH, ROLE_CHANGED, ATTENDANCE_EDITED_POST_WINDOW, DISCOUNT_APPROVED/REVOKED, PROMOTION_OVERRIDE, WITHDRAWAL_FEE_OVERRIDE, PII_ANONYMIZED, DATA_EXPORTED, SUPPORT_SESSION_STARTED, USER_DISABLED, MFA_RESET.
**C. Worked examples** (test fixtures): term-result computation incl. an absent exam; payroll deduction month; fee invoice with sibling discount + fine + partial payments + reversal — each with expected numbers, used verbatim in unit tests.
**D. Traceability** — every audit finding (C-1…C-8, H-1…H-12, M-1…M-15, L-1…L-10) maps to the section resolving it; table maintained in `/docs/audit-traceability.md`.
**E. Changelog** — one entry per approved change, newest first, per the change-control rule at the top of this document.

| Date | Version | Change | Sections |
|---|---|---|---|
| 2026-08-08 | v2.1 | **The parent portal is removed from the specification.** It was removed from the product on 2026-07-28 and this document went on describing it for six weeks — long enough that an engineer or agent building from the spec alone would have faithfully rebuilt a feature the operator had deliberately deleted. Guardians are contact records reached by SMS; the `PARENT` role is retained in the enum for pre-existing rows and never granted. Also records **`ADMISSION_CONTROLLER`** and **`HR_MANAGER`**, two shipped roles this document had never mentioned, and corrects the change-control path. | §1, §5, §8, §17, §22.8, §23, §33, header |
| — | v2.0 | Full rebuild; supersedes Parts 1 & 2. | all |

> **Why this changelog was empty until 2026-08-08.** The header has required an entry per change since v2.0, and none was ever written — so the drift corrected in v2.1 accumulated silently, and the procedure meant to catch it was itself the thing nobody was following. Anything that changes this document from here adds a row **in the same commit**, not afterwards.
