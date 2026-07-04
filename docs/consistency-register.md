# Consistency Register v1.0

**Status:** LOCKED. This is the single source of truth for every name, value, number, and rule across all downstream documents. Derived verbatim from `school-management-master-blueprint.md` (v2.0). Where any later document conflicts with this register, **this register wins**.

**Change control:** Any change requires a versioned update to this register (bump the version, note it in the changelog) *before* it propagates to downstream documents.

---

## Section 1 — Core Identifiers & Naming Conventions

| Concern | Convention (verbatim) | Source |
|---|---|---|
| Database naming | **snake_case** on every table & column. Every model `@@map`s to a snake_case table; every field `@map`s to a snake_case column. Mandatory — RLS policies and raw SQL depend on predictable column names. | §3, §17 |
| API / TypeScript naming | **camelCase** — Prisma model/field names in code (e.g. `schoolId`, `paidAmount`, `academicYearId`). Typed API client generated from OpenAPI. | §3, §17 |
| Primary key format | `String @id @default(uuid()) @db.Uuid` | §17 |
| Tenant scoping field | DB: `school_id` · Code: `schoolId String @db.Uuid`. First scalar of every tenant table, with a real relation to `School`. | §2, §17 |
| Money field type | `Decimal @db.Decimal(12, 2)` | §17 |
| Soft-delete field | `deletedAt DateTime?` → `@map("deleted_at")` (only on noted models) | §17 |
| Timestamp fields | `createdAt DateTime @default(now())` · `updatedAt DateTime @updatedAt` on every mutable table; optional `createdById String? @db.Uuid` | §17 |
| Tenant-chain FK | Child rows carrying denormalized `schoolId` also carry composite FK `(parentId, schoolId)` → parent's `@@unique([id, schoolId])`. | §17 |
| Referential default | Prisma relation default `onDelete: Restrict` everywhere except explicit `Cascade` on pure child tables (invoice items, guardian links). | §17 |

---

## Section 2 — Complete Enum Catalog

All 24 enums from the authoritative Prisma schema (§17). Values are in blueprint declaration order — order is significant and must not be re-sorted.

| Enum | Values (in order) | Used by |
|---|---|---|
| `Role` | `PLATFORM_ADMIN` `OWNER_ADMIN` `CAMPUS_ADMIN` `ACCOUNTANT` `TEACHER` `STAFF` `PARENT` `STUDENT` | `User.roles` (array) |
| `PlanTier` | `BASIC` `PLUS` `PRO` | `School.planTier` |
| `Gender` | `MALE` `FEMALE` `OTHER` | `Student.gender` |
| `InquiryStatus` | `INQUIRY` `ENTRY_TEST_SCHEDULED` `ENTRY_TEST_PASSED` `ENTRY_TEST_FAILED` `ADMITTED` `REJECTED` `WITHDRAWN` | `Inquiry.status` |
| `EnrollmentStatus` | `ACTIVE` `PROMOTED` `RETAINED` `TRANSFERRED_OUT` `WITHDRAWN` `COMPLETED` | `StudentEnrollment.status` |
| `GuardianRelation` | `FATHER` `MOTHER` `GUARDIAN` | `StudentGuardian.relation` |
| `FeeFrequency` | `MONTHLY` `ANNUAL` `ONE_TIME` `ADMISSION` | `FeeStructure.frequency` |
| `FeeInvoiceStatus` | `PENDING` `PARTIAL` `PAID` `OVERDUE` `WAIVED` | `FeeInvoice.status` |
| `InvoiceItemType` | `FEE` `DISCOUNT` `FINE` `WAIVER` | `FeeInvoiceItem.type` |
| `PaymentMethod` | `CASH` `BANK_TRANSFER` `EASYPAISA` `JAZZCASH` `CARD` `CHEQUE` | `FeePayment.method`, `Payslip.paymentMethod` |
| `AttendanceStatus` | `PRESENT` `ABSENT` `LATE` `HALF_DAY` `ON_LEAVE` | `AttendanceRecord.status`, `StaffAttendance.status` |
| `AttendanceSession` | `MORNING` `EVENING` | `AttendanceRecord.session`, `StaffAttendance.session` |
| `LeaveStatus` | `PENDING` `APPROVED` `REJECTED` `CANCELLED` | `StudentLeave.status`, `StaffLeave.status` |
| `StaffLeaveType` | `CASUAL` `SICK` `UNPAID` `OTHER` | `StaffLeave.leaveType` |
| `ExamType` | `MONTHLY` `MID_TERM` `FINAL` `SURPRISE_TEST` | `ExamDefinition.examType` |
| `ExamStatus` | `DRAFT` `MARKS_ENTRY` `PUBLISHED` | `ExamDefinition.status` |
| `SmsStatus` | `QUEUED` `SENT` `DELIVERED` `FAILED` | `SmsLog.status` |
| `StaffType` | `TEACHER` `ADMIN` `ACCOUNTANT` `CLERK` `SUPPORT` | `StaffProfile.staffType` |
| `EmploymentStatus` | `ACTIVE` `ON_LEAVE` `TERMINATED` | `StaffProfile.employmentStatus` |
| `DocumentType` | `LEAVING_CERT` `CHARACTER_CERT` `FEE_CLEARANCE` `REPORT_CARD` `PAYSLIP` `RECEIPT` | `Document.type` |
| `UserStatus` | `INVITED` `ACTIVE` `LOCKED` `DISABLED` | `User.status` |
| `PayrollRunStatus` | `DRAFT` `APPROVED` | `PayrollRun.status` |
| `DiscountType` | `PERCENT` `FIXED` | `Discount.type` |
| `DiscountStatus` | `ACTIVE` `REVOKED` | `Discount.status` |

