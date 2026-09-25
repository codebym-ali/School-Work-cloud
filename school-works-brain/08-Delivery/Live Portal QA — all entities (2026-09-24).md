---
title: Live Portal QA — all entities
type: delivery
updated: 2026-09-24
author: Senior QA
---

# Live Portal QA — every entity, every module (2026-09-24)

Logged into each entity's real portal on the running demo tenant (**demo.localhost**, owner-web :3005 /
staff-web :3006 / student-web :3003) with the seeded credentials ([[SEED-CREDENTIALS]] equivalent) and
exercised each module with real actions, cross-checking data across portals. This complements the automated
suites (which use hermetic throwaway tenants) with real end-user verification.

## ✅ Verified working (live)
- **Teacher** — attendance picker scoped to own sections only (**closes QA C9 live**); mark → save → absence
  SMS queued; 7-day coverage strip; My Classes; self-scoped "unmarked today".
- **Accountant** — Fees **Collect → receipt #23 PDF**; Payroll draft with per-person breakdown; dashboard.
- **Admission Controller** — **direct admission** of a new student (Reg/GR + guardian); Students list/filter.
- **Owner** — full 25-module panel; sees all 6 sections (vs teacher's 2).
- **Campus Admin** — correct RBAC: **no** Fees-collect / Payroll / Campus Hub; campus-scoped counts.
- **HR Manager** — after the campus fix (below): 9 staff + 36 coverage gaps.
- **Student** — self-scoped dashboard (attendance/fees/results/guardians).
- **Security/RBAC live**: owner door refuses the campus admin (byte-identical to wrong password); HR gets
  "Not authorized" on /exams; MFA nudge on every money role.
- **Cross-entity data integrity**: the teacher's marking, accountant's collection and the new admission all
  reconciled on the owner/campus dashboards (31 students · Rs 86,500 collections · attendance % · defaulters).

## 🐞 Findings
1. **[FIXED] HR Manager had no campus → role unusable.** Seed created `hr@demo.pk` campus-less
   (`campusBound: false`); the staff directory is campus-scoped, so HR saw 0 staff ("No campus is assigned").
   The owner UI **cannot repair it** (Campus Hub lists only campus-bound users; no user-campus editor).
   **Fix:** `scripts/fix-hr-campus.ts` bound the live HR to Main Campus (verified: 9 staff now visible), and
   `seed-real-school.ts` set to `campusBound: true` so it can't recur. Commit `815ff81`.
   - **Follow-up (open, P3):** the owner has no UI path to assign/repair a campus on an orphaned user.
2. **[P3, UI, systemic] Missing space before inline badges.** "Grade 8 — B**class teacher**", "Grade 6 —
   A**class teacher**" (teacher My Classes), "Hamza Butt**primary**" (student guardians). A shared
   badge component needs a leading space/margin.
3. **[P3, UX] Greeting uses email-derived name, not the person's real name.** Teacher: "Good afternoon,
   **Teacher1**" (should be Ayesha Farooq); HR "…, Hr"; Admission "…, Admissions"; Accountant/Owner/Campus
   show no name. Source the greeting from the staff-profile full name.
4. **[P3, data] GR / Reg-No format diverges.** Seeded students `REG-2026-001 / GR-0001`; a live admission
   gets `Reg No 3 / GR 3` (bare number) — the seed inserted GR strings directly instead of via the counter.
5. **[P3, minor] Campus-admin dashboard "Collections" figure renders blank** where the owner sees Rs 86,500.
6. **[Obs, expected] SMS broadcast = "0 families"** on the demo: it was seeded 2026-09-23, before the WS-D
   verified-phone fix, so guardians are unverified. A re-seed applies the fix. Not a new defect.
7. **[Obs, minor] Payroll September draft shows Rs 0 net** (empty draft beside August's Rs 45,000).
8. **[Obs] Staff "Joined this year: 0"** though 9 joined 2026-04-01 — possible metric-window quirk.

## Data provisioned during the pass (tester authority)
- Bound HR to Main Campus (fix #1).
- Marked **all 6 registers** for today → dashboard **97%+, 30→31 of 31 marked** (was 5/31); one absence
  (Fatima, from the teacher test) retained deliberately.
- Admitted 1 student (QA Test Student, Grade 6-A) via the admission flow; collected one fee (receipt #23).

## Follow-up pass (2026-09-25) — remaining entities + exams blocker
- **Super Admin (vendor console, :3004)** — live-tested `admin@platform.pk`: Fleet overview, Tenants,
  Billing (MRR/invoices/auto-reactivate/public price), Operators (with the "can't change your own role"
  self-guard). All render, no errors. **Obs:** the fleet snapshot is stale (dated 9/15) — "5 Schools" vs 1
  live tenant; the overview totals are a cached snapshot while the tenant list is live.
- **Operations Admin (deputy)** — provisioned `ops@demo.pk` (STAFF + OPERATIONS_ADMIN, school-wide; added to
  the seed + `scripts/add-ops-admin.ts`) and live-tested: deputy-level module set (Fees / Admissions /
  School-config that a campus admin lacks), greeted by name, **cannot** reach the owner-only Campus Hub /
  user management. Matches `ops-admin-authz.e2e`.
- **Exams blocker cleared** — the teacher's marks-entry was empty because the seed created no teacher-subject
  assignments (36 coverage gaps). Assigned a teacher live via Classes → section (as the ops admin, proving
  its write capability); the assignment persisted (Section A "6 → 5 unassigned"). Full exam → marks →
  report-card generation remains covered by `exams.e2e` (automated).

**Entity coverage is now complete:** Owner, Campus Admin, Accountant, HR Manager, Admission Controller,
Teacher, Student, **Operations Admin, Super Admin** — all live-tested.

## Assessment
No cross-tenant leak, no money error, no crash; RBAC/security boundaries held live, matching the automated
gates. The only user-blocking defect was #1 (HR campus), now fixed and re-verified. #2–#3 are cosmetic;
#4–#8 are seed/polish. Recommend fixing #2/#3 next and re-seeding the demo to pick up the WS-D + HR fixes.
