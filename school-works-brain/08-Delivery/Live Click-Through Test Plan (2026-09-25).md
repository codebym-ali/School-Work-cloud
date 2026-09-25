---
title: Live Click-Through Test Plan
type: delivery
updated: 2026-09-25
author: Senior QA + Eng + School Manager
status: proposed
---

# Live Click-Through Test Plan — remaining gaps, by priority (2026-09-25)

All 9 entities are live-tested and 1823 integration tests / 74 suites are green. What remains is **live
UI confirmation** of module flows that today are proven only by automated tests, plus a few small automated
niceties. This plan ranks everything by **operational risk to a real Pakistani private school** (money,
the child's academic record, and daily attendance rank highest) and gives an executable script per module.

**Environment:** demo.localhost · owner-web :3005 · staff-web :3006 · student-web :3003 · console :3004.
Credentials in `SEED-CREDENTIALS.md` (+ `ops@demo.pk` / Staff!Secret12). Every case says the **entity**, the
**preconditions** (data to provision first — tester provisions it), the **steps**, and the **pass criteria**.
Where a screenshot can't be taken (hidden pane), verify with `get_page_text` / `find` and the API result.

---

## Priority ranking of ALL remaining gaps

### P0 — money, academic records, or a daily gate (do first)
1. **Exams → marks → report card** (Teacher + Campus Admin/Owner) — the child's result; the one academic
   journey never clicked end-to-end. *Precondition now met:* a teacher is assigned to a Grade-6-A subject.
2. **Fees — payment submissions (claims) verify/reject** (Accountant) — minting a receipt from a claim is
   real money in.
3. **Leave requests — approve/reject** (Campus Admin) — an approved student leave **locks attendance**; an
   approved staff leave **feeds payroll**. Money + records.

### P1 — weekly/monthly operations (do next)
4. **Staff Attendance — mark + self check-in** (Campus Admin marks; any staff checks in) — feeds the payroll
   deduction.
5. **Timetable — build a period + hit a clash** (Campus Admin) — the week the school runs on.
6. **Cover — arrange + suggestions** (Campus Admin) — who teaches when a teacher is away; feeds pay.
7. **Defaulters — send reminders** (Accountant) — fee chase, real SMS to families.
8. **Reports — run all 7 + CSV/PDF download** (Owner/Accountant) — the exports offices keep (incl. the
   CSV-injection fix, only automated so far).
9. **Bell schedule (School Timings) — compose a day** (Campus Admin) — drives every period time.
10. **Year-end promotion — plan → commit** (Owner) — the yearly roll; automated race is covered, the UI
    journey is not.

### P2 — reads, derived views, settings (do last)
11. **Student portal sub-tabs** (Student) — Attendance / Timetable / Results / Fees (only the dashboard was
    opened).
12. **Performance drill-down** (Owner) — campus → class → student.
13. **School calendar / holidays** (Campus Admin) — declare a closure (changes attendance denominators).
14. **School settings** (Owner) — fee/attendance rules; a read + one safe toggle.
15. **Subjects — merge; Activity log — read** (Owner).
16. **Vendor console — a full tenant lifecycle** on a THROWAWAY tenant (Super Admin) — provision → suspend →
    reactivate → offboard, so the demo is never touched.

### Automated niceties (parallel track, not click-throughs)
A. C9 teacher-picker Playwright e2e · B. Fees reconciliation-CSV + advance-consumption · C. AssignCampus FE
e2e · D. Fleet-overview stale-snapshot fix (console shows "5 schools" vs 1 live — refresh the job or label it).

---

## Execution log

### Wave 1 started 2026-09-25
- **Exams — teacher marks-entry unblock: ✅ verified live.** After assigning a teacher to a Grade-6-A
  subject (done via Classes as the ops admin), `teacher1`'s **Exams & Results → Marks entry** changed from
  "You aren't assigned to teach any subject" to a working picker showing **"Grade 6 — A · Computer"**. The
  assignment → marks-entry path works end to end.
- **NEW FINDING (config gap, P2):** the demo's **grade scale is empty for 2026-27** ("No bands yet"), so a
  full exams → report-card run can't assign grades. **Fixed at source:** seed now creates a standard A+…F
  scale. Existing demo needs a re-seed (or a manual scale) to generate report cards live.
- **Full exams → marks → publish → report-card:** business logic is covered by `exams.e2e` (create/open/
  marks/publish/completeness-gate/generate + marks>total 422). Full live click-through is pending the
  re-seed (grade scale + verified phones) and an unhidden browser pane (below).
- **⚠️ Environment blocker:** the browser pane is minimized/hidden — screenshots time out and multi-field
  forms need repeated retries, making deep live click-throughs slow. Bring the pane forward for Waves 1–3.

## The executable plan (waves)

### Wave 1 — P0 (≈ half a day)

**1. Exams → report card.**
- *Precondition:* teacher assigned to Grade-6-A Mathematics (done live). Ensure a grade scale exists for
  2026-27 and Term-1 exam weightages sum to 100 (provision as owner if missing).
- *Steps (Owner/Campus Admin):* Exams → create a Mid-Term for Grade 6 (weightage 100) → **open marks entry**.
  Then (Teacher `teacher1`): Exams & Results → enter marks for Grade-6-A (all subjects, valid marks) → save.
  Try one row **marks > total → expect 422** (WS-C, live). Back as admin: **publish** (expect the
  completeness gate to block if any (student×subject) is unmarked). Generate report cards for the term.
- *Pass:* marks persist; publish succeeds only when complete; report card shows overall = mean, a grade from
  the scale, and section rank; **Student `REG-2026-001`** sees the report card under Results.

**2. Fees — claim verify/reject.**
- *Precondition:* one guardian fee-link claim exists, or submit one as accountant.
- *Steps (Accountant):* Payment submissions → open a pending claim → **Verify** (mints a receipt) → confirm
  the invoice moves toward PAID and a receipt number is issued; on a second claim → **Reject** with a reason.
- *Pass:* verify creates exactly one payment + receipt; reject records the reason and mints nothing; a campus
  admin cannot verify (button absent / 403).

**3. Leave requests — approve/reject.**
- *Steps (Campus Admin):* Leave requests → file a student leave for a Grade-6-A child over 2 working days →
  **Approve** → open that section's Attendance for those dates → the cells are **ON_LEAVE and locked**.
  File a staff leave for a teacher → approve → confirm it shows on the staff record.
- *Pass:* approval writes ON_LEAVE + locks the register; reject needs a reason; the teacher who filed cannot
  approve their own.

### Wave 2 — P1 (≈ 1 day)

**4. Staff attendance.** (Campus Admin) mark the day's staff register (present/absent); (any staff) self
check-in from My Portal. *Pass:* the day summary reflects it; a teacher cannot mark others; check-in takes no
tamperable input.

**5. Timetable.** (Campus Admin) set a period for Grade-6-A Mon P1 (teacher+subject) → set the SAME teacher
Mon P1 on another section → **expect a named clash (409)**. *Pass:* the clash names the class + period; a
different day is allowed; a teacher reads their own week but cannot author it.

**6. Cover.** (Campus Admin) mark a teacher away, arrange cover for their period, read **suggestions**
(FREE/BUSY). *Pass:* the covering teacher can then mark that register; a teacher cannot arrange their own
cover; cover into an APPROVED-payroll month is refused.

**7. Defaulters reminders.** (Accountant) Defaulters → send reminders → confirm the SMS log records one per
**verified** family and withholds unverified ones. *Precondition:* re-seed (F) first so guardian phones are
verified, else recipients = 0.

**8. Reports.** (Owner) run all 7 (daily-collection, fee-ledger, attendance-register, class-strength,
defaulters, exam-summary, sms-usage) → **download CSV and PDF** for two of them. *Pass:* CSV opens cleanly,
a `=`-leading cell is neutralised (the injection fix, live), and the CSV row set matches the on-screen view.

**9. Bell schedule.** (Campus Admin) School Timings → create a schedule, compose Monday's periods, save.
*Pass:* invalid/overlapping periods are refused with a clear message; the grid reflects the times.

**10. Year-end promotion.** (Owner) Year-end promotion → **plan** for the campus into 2027-28 → review →
**commit**. *Pass:* the cohort moves up exactly once; re-committing a stale plan is refused (409); graduating
class becomes leavers.

### Wave 3 — P2 (≈ half a day)
11. **Student portal** (`REG-2026-001`): open Attendance / Timetable / Results / Fees — each shows only that
    child's data. 12. **Performance:** owner drills campus → class → student. 13. **Holidays:** declare a
    closure; confirm it appears on the calendar and changes the working-day count. 14. **School settings:**
    read; toggle one safe setting and confirm it saves. 15. **Subjects merge; Activity log** reads the audit
    trail (every mutation above should appear). 16. **Console lifecycle on a throwaway tenant** (never the
    demo): provision → suspend (its login 403s) → reactivate → offboard (retention → purge, with the
    subdomain-confirm gate).

---

## Data to provision before starting (tester)
- **Re-seed the demo** (`pnpm db:seed-real -- --commit`) — gives verified guardian phones (Waves 1/2 SMS),
  the campus-bound HR, the deputy, and the canonical GR format in one clean state. Do this FIRST; it also
  regenerates `SEED-CREDENTIALS.md`. (Re-apply the live teacher-subject assignment after, or assign fresh.)
- **Grade scale + Term weightages = 100** for 2026-27 (for report cards).
- **A guardian fee-link claim** (for Wave-1 claim verify) — mint a link as accountant and file a claim.

## Acceptance (whole plan)
Every module above exercised **as the right entity**, with the write persisting and the derived views
agreeing across portals (the same cross-entity reconciliation the first pass proved for attendance/fees).
Any new defect is logged one-by-one with severity + evidence and fixed with a merge-blocking regression,
exactly as the earlier remediation did. **Effort:** ~2 days live + ~1 day for the automated niceties (A–C).

## Sequencing note (school lens)
Waves mirror the school's own rhythm: **daily** money + attendance + results (Wave 1), **weekly/monthly**
timetable + cover + fees chase + reports (Wave 2), **yearly + settings** (Wave 3). If time is short, Wave 1
alone covers the flows a parent actually feels — a wrong result, a mis-posted fee, a lost leave.