**String-typed status fields (NOT Postgres enums):** `FeeInvoiceBatch.status` = `QUEUED | RUNNING | DONE | FAILED`; `LateFeePolicy.mode` = `FLAT | PER_DAY`; `GuardianCredit.refType` = `DEPOSIT | APPLIED_TO_INVOICE | REFUND`; `SmsCreditLedger.refType` = `PLAN_MONTHLY | PURCHASE | SEND`; `School.grNumberMode` = `AUTO | MANUAL`; `SmsTemplate.triggerKey` = `FEE_REMINDER | FEE_RECEIPT | ABSENCE | RESULT_READY | LEAVE_STATUS | ACCOUNT_INVITE | MANUAL`. Preserve these as string literals.

---

## Section 3 — Magic Numbers, Defaults & Limits

Format: `Value | Meaning | Section`. Where a value is a per-school setting, the column is named and the default quoted.

### Auth & sessions
| Value | Meaning | Section |
|---|---|---|
| 15 min | JWT access token expiry | §3, §22.1 |
| 30 days | Refresh token expiry (single-use, rotating) | §22.4 |
| 10 failures | Consecutive failed logins → `status=LOCKED` | §22.3 |
| 15 min | Lockout duration (`lockedUntil = now()+15min`, self-heals) | §22.3 |
| 10 chars | Minimum password length (+ HaveIBeenPwned check) | §22.3 |
| 64 MB | argon2id memory cost | §22.3 |
| 3 | argon2id iterations | §22.3 |
| 10 | MFA single-use recovery codes issued | §22.5 |
| 30 min | Password-reset / set-password token expiry | §8, §17 |
| 4 hours | Vendor support-session (break-glass) hard expiry | §22.9 |

### Domain settings & defaults (per-school unless noted)
| Value | Meaning | Section |
|---|---|---|
| `[MORNING]` | Default `attendanceSessions` (or `[MORNING, EVENING]`) | §9 |
| `[SUNDAY]` | Default `weeklyOffDays` | §9 |
| 3 days | Default `attendanceEditWindowDays` | §9 |
| 40 | Default `Section.capacity` | §17 |
| ADVISORY | Default `sectionCapacityMode` (`HARD | ADVISORY`) | §7 |
| true | Default `promotionRequiresFeeClearance` | §7 |
| FULL | Default `midMonthProration` (`FULL | HALF | DAILY`) | §12 |
| `Setting.feeDueDay` | Invoice due day of month (per-school setting) | §12 |
| `Setting.siblingDiscountPercent` | Auto sibling discount for 2nd+ enrolled sibling | §12 |
| 100 | Default `smsOverdraftSegments` (negative buffer) | §14 |
| 1 | Default `School.nextGrNumber` / `nextReceiptNo` | §17 |
| 100 | Weightage sum required per class-term before report cards | §11 |

### SMS plan credits
| Value | Meaning | Section |
|---|---|---|
| BASIC 1k | Monthly included SMS credits — BASIC tier | §14 |
| PLUS 5k | Monthly included SMS credits — PLUS tier | §14 |
| PRO 20k | Monthly included SMS credits — PRO tier | §14 |

