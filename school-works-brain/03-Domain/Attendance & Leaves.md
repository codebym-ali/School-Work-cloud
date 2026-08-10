---
title: Attendance & Leaves
type: domain
updated: 2026-07-06
---

# Attendance & Leaves

## Attendance (§9)
- One record per **(enrollment, date, session)**. Sessions per school: `[MORNING]` or `[MORNING, EVENING]`.
- **Write validation:** not future; not a `Holiday`/weekly-off (admin `allowHolidayOverride` only, audited); enrollment ACTIVE in the current year; the section is among the teacher's assignments.
- **Edit lock:** editable by the marking teacher for `attendanceEditWindowDays` (default 3); after, only admins, with a reason + AuditLog.
- **Conflict:** a co-assigned teacher submitting a *different* value → **409 ATTENDANCE_CONFLICT** (no silent last-write-wins). Leave-locked cells → `ATTENDANCE_LOCKED`.
- **Bulk = partial-failure** (§25.3): `200 { succeeded, failed, errors[], absenceQueued }` — not all-or-nothing.
- **Absence SMS:** ABSENT only (not LATE/HALF_DAY), primary guardian, once per (student, date), dedup key `absence:{enrollmentId}:{date}`; never for ON_LEAVE. → [[HR, Payroll, Comms & Documents]].
- **Staff attendance:** per (staff, date, session); feeds payroll deductions → [[HR, Payroll, Comms & Documents]].

## Leaves (§10)
- Two tables — `StudentLeave`, `StaffLeave` — to avoid the XOR-nullable defect.
- Machine: `PENDING → APPROVED | REJECTED` (terminal); `CANCELLED` by the requester while PENDING. Rejection needs a reason.
- **Overlap** with an existing PENDING/APPROVED leave for the same person → **409 LEAVE_OVERLAP**.
- **Staff quotas** per type (`CASUAL/SICK/UNPAID/OTHER`); exceeding auto-flags the request **UNPAID** unless overridden.
- **On approval of a student leave:** a job writes/overwrites `ON_LEAVE` across the range and **locks** those cells against teacher edits.

**Source:** [[03-database-schema-erd]], blueprint §9–§10.
**Implementation status:** ✅ built and green (M3). Absence SMS verified end-to-end via the [[HR, Payroll, Comms & Documents|SMS pipeline]]; ON_LEAVE writing on approve works → [[Progress Tracker]]. *Note: §22.8 section-ownership is enforced in the service (guards run before the tenant tx).* **Cover added 2026-08-10** — `assertCanMark` now also admits a teacher who holds a `CoverAssignment` for that section **on that date**, which is why the check takes a `date`. Recording cover is an admin act, not a teacher one → [[Cover Plan]].
