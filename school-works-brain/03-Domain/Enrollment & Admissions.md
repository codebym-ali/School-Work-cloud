---
title: Enrollment & Admissions
type: domain
updated: 2026-07-06
---

# Enrollment & Admissions

The **domain spine**. Everything (attendance, invoices, results, timetables) references an **enrollment**, never a "current section."

## Academic years & enrollment (§7)
- `AcademicYear` per school; exactly one `isCurrent` (partial unique); years never overlap.
- `StudentEnrollment` = (student, year, campus, class, section, rollNumber, status). **One ACTIVE per student per year.**
- Status: `ACTIVE → { PROMOTED | RETAINED | TRANSFERRED_OUT | WITHDRAWN | COMPLETED }`.
- **Moves are new rows**: TRANSFERRED_OUT closes the old (`endedAt`) and creates a new ACTIVE — never a destructive update.
- **Promotion** (year-end): clone structure → bulk promote per section (override to RETAINED/WITHDRAWN) → queued idempotent job; preconditions (report card published, fee clearance) OWNER_ADMIN-overridable. *(Promotion lands in M6.)*

## Admissions pipeline (§8)
Inquiry state machine (single source of truth):
```
INQUIRY ──schedule──▶ ENTRY_TEST_SCHEDULED ──result──▶ PASSED | FAILED
   │                                                       │
   ├──admit (no test)──▶ ADMITTED            (FAILED ──admit override, audited──▶ ADMITTED)
   └──reject/withdraw──▶ REJECTED | WITHDRAWN   (reason required)
```
Illegal transition → **409 INVALID_STATE_TRANSITION**.

**Admit is one transaction:** guardian resolution → Student (GR number) → StudentGuardian link(s) (exactly one primary) → ACTIVE StudentEnrollment (current year) → Admission row → inquiry ADMITTED → admission invoice *(when an ADMISSION fee structure exists — wires up in [[Fees & Payments|M4]])*. Age-band eligibility checked if the class configures it.

## Guardian resolution (never auto-merge)
Server searches existing parents by **normalized phone**; the client makes an **explicit LINK-or-CREATE** choice. New parent → User(`[PARENT]`, INVITED) + ParentProfile + SMS set-password link. → [[Key Decisions]].

## GR number
Auto-sequenced per school (`nextGrNumber` + prefix) or MANUAL; uniqueness `[schoolId, grNumber]` either way. Dup → `GR_NUMBER_TAKEN`.

**Source:** [[03-database-schema-erd]], blueprint §7–§8.
**Implementation status:** ✅ built and green (M2), minus promotion (M6) & CSV import (deferred). Directory search (name/GR/phone), transfer, audit all working → [[Progress Tracker]].
