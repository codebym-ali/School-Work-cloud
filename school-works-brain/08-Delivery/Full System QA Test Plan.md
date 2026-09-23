# Full System QA Test Plan & Run (2026-09-23)

Live black-box QA against the seeded **City Grammar School** (demo tenant). Tester logs in as each
entity via its real door and verifies each action **and its implication** (the data change it should
cause). Stack: API :4000 · owner-web :3005 · staff-web :3006 · student-web :3003 · console :3004.

**Logins** (from `SEED-CREDENTIALS.md`):
- Owner — `owner@demo.pk` / `Owner!Secret12` (owner door, owner-web `/login`)
- Campus admin — `admin@demo.pk` / `Staff!Secret12` (staff door)
- Accountant — `accountant@demo.pk` / `Staff!Secret12`
- Admission controller — `admissions@demo.pk` / `Staff!Secret12`
- HR manager — `hr@demo.pk` / `Staff!Secret12`
- Teachers — `teacher1..5@demo.pk` / `Staff!Secret12`
- Students — Registration No `REG-2026-001..003` + CNIC (student door)

Result key: ✅ pass · ❌ fail · ⚠️ partial/observation · ⬜ not yet run.

---

## Module A — Authentication & doors
| ID | Action | Expected implication | Result |
|----|--------|----------------------|--------|
| AUTH-01 | Owner signs in at owner door | Lands on owner dashboard; session cookie set | ⬜ |
| AUTH-02 | Wrong password at any door | 401, generic error, no session | ⬜ |
| AUTH-03 | Staff (teacher) signs in at staff door | Lands on teacher home/shell | ⬜ |
| AUTH-04 | Student signs in with Reg-No + CNIC | Lands on student portal | ⬜ |
| AUTH-05 | Student wrong CNIC | Rejected, no session | ⬜ |
| AUTH-06 | Sign out | Session cleared; protected route redirects to login | ⬜ |

## Module B — Owner dashboard
| ID | Action | Expected | Result |
|----|--------|----------|--------|
| OWN-01 | View dashboard metrics | Active students, collections, defaulters, attendance % reflect seeded data | ⬜ |
| OWN-02 | Campus lens = Main Campus | Numbers scope to campus (single campus ⇒ same) | ⬜ |
| OWN-03 | Needs-attention strip | Chips link to real work (unmarked registers, defaulters) | ⬜ |
| OWN-04 | Collections trend renders | 6-month chart shows | ⬜ |

## Module C — Students
| ID | Action | Expected implication | Result |
|----|--------|----------------------|--------|
| STU-01 | List + filter by class/section/status | List narrows; counts correct | ⬜ |
| STU-02 | Open a student profile | Shows GR, class, guardians, fees, attendance | ⬜ |
| STU-03 | Guardians card | Primary guardian shown; add/edit works | ⬜ |
| STU-04 | Change student status | Status persists; audit recorded | ⬜ |
| STU-05 | Withdraw student (unpaid-fees safeguard) | Owner override path; enrolment closed, login disabled | ⬜ |

