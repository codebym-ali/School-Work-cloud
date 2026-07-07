---
title: Data Model
type: data
updated: 2026-07-06
---

# Data Model

**48 Prisma models**, snake_case tables, UUID PKs, `Decimal(12,2)` money. Every tenant table's first scalar is `school_id` with a real relation to `School`. Full mapping table: [[consistency-register]] §4. Schema brief: [[03-database-schema-erd]].

## Conventions (§17)
- `@@map`/`@map` on every model/field; `createdAt`/`updatedAt` on mutable tables; optional `createdById`.
- Soft delete (`deletedAt`) only on **User** and **Student**. **No hard cascade delete in the product.**
- Composite tenant-chain FK `(parentId, schoolId)` → parent `@@unique([id, schoolId])`. → [[Multi-Tenancy & Isolation]].
- `onDelete: Restrict` default; `Cascade` only on invoice items & guardian links.

## Model groups
- **Tenant root/setup:** School, Campus, AcademicYear, Class, Section, Subject, Holiday
- **Identity:** User, RefreshToken, PasswordResetToken
- **People:** ParentProfile, Student, StudentGuardian, StudentEnrollment, StaffProfile, TeacherAssignment
- **Admissions:** Inquiry, EntryTest, Admission
- **Fees:** FeeHead, FeeStructure, FeeInvoiceBatch, FeeInvoice, FeeInvoiceItem, FeePayment, PaymentReversal, Discount, LateFeePolicy, GuardianCredit
- **Attendance/leaves:** AttendanceRecord, StaffAttendance, StudentLeave, StaffLeave
- **Exams:** GradeScale, Term, ExamDefinition, ExamResult, ReportCard
- **Timetable/HR:** TimetableSlot, SalaryStructure, PayrollRun, Payslip
- **Comms:** SmsTemplate, SmsLog, SmsCreditLedger
- **Documents/cross-cutting:** Document, AuditLog, IdempotencyKey

## Constraints Prisma can't express (raw-SQL companions, §17.1)
Partial uniques (one `isCurrent` year, one `isPrimary` guardian, one ACTIVE enrollment, one batch invoice per student/month, `[school, method, transactionRef]`); CHECKs (paid ≤ total; absent XOR marks; leave date order; grade band); **RLS policies on every `school_id` table**; trigram index for name search.

## Growth & partitioning (§30)
`attendance_records`, `sms_logs`, `audit_logs` are **monthly-partitioned from day one**.

**Source:** [[03-database-schema-erd]], [[consistency-register]] §1–§4, blueprint §17.
**Implementation status:** ✅ schema + SQL companions applied (M1); RLS-coverage check is a gate → [[Progress Tracker]].