### API, pagination & idempotency
| Value | Meaning | Section |
|---|---|---|
| 25 | Default list `pageSize` | §25.2 |
| 100 | Maximum list `pageSize` | §25.2 |
| 48 hours | Idempotency-key purge window | §25.4 |
| 3 | BullMQ default `attempts` per job | §27 |
| 3 | SMS send retry attempts (×3 exponential backoff) | §14, §27 |

### Caching, uploads & files
| Value | Meaning | Section |
|---|---|---|
| 60 s | Tenant resolution cache TTL (`tenant:{host}`) | §21.1 |
| 5 min | Dashboard payload Redis cache TTL | §30 |
| 10 min | Pre-signed S3 URL expiry (uploads & document GETs) | §15, §22.6 |
| 10 MB | Upload size cap (enforced by S3 policy) | §22.6 |

### Rate limits (Redis sliding window, §29)
| Value | Meaning | Section |
|---|---|---|
| 5 / IP / 15min | Login attempts per IP | §29 |
| 10 / user / 1h | Login attempts per user | §29 |
| 60 / user / 1h | Refresh per user | §29 |
| 600 / user / h | Parent reads (raised from 300) | §29 |
| 100 / school / h | Manual SMS per school | §29 |
| 10k / school / day | Manual SMS recipients per school | §29 |
| 60 / IP / min | Public endpoints | §29 |
| 600 / user / min | Authenticated default | §29 |

### Retention & lifecycle
| Value | Meaning | Section |
|---|---|---|
| 90 days | SMS log retention | §27, §32 |
| 2 years | Attendance cold-archive threshold | §32 |
| 7 years | Attendance total retention | §32 |
| 3 years | Audit log retention (immutable, then cold) | §32 |
| 7 years min | Payment immutability / retention | §32 |
| 90 days | Suspended-tenant grace before deletion | §32 |
| 35 days | RDS automated backup + PITR window | §33 |
| 5 min | PITR granularity | §29, §33 |

### Non-functional targets (§29)
| Value | Meaning | Section |
|---|---|---|
| <300ms | P95 read latency (excl. async) | §29 |
| <600ms | P95 write latency (excl. async) | §29 |
| 99.9% | Uptime target | §29 |
| ≤30 min | RPO (recovery point objective) | §29 |
| ≤4 hours | RTO (recovery time objective) | §29 |
| 500 | Concurrent payment submissions (design basis) | §29 |
| 10k / <30 min | SMS clearance target | §29 |

---

## Section 4 — Model & Table Name Mapping

All 48 models from the §17 Prisma schema. **Tenant-scoped** = carries `school_id`. RLS applies to every `school_id`-bearing table (§21.3); `schools` alone is not RLS'd. **Soft-delete** = has `deletedAt`.