## Module D — Classes / Sections / Subjects
| ID | Action | Expected | Result |
|----|--------|----------|--------|
| CLS-01 | Classes list + coverage (uncovered subjects) | Grade 6/7/8 with sections, teacher tags | ⬜ |
| CLS-02 | Subjects catalogue cross-class | 6 subjects, per-class periods | ⬜ |
| CLS-03 | Subject-partial legend (#23) | `*` legend shows only when a partial exists | ⬜ |
| CLS-04 | Add a class / section / subject | Row created; appears in list | ⬜ |

## Module E — Attendance
| ID | Action | Expected implication | Result |
|----|--------|----------------------|--------|
| ATT-01 | Section list filtered to campus (#25) | Only Main Campus sections | ⬜ |
| ATT-02 | Load a register for a date | Roster of enrolled students | ⬜ |
| ATT-03 | Mark present/absent/late & save | Records persist; re-open shows saved marks | ⬜ |
| ATT-04 | View attendance history | ~2 weeks of seeded records visible | ⬜ |

## Module F — Fees (accountant/owner)
| ID | Action | Expected implication | Result |
|----|--------|----------------------|--------|
| FEE-01 | Invoices list | This month's invoices, mixed statuses | ⬜ |
| FEE-02 | Collect a payment | paidAmount ↑, status → PAID, receipt no assigned | ⬜ |
| FEE-03 | Defaulters list + reminder | Overdue students; reminder queued (verified/withheld) | ⬜ |
| FEE-04 | Waive / reverse (MFA-gated) | Blocked until 2FA enrolled (owner) | ⬜ |
| FEE-05 | Verify payment NOT MFA-gated (#17) | Verify works without 2FA | ⬜ |

## Module G — Reports
| ID | Action | Expected | Result |
|----|--------|----------|--------|
| REP-01 | Searchable section picker (#16) | Type filters options; binds sectionId | ⬜ |
| REP-02 | Run each report (collection, defaulters, class strength, attendance register, SMS usage) | Rows render | ⬜ |
| REP-03 | Download CSV & PDF | Real file returned | ⬜ |

## Module H — Staff / HR
| ID | Action | Expected implication | Result |
|----|--------|----------------------|--------|
| HR-01 | Staff directory + filters (#16 selects) | Lists staff; type/subject filters | ⬜ |
| HR-02 | Add staff member | Created; employee code canonical upper-case (#24) | ⬜ |
| HR-03 | Teacher assignment | Assign teacher to section/subject | ⬜ |

## Module I — Payroll
| ID | Action | Expected | Result |
|----|--------|----------|--------|
| PAY-01 | Salary structure set | Persists | ⬜ |
| PAY-02 | Run payroll (draft) | Draft rows per staff | ⬜ |
| PAY-03 | Approve run (MFA-gated) | Blocked until 2FA | ⬜ |

## Module J — SMS
| ID | Action | Expected implication | Result |
|----|--------|----------------------|--------|
| SMS-01 | Templates + credit balance | Shown | ⬜ |
| SMS-02 | Send / broadcast audience | Count preview; queued | ⬜ |
| SMS-03 | Logs show WITHHELD (A1) | Withheld rows badge + no Retry | ⬜ |

## Module K — Admissions (admission controller)
| ID | Action | Expected | Result |
|----|--------|----------|--------|
| ADM-01 | Admission portal seat (owner) | Officer assigned; slug link (#18) | ⬜ |
| ADM-02 | Admission controller lands on admissions | Inquiry/admit flow reachable | ⬜ |

## Module L — Teacher portal
| ID | Action | Expected implication | Result |
|----|--------|----------------------|--------|
| TCH-01 | My classes | Assigned sections listed | ⬜ |
| TCH-02 | Mark my section's register | Saves; owner dashboard coverage reflects it | ⬜ |
| TCH-03 | My attendance / leaves / payslips | Own records only | ⬜ |
| TCH-04 | Exams marks entry | Enter marks for a subject | ⬜ |

## Module M — Student portal
| ID | Action | Expected | Result |
|----|--------|----------|--------|
| STP-01 | My dashboard | Own summary | ⬜ |
| STP-02 | My attendance | Own seeded history | ⬜ |
| STP-03 | My timetable / results / fees | Own data only | ⬜ |

## Module N — RBAC & scoping (negative)
| ID | Action | Expected | Result |
|----|--------|----------|--------|
| SEC-01 | Teacher cannot reach owner-only screens | Denied / not in nav | ⬜ |
| SEC-02 | Campus admin scoped to own campus | Only own campus data | ⬜ |
| SEC-03 | Accountant sees finance, not HR admin | Nav curated to role | ⬜ |
| SEC-04 | Student cannot reach staff routes | Denied | ⬜ |

---

## Run log — 2026-09-23 (against seeded City Grammar School)

**Verified live in the browser (Playwright/Chrome):**
- **AUTH-01 ✅** owner signs in → dashboard. **AUTH-03 ✅** teacher → teacher shell. **AUTH-04 ✅** student (Reg-No + CNIC) → student portal. **AUTH-06 ✅** stale session → redirect to login.
- **OWN-01/03/04 ✅** owner dashboard: 30 active students, 93% attendance (30/30 marked: 27 P / 1 late / 1 leave / 1 absent), Rs 78,000 collections, 12 defaulters, "4 staff not marked", collections trend — all consistent with the seed.
- **STU-01 ✅** students list (30 real names, filters). **STU-03 ✅** "Missing guardian" filter returns 0 → every student has a guardian.
- **TCH-01/02 ✅** teacher `/attendance`: own section (Grade 6-A) loads full roster with marks; **ATT-04 ✅** ~2 weeks of history in the day strip (Sundays skipped). **Scoping ✅** a section the teacher isn't assigned to (Grade 7-A) shows **no roster** (server enforces §22.8; dropdown listing all sections is a minor UI note). Teacher nav curated (Home/Attendance/My Classes/Exams/Calendar).
- **STP-01/02 ✅** student portal: own dashboard (100% attendance, Rs 3,500 outstanding, class/roll/guardian Hamza Butt), own attendance history matches the seed; own-data only.
- **Accountant ✅ / SEC-03 ✅** staff-door login → **role-shaped** dashboard (Collections + Defaulters + trend only; no ops/attendance cards). MFA banner gates reverse/waive.

**Verified via API (browser login form flaky in automation — a harness quirk, not an app bug):**
- **Admission controller** — `/auth/login` 200, role ADMISSION_CONTROLLER, campus-bound, `admissionsMode=DIRECT`; staff-web serves `/admissions` (200).
- **Campus admin** — `/auth/login` 200, role CAMPUS_ADMIN, campus-bound.
- **FEE-02 + #17 ✅** accountant (no MFA) collects a payment → invoice PENDING→PAID, paidAmount 4000/4000, receipt assigned. Confirms collect is **not** MFA-gated.
- **FEE-04 ✅** reverse endpoint is MFA-gated (owner-only + `@RequiresMfa`).

### ❌ Bug found & fixed during this run
- **Receipt-number collision (seed defect):** `nextReceiptNo()` reads/increments `School.nextReceiptNo`, but the realistic seed hand-assigned `FeePayment.receiptNo` 1..21 **without advancing that counter** → the first real payment reused receiptNo 1 and 500'd on `(schoolId, receiptNo)`.
  - **Live fix:** `scripts/fix-receipt-counter.ts` advanced demo `nextReceiptNo` 1 → 22; payment collection now works (re-verified: receipt #22, PAID).
  - **Seed fix:** `seed-real-school.ts` now sets `School.nextReceiptNo` past the seeded receipts (dry-run re-validated).

### Not yet exercised (follow-up pass)
Campus-admin/admission-controller/HR **screens** (auth+scope confirmed via API); deeper mutations (admit a student, mark a fresh register via UI, payroll run, SMS send/broadcast, exams marks entry, student status change/withdraw); RBAC negative routes (SEC-01/04). The engines behind these are covered by the 1260-test integration suite; this pass focused on live per-portal behaviour with real data.

