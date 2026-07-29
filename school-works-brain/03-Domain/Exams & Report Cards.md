---
title: Exams & Report Cards
type: domain
updated: 2026-07-07
status: built (M5)
---

# Exams & Report Cards

> [!success] Built — **M5 done** (2026-07-07). Enter/publish marks + report card issued. Build state at the bottom + [[Progress Tracker]].
> [!warning] The "parent view" this note used to describe **no longer exists** — the parent portal was removed 2026-07-28 ([[Key Decisions]]). Results reach the home by **SMS to the primary guardian**; the PDF is fetched by staff or by the **student** in their own portal.

## Grading (§11)
- `GradeScale` per school/year (label, minPercent, maxPercent, gradePoint). **Grades are computed at read/publish** from the scale — no stored `grade` column.
- `Term` per year; each `ExamDefinition` belongs to a term with a `weightagePercent`. **A class's exam weightages must sum to 100** before that term's report cards generate (else `WEIGHTAGE_SUM_INVALID`).

## Term result formula (authoritative)
Per subject: `termPercent = Σ over exams (marksObtained/totalMarks × weightagePercent)`. Absent-in-exam → contributes 0, prints "ABS". Overall = mean of subject termPercents (equal weighting in v1). **Rank = dense rank** by overall within section (ties share, next skips: 1,1,3); students absent from all exams are unranked.

## Marks & publication
- Teachers enter marks only for **assigned (section, subject)** pairs; `marksObtained ≤ totalMarks`. Bulk = upsert with per-row errors.
- `ExamDefinition.status: DRAFT → MARKS_ENTRY → PUBLISHED`. Students see results **only when PUBLISHED**, and the "result ready" SMS is only sent then.
- **Publish completeness gate:** every (enrolled student × class subject) has a mark or `isAbsent`, else `RESULTS_INCOMPLETE`.
- **Post-publish mark change:** OWNER_ADMIN + reason + AuditLog + regenerate PDF (old S3 version kept) + re-send "Corrected" SMS.

## Report cards
Queued job per term → PDF to R2 → `Document` (REPORT_CARD) + `ReportCard` row per student → "result ready" SMS to primary guardian. The PDF is served through short-lived pre-signed URLs to **staff and the student**; the guardian gets the SMS, not a link (no parent login exists).

**Source:** [[03-database-schema-erd]], blueprint §11.
**Implementation status:** ✅ **built (M5)** → [[Progress Tracker]]. Module `exams/` (exam-setup, exams, report-cards + pure `exam-grading.ts`). Deferred: PDF render + R2 upload (fileKey is a placeholder — needs upload pipeline §22.6), post-publish mark correction flow, per-subject grade breakdown.