| Model (camelCase) | `@@map` table | Tenant-scoped | RLS policy | Soft-delete |
|---|---|---|---|---|
| `School` | `schools` | — (root) | no | no |
| `Campus` | `campuses` | yes | yes | no |
| `AcademicYear` | `academic_years` | yes | yes | no |
| `Class` | `classes` | yes | yes | no |
| `Section` | `sections` | yes | yes | no |
| `Subject` | `subjects` | yes | yes | no |
| `Holiday` | `holidays` | yes | yes | no |
| `User` | `users` | yes | yes | **yes (deletedAt)** |
| `RefreshToken` | `refresh_tokens` | yes | yes | no |
| `PasswordResetToken` | `password_reset_tokens` | yes | yes | no |
| `ParentProfile` | `parent_profiles` | yes | yes | no |
| `Student` | `students` | yes | yes | **yes (deletedAt)** |
| `StudentGuardian` | `student_guardians` | yes | yes | no |
| `StudentEnrollment` | `student_enrollments` | yes | yes | no |
| `StaffProfile` | `staff_profiles` | yes | yes | no |
| `TeacherAssignment` | `teacher_assignments` | yes | yes | no |
| `Inquiry` | `inquiries` | yes | yes | no |
| `EntryTest` | `entry_tests` | yes | yes | no |
| `Admission` | `admissions` | yes | yes | no |
| `FeeHead` | `fee_heads` | yes | yes | no |
| `FeeStructure` | `fee_structures` | yes | yes | no |
| `FeeInvoiceBatch` | `fee_invoice_batches` | yes | yes | no |
| `FeeInvoice` | `fee_invoices` | yes | yes | no |
| `FeeInvoiceItem` | `fee_invoice_items` | yes | yes | no |
| `FeePayment` | `fee_payments` | yes | yes | no |
| `PaymentReversal` | `payment_reversals` | yes | yes | no |
| `Discount` | `discounts` | yes | yes | no |
| `LateFeePolicy` | `late_fee_policies` | yes | yes | no |
| `GuardianCredit` | `guardian_credits` | yes | yes | no |
| `AttendanceRecord` | `attendance_records` | yes | yes | no |
| `StaffAttendance` | `staff_attendance` | yes | yes | no |
| `StudentLeave` | `student_leaves` | yes | yes | no |
| `StaffLeave` | `staff_leaves` | yes | yes | no |
| `GradeScale` | `grade_scales` | yes | yes | no |
| `Term` | `terms` | yes | yes | no |
| `ExamDefinition` | `exam_definitions` | yes | yes | no |
| `ExamResult` | `exam_results` | yes | yes | no |
| `ReportCard` | `report_cards` | yes | yes | no |
| `TimetableSlot` | `timetable_slots` | yes | yes | no |
| `SalaryStructure` | `salary_structures` | yes | yes | no |
| `PayrollRun` | `payroll_runs` | yes | yes | no |
| `Payslip` | `payslips` | yes | yes | no |
| `SmsTemplate` | `sms_templates` | yes | yes | no |
| `SmsLog` | `sms_logs` | yes | yes | no |
| `SmsCreditLedger` | `sms_credit_ledger` | yes | yes | no |
| `Document` | `documents` | yes | yes | no |
| `AuditLog` | `audit_logs` | yes | yes | no |
| `IdempotencyKey` | `idempotency_keys` | yes | yes | no |

**Partitioned from day one (§30):** `attendance_records`, `sms_logs`, `audit_logs` use monthly partitioning.
**RLS CI check:** a script greps the schema and fails if any `school_id`-bearing table lacks a policy.

---

## Section 5 — Error Codes & Action Codes

### Error-code catalog — Appendix A (exact strings; maintained in `error-codes.ts`, published via OpenAPI)
| Code | Meaning |
|---|---|
| `TENANT_MISMATCH` | JWT `schoolId` ≠ resolved tenant → 403 (§19) |
| `TENANT_SUSPENDED` | Suspended tenant → 403, not 404 (§21.1) |
| `INVALID_STATE_TRANSITION` | Disallowed state-machine transition → 409 (§8) |
| `ATTENDANCE_CONFLICT` | Cross-teacher differing attendance value → 409 (§9) |
| `ATTENDANCE_LOCKED` | Edit outside window / leave-locked cell |
| `RESULTS_INCOMPLETE` | Publish attempted with missing marks → 422 (§11) |
| `WEIGHTAGE_SUM_INVALID` | Term exam weightages ≠ 100 (§11) |
| `IDEMPOTENCY_KEY_REUSED` | Same key, different request hash → 409 (§25.4) |
| `OVERPAYMENT_USE_ADVANCE` | Payment > remaining → 422, use advance endpoint (§12) |
| `SECTION_FULL` | HARD capacity mode blocks enrollment → 422 (§7) |
| `GR_NUMBER_TAKEN` | Duplicate GR number for school |
| `LEAVE_OVERLAP` | Overlapping PENDING/APPROVED leave → 409 (§10) |
| `INSUFFICIENT_SMS_CREDITS` | Balance ≤ 0 blocks non-critical sends (§14) |
| `PHONE_UNVERIFIED` | Unverified number cannot receive PII SMS (§14) |

### Audit-action catalog — Appendix B (exact strings; maintained in `audit-actions.ts`)
`FEE_WAIVED` · `FINE_WAIVED` · `PAYMENT_REVERSED` · `GRADE_CHANGED_POST_PUBLISH` · `ROLE_CHANGED` · `ATTENDANCE_EDITED_POST_WINDOW` · `DISCOUNT_APPROVED` · `DISCOUNT_REVOKED` · `PROMOTION_OVERRIDE` · `WITHDRAWAL_FEE_OVERRIDE` · `PII_ANONYMIZED` · `DATA_EXPORTED` · `SUPPORT_SESSION_STARTED` · `USER_DISABLED` · `MFA_RESET`

