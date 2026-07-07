---
title: Exams & Report Cards
type: domain
updated: 2026-07-06
status: planned (M5)
---

# Exams & Report Cards

> [!warning] Not built yet — **M5**. This note is the spec map.

## Grading (§11)
- `GradeScale` per school/year (label, minPercent, maxPercent, gradePoint). **Grades are computed at read/publish** from the scale — no stored `grade` column.
- `Term` per year; each `ExamDefinition` belongs to a term with a `weightagePercent`. **A class's exam weightages must sum to 100** before that term's report cards generate (else `WEIGHTAGE_SUM_INVALID`).

## Term result formula (authoritative)
Per subject: `termPercent = Σ over exams (marksObtained/totalMarks × weightagePercent)`. Absent-in-exam → contributes 0, prints "ABS". Overall = mean of subject termPercents (equal weighting in v1). **Rank = dense rank** by overall within section (ties share, next skips: 1,1,3); students absent from all exams are unranked.

## Marks & publication
- Teachers enter marks only for **assigned (section, subject)** pairs; `marksObtained ≤ totalMarks`. Bulk = upsert with per-row errors.
- `ExamDefinition.status: DRAFT → MARKS_ENTRY → PUBLISHED`. Parents/students see results **only when PUBLISHED**.
- **Publish completeness gate:** every (enrolled student × class subject) has a mark or `isAbsent`, else `RESULTS_INCOMPLETE`.
- **Post-publish mark change:** OWNER_ADMIN + reason + AuditLog + regenerate PDF (old S3 version kept) + re-send "Corrected" SMS.

## Report cards
Queued job per term → PDF to R2 → `Document` (REPORT_CARD) + `ReportCard` row per student → "result ready" SMS to primary guardian. Parents access via short-lived pre-signed URLs.

**Source:** [[03-database-schema-erd]], blueprint §11.
**Implementation status:** ⬜ planned (M5) → [[Progress Tracker]]. Depends on [[Enrollment & Admissions|enrollment]] (M2 ✅) and [[HR, Payroll, Comms & Documents|SMS]] (M3 ✅).