**Structured log lines (not AuditLog rows):** `TENANT_VIOLATION` (pages on-call, §31), `REFRESH_REUSE_DETECTED` (§22.4), `REDACTED-{shortid}` anonymization token (§32).

---

## Section 6 — Key Business Rules (Immutable Phrasing)

The 20 most critical rules, as exact testable sentences. Copy verbatim into every downstream document — do not paraphrase.

1. Students are never linked directly to a section. Placement is always through an enrollment row scoped to an academic year. *(§7)*
2. One ACTIVE enrollment per student per academic year (enforced by partial unique index). *(§7)*
3. Exactly one `isCurrent=true` AcademicYear per school, and exactly one `isPrimary=true` guardian per student (partial unique indexes). *(§7, §8, §17.1)*
4. Moves are new rows, never destructive field updates: TRANSFERRED_OUT closes the old enrollment with `endedAt` and creates a new ACTIVE enrollment. *(§7)*
5. The admit action is transactional and includes: guardian resolution, Student creation, StudentGuardian link(s), ACTIVE StudentEnrollment, Admission row, and the admission invoice if the school defines an ADMISSION-type fee structure. *(§8)*
6. Guardian resolution never silently auto-merges: the server surfaces a phone match and requires an explicit link-or-create choice. *(§8)*
7. GR number uniqueness is `[schoolId, grNumber]` whether auto-sequenced or manually entered. *(§8)*
8. Bulk attendance returns 200 with partial-failure details `{succeeded, failed, errors[]}`, not all-or-nothing. *(§9, §25.3)*
9. Absence SMS fires for ABSENT only (not LATE/HALF_DAY), to the primary guardian, once per (student, date), deduplicated by key `absence:{enrollmentId}:{date}`. It never fires for ON_LEAVE. *(§9)*
10. Student and staff leaves are modeled as two separate tables (`StudentLeave`, `StaffLeave`) to eliminate the XOR-nullable defect. *(§10)*
11. Grades are computed at read/publish time from the active GradeScale. The `ExamResult.grade` stored column is removed (derived data). *(§11)*
12. The sum of a class's exam weightages within a term must equal 100 before that term's report cards can be generated (else `WEIGHTAGE_SUM_INVALID`). *(§11)*
13. Parents and students see results only when the exam is PUBLISHED. Post-publish mark change requires OWNER_ADMIN + reason + AuditLog + PDF regeneration + "Corrected" SMS. *(§11)*
14. Fee invoice generation is idempotent via unique constraint `[schoolId, classId, month, year]`; a duplicate attempt returns the existing batch (200, `alreadyExists: true`). *(§12)*
15. Invoice `paidAmount` must be ≤ `totalAmount`; `totalAmount = Σ items.amount` and `paidAmount = Σ payments − Σ reversals`, maintained transactionally. *(§12)*
16. Payments are immutable. Corrections are made via PaymentReversal only; only OWNER_ADMIN approves reversals. *(§12)*
17. The payment endpoint requires an `Idempotency-Key` header and runs inside one serializable transaction that locks the invoice row (`SELECT … FOR UPDATE`). *(§12, §25.4)*
18. A suspended tenant returns 403 `TENANT_SUSPENDED`, not 404 — parents deserve a truthful error page. *(§21.1)*
19. Row-Level Security is enabled and FORCED on every tenant table; `current_setting('app.current_school_id', true)` returns NULL when unset, yielding zero rows (fail-closed). Only `schools` is not RLS'd. *(§21.3)*
20. Public routes without JWT are exhaustively: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /webhooks/sms/:provider` (HMAC), `GET /health/live`, `GET /health/ready`. *(§19)*

---

## Section 7 — Role & Permission Constants

### The 8 application roles (§5)
| Role | Scope | Summary |
|---|---|---|
| `PLATFORM_ADMIN` | Vendor-side, cross-tenant | Provisions/suspends tenants, plans & SMS credits, platform analytics; separate `admin.platform.pk` console; never impersonates without audited break-glass (§22.9). |
| `OWNER_ADMIN` | Whole school | Full control of one tenant. |
| `CAMPUS_ADMIN` | One campus (`User.campusId` required) | Admin limited to their campus. |
| `ACCOUNTANT` | School or campus | Fees, payments, financial reports. |
| `TEACHER` | Own assignments | Attendance, marks, homework for assigned sections/subjects. |
| `STAFF` | Self | Non-teaching employee: own payslips, own leaves. |
| `PARENT` | Own children | Read portal + leave requests for their children. |
| `STUDENT` | Self | Read portal (own attendance, results, invoices, timetable). |

### Multi-role rule (§5)
One person = **one User row per school**; `roles` is a Postgres enum array (e.g. a teacher-parent is `[TEACHER, PARENT]` with both a StaffProfile and a ParentProfile). Effective permission = union of role grants; scope checks still apply per role.

### OWNER_ADMIN-only authority (hierarchy notes)
- Only **OWNER_ADMIN** approves **payment reversals** (§12).
- Only **OWNER_ADMIN** sets invoice **WAIVED** status / fee waivers, with reason (§12).
- Only **OWNER_ADMIN** may change a mark **post-publish** (reason + AuditLog + regen) (§11).
- Only **OWNER_ADMIN** can **override promotion preconditions** with an audited reason (§7).
- Only **OWNER_ADMIN** can override **LEAVING_CERT** fee-clearance block (§15).
- Users with TEACHER/ACCOUNTANT/CAMPUS_ADMIN/STAFF roles **must** have a StaffProfile (service invariant, §13).
- CAMPUS_ADMIN may only grant roles **≤ TEACHER/STAFF/ACCOUNTANT** (§23).
- MFA is **mandatory** for OWNER_ADMIN and ACCOUNTANT; optional otherwise (§22.5).

Row-level scope is enforced by the §22.8 guards: **CampusScopeGuard, SectionOwnershipGuard, SubjectOwnershipGuard, GuardianOfStudentGuard, SelfGuard**. The full C/R/U/D permission matrix lives in blueprint §23; CI includes a matrix→route conformance test so matrix and API cannot drift.

---

## Section 8 — API Path Prefixes & Conventions

| Concern | Value (verbatim) | Source |
|---|---|---|
| Base path | `/api/v1` — JSON, JWT-cookie auth, tenant-scoped | §24 |
| Tenant addressing | Subdomain `{slug}.platform.pk` or verified custom domain; vendor console at `admin.platform.pk` | §2, §5 |
| Webhook path pattern | `POST /webhooks/sms/:provider` — public, HMAC-verified | §14, §24 |
| Idempotency-Key required on | **payments, reversals, advances, manual SMS send** (UUID header) | §25.4 |
| CSRF protection | Non-httpOnly `csrf` cookie + `X-CSRF-Token` header double-submit on every state-changing request (exempt: HMAC webhook) | §22.2, §22.7 |
| Token transport | Access + refresh as **httpOnly, Secure, SameSite=Strict** cookies; refresh cookie path-limited to `/api/v1/auth/refresh` | §22.2 |
| Timezone (v1) | Asia/Karachi (fixed); date filters are ISO dates in school TZ | §25.2 |

### Public (no-JWT) routes — exhaustive (§19)
`POST /auth/login` · `POST /auth/refresh` · `POST /auth/forgot-password` · `POST /auth/reset-password` · `POST /webhooks/sms/:provider` · `GET /health/live` · `GET /health/ready`

### Auth routes (§24)
`POST /auth/login` · `POST /auth/mfa/challenge` · `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/forgot-password` · `POST /auth/reset-password` · `POST /auth/change-password` · `POST /auth/mfa/setup` · `POST /auth/mfa/verify` · `DELETE /auth/mfa` · `GET /auth/me`

### HTTP status usage (§25.1)
| Code | Usage |
|---|---|
| 200 | read / idempotent-replay |
| 201 | create |
| 202 | queued |
| 204 | delete / logout |
| 400 | malformed |
| 401 | unauthenticated |
| 403 | authz / tenant |
| 404 | not found or cross-tenant (indistinguishable by design) |
| 409 | conflict / state-transition / duplicate |
| 422 | validation / business-rule |
| 429 | rate limited (+ Retry-After) |
| 500/503 | server error |

**Error envelope (§25.1):** all non-2xx responses use `{ "error": { "code", "message", "details": [{field, issue}], "requestId" } }`. Codes are stable machine strings from `error-codes.ts`, published in OpenAPI. Success lists use `{ data, total, page, pageSize }`.

---

## Changelog

- **v1.0** — Initial register. Extracted verbatim from `school-management-master-blueprint.md` v2.0. Locked.
