---
title: Owner Gaps QA Test Plan
type: test-plan
updated: 2026-09-17
status: written; browser cases automated in test/e2e/qa/*.spec.ts
---

# Owner Gaps QA Test Plan

Test cases for everything built under the **Owner Gap Resolution Plan** (Phases 0–6), the **SMS opt-out** fix and
the **Cash Payroll Plan**. Written so a person could run each case by hand; the automation that runs it in a real
browser is named beside every case, so a gap is visible rather than assumed.

## Scope

| Area | Built in | Screens |
|---|---|---|
| Cross-door links, two-factor enforcement | Phase 0 | Campus Hub, Admissions team, banner, gated actions |
| Fee corrections | Phase 2 | Student profile → Fees card |
| Guardians, withdrawal, certificates | Phase 3.1–3.2 | Student profile |
| Year-end promotion | Phase 3.3 | Year-end promotion |
| Activity log, reports, defaulters, campus comparison, setup step 4 | Phase 4 | Activity log, Reports, Defaulters, Campus Hub, School configuration |
| Payroll (cash model) | Phase 5 + Cash Payroll Plan | Staff → Salary, Payroll, My Payslips, dashboard reminder |
| Broadcast SMS, opt-out | Phase 6.1 + item 9 | SMS & notifications |

**Out of scope:** money arithmetic, concurrency and RLS (owned by `test/integration`, which a browser cannot
express); expense tracking (not built, Decision D5); the live server (nothing is deployed).

## Test environment

| Item | Value |
|---|---|
| Stack | Local dev: API :4000 (built from HEAD), owner-web :3005, staff-web :3006, worker running for SMS cases |
| Tenant | A **disposable QA school** provisioned per run (`qa<stamp>.localhost`, no hyphen — see QA-O1), so the demo school's owner never needs two-factor and its data is untouched. Removed by the global teardown (`QA_KEEP=1` keeps it). AUTH-02/03 read the demo owner's unenrolled session and change nothing. |
| Accounts | Owner (2FA), campus admin A, accountant A (2FA), accountant B (2FA), teacher A, admission officer A and B |
| Data | Campus A + B, one class/section per campus, students with guardians, a July invoice batch, one cash payment, salaries |
| Two-factor | Enrolled through the real endpoints; codes generated from the enrolment secret |

## Conventions

- **Priority** — P1 blocks release (money, access, data exposure) · P2 core flow · P3 polish/copy.
- **Expected** is what the user sees, not what the database holds, unless the case says otherwise.
- **Rule for every access case:** a control renders *if and only if* the server would accept the click.

---

## AUTH · Doors and two-factor (Phase 0)

| ID | P | Case | Steps | Expected | Automated |
|---|---|---|---|---|---|
| AUTH-01 | P1 | Campus login link opens the staff door | Owner → Campus Hub → "Campus login" | Opens `…:3006/login?campus=<name>`; a campus admin signs in there | `qa/auth.spec` |
| AUTH-02 | P1 | Unenrolled owner is told what is locked | Owner without 2FA opens any page | Banner names reversals, waivers, CNIC, payroll approval, staff access and links to Security | `qa/auth.spec` |
| AUTH-03 | P1 | Gated action refused without 2FA, nothing changed | Unenrolled owner → Reverse a payment → reason → confirm | Dialog says two-factor is needed and "Nothing was changed"; receipt still active | `qa/auth.spec` |
| AUTH-04 | P1 | Owner-only door refuses a campus admin | Campus admin signs in on the owner door | Refused; the staff door works | `qa/auth.spec` |

## FEE · Corrections on the student profile (Phase 2)

| ID | P | Case | Steps | Expected | Automated |
|---|---|---|---|---|---|
| FEE-01 | P1 | Reverse requires a reason | Owner (2FA) → student → Fees → Reverse | Confirm disabled until a reason is typed | `qa/fees.spec` |
| FEE-02 | P1 | Reverse a cash payment | …type reason → Reverse payment | Success message; receipt shown as reversed, not deleted | `qa/fees.spec` |
| FEE-03 | P1 | Waive an invoice balance | Owner → Waive on an unpaid invoice → reason → confirm | Invoice status Waived; waiver line recorded | `qa/fees.spec` |
| FEE-04 | P2 | Record an advance | Owner → Record advance → amount → confirm | Success message | `qa/fees.spec` |
| FEE-05 | P1 | Accountant is offered no correction | Accountant → Fees screen | No Reverse, no Waive anywhere; Students not in menu | `qa/fees.spec` |
| FEE-06 | P1 | Campus admin is offered no reverse/waive | Campus admin → student → Fees card | No Reverse, no Waive | `qa/fees.spec` |

## GUA · Guardians (Phase 3.1)

| ID | P | Case | Steps | Expected | Automated |
|---|---|---|---|---|---|
| GUA-01 | P2 | Add a second guardian | Owner → student → Guardians → + Add guardian → name, phone, relation → save | Listed, marked "not verified — no SMS" | `qa/students.spec` |
| GUA-02 | P1 | Primary cannot be removed | Look at the primary guardian row | No Remove on the primary | `qa/students.spec` |
| GUA-03 | P2 | Make another guardian primary | Make primary on the second guardian | Second now marked primary; first is not | `qa/students.spec` |
| GUA-04 | P2 | Remove a non-primary guardian | Remove on the (now) non-primary | Row disappears | `qa/students.spec` |

## WDR · Withdrawal and certificates (Phase 3.2)

| ID | P | Case | Steps | Expected | Automated |
|---|---|---|---|---|---|
| WDR-01 | P1 | Withdraw a student with no dues | Owner → student without invoices → Withdraw student → leaving date → reason → confirm | Card shows "Left the school"; enrolment withdrawn | `qa/students.spec` |
| WDR-02 | P1 | Owing student: owner may let them leave owing | Owner → owing student → Withdraw | Dues shown first; override option says the balance stays on record (not a waiver) | `qa/students.spec` |
| WDR-03 | P2 | Issue a certificate | Owner → Issue a certificate → type → issue | Appears under Issued with a Download | `qa/students.spec` |
| WDR-04 | P1 | Campus admin cannot override dues | Campus admin → owing student → Withdraw | No "leave owing" override offered | `qa/students.spec` |

## PRO · Year-end promotion (Phase 3.3)

| ID | P | Case | Steps | Expected | Automated |
|---|---|---|---|---|---|
| PRO-01 | P1 | Preview writes nothing | Owner → Year-end promotion → pick next year | Each student listed with an outcome; no enrolment changes | `qa/promotion.spec` |
| PRO-02 | P1 | Commit exactly what was reviewed | Promote → confirm | "Promotion done" with counts; students now in the next class/year | `qa/promotion.spec` |
| PRO-03 | P2 | Running again moves nobody twice | Review the list again | Nothing left to promote or complete; Promote button disabled | `qa/promotion.spec` |
| PRO-04 | P2 | Screen reachable by owner and campus admin only | Accountant menu | No Year-end promotion | `qa/navigation.spec` |

## ACT · Activity log (Phase 4.1)

| ID | P | Case | Steps | Expected | Automated |
|---|---|---|---|---|---|
| ACT-01 | P1 | A correction appears with who and why | After FEE-02 → Activity log | Entry shows actor email, the action in words and the reason | `qa/visibility.spec` |
| ACT-02 | P2 | Filter by action | Type an action → apply | Only that action listed | `qa/visibility.spec` |
| ACT-03 | P1 | Campus admin sees own campus only | Campus admin → Activity log | Scope note shown; no campus-B actor's entries | `qa/visibility.spec` |

## REP · Reports without ids (Phase 4.2)

| ID | P | Case | Steps | Expected | Automated |
|---|---|---|---|---|---|
| REP-01 | P1 | Every report runs from pickers | For each report: choose params → View | Table or "Nothing to report"; no id typed | `owner-gaps.spec` + `qa/visibility.spec` |
| REP-02 | P2 | Required choice blocks View | Fee ledger with no student | View disabled; hint "Choose a student first" | `qa/visibility.spec` |
| REP-03 | P2 | Student search by name | Type 2+ letters of a name | Matching students listed with class | `qa/visibility.spec` |

## DEF · Defaulters (Phase 4.3)

| ID | P | Case | Steps | Expected | Automated |
|---|---|---|---|---|---|
| DEF-01 | P1 | Working list with contact | Owner → Defaulters | Student, guardian, amount owed, overdue days; unverified shows "No SMS — call instead" | `qa/visibility.spec` |
| DEF-02 | P1 | Campus admin sees own campus | Campus admin → Defaulters | Campus-B defaulter absent | `qa/visibility.spec` |
| DEF-03 | P2 | Dashboard chip leads here | Owner dashboard → Defaulters tile | Opens /defaulters | `qa/visibility.spec` |

## CMP · Campus comparison (Phase 4.4) and SET · Setup step 4 (Phase 4.5)

| ID | P | Case | Steps | Expected | Automated |
|---|---|---|---|---|---|
| CMP-01 | P2 | Campuses side by side | Owner → Campus Hub | "How the campuses compare" lists campus A and B with students and collections | `qa/visibility.spec` |
| SET-01 | P2 | Fees are a setup step | Owner → School configuration | Fee setup appears as a step | `qa/visibility.spec` |

## PAY · Cash payroll (Phase 5 + Cash Payroll Plan)

| ID | P | Case | Steps | Expected | Automated |
|---|---|---|---|---|---|
| PAY-01 | P2 | Salary is one amount and a date | Owner → Staff → Salary → Set salary | Only "Monthly salary" and "From"; saved amount shown as current | `qa/payroll.spec` |
| PAY-02 | P1 | Accountant drafts own campus | Accountant A → Payroll → Draft payroll | No campus picker; run for campus A; no Approve button; "waiting for the owner" | `qa/payroll.spec` |
| PAY-03 | P1 | Staff without salary are named | Draft with a staff member lacking salary | "Not in this payroll (no salary set)" names them | `qa/payroll.spec` |
| PAY-04 | P1 | Staff never see a draft | Teacher → My Payslips while draft | Empty state; no draft row | `qa/payroll.spec` |
| PAY-05 | P2 | Discard a draft | Accountant → Discard draft | Run gone from history; can draft again | `qa/payroll.spec` |
| PAY-06 | P1 | Owner approves with 2FA | Owner → open draft → Approve → note → confirm | Approved; dialog states it is final and payslips become visible | `qa/payroll.spec` |
| PAY-07 | P1 | Reminder of salaries to pay | Accountant → notification bell | "N approved salaries not yet paid" linking to Payroll | `qa/payroll.spec` |
| PAY-08 | P1 | Record a cash payment | Accountant → Mark paid → Cash preselected → Record cash payment | Row shows date · Cash · by you; "still to hand over" drops | `qa/payroll.spec` |
| PAY-09 | P1 | Nobody pays themselves | Accountant looks at own row | "Someone else records yours"; no Mark paid | `qa/payroll.spec` |
| PAY-10 | P1 | Owner records the accountant's salary | Owner → accountant row → Mark paid | Paid · by owner | `qa/payroll.spec` |
| PAY-11 | P1 | Teacher sees approved and paid states | Teacher → My Payslips | Month name; "Approved · not paid yet" then "Paid <date>" | `qa/payroll.spec` |
| PAY-12 | P1 | Other campus's accountant cannot see it | Accountant B → Payroll | Campus A run not in history | `qa/payroll.spec` |
| PAY-13 | P1 | Payroll staff can read their own payslips | Accountant A (paid by owner in PAY-10) → My Payslips | Reachable; own payslip listed | `qa/payroll.spec` — **expected to FAIL today (defect QA-D1)** |

## SMS · Broadcast and opt-out (Phase 6.1 + item 9)

| ID | P | Case | Steps | Expected | Automated |
|---|---|---|---|---|---|
| SMS-01 | P1 | Audience is counted before sending | Owner → SMS → message → Check audience | Families, students, credits; reasons for unreached families | `qa/sms.spec` |
| SMS-02 | P1 | Changing the message invalidates the count | After SMS-01 edit the message | Button returns to "Check audience" | `qa/sms.spec` |
| SMS-03 | P1 | Two-step send | Send to N families → "Yes, send now" | Queued message names the count; shows in Sent messages | `qa/sms.spec` |
| SMS-04 | P1 | Opted-out parent is never texted | Worker runs → Sent messages | Opted-out number logged "Parent opted out of SMS"; no Retry on it | `qa/sms.spec` |
| SMS-05 | P1 | Campus admin reaches own campus only | Campus admin → Check audience | No campus picker; count excludes campus B | `qa/sms.spec` |

## NAV · Menus by role

| ID | P | Case | Expected | Automated |
|---|---|---|---|---|
| NAV-01 | P1 | Owner | Payroll, Activity log, Defaulters, Year-end promotion, Campus Hub, SMS present | `qa/navigation.spec` |
| NAV-02 | P1 | Accountant | Payroll, Fees, Defaulters present; no Students, Staff, Activity log, Year-end promotion | `qa/navigation.spec` |
| NAV-03 | P1 | Teacher | No Payroll, Fees in the tab bar; My Payslips under More | `qa/navigation.spec` |
| NAV-04 | P1 | Campus admin | Activity log, Year-end promotion, SMS, Staff; no Payroll, Campus Hub | `qa/navigation.spec` |

---

## Defects

| ID | Severity | Case | Detail | Status |
|---|---|---|---|---|
| **QA-D1** | High | PAY-13 | **My Payslips is only mounted/menued for TEACHER and STAFF.** An accountant (and a campus admin or HR manager) is paid through payroll but cannot open their own payslips — the page renders nothing for them. Found reading NAV while writing PAY cases; confirmed in the browser. | Open |
| **QA-D2** | Low | WDR-01, WDR-02 | **The withdrawal result message disappears before it can be read.** After confirming, the profile reloads as withdrawn and unmounts the dialog, so "Withdrawn. The leaving certificate has been issued…" is visible for a moment or not at all, and Done cannot be pressed. The office is not told whether a fee clearance was issued. | Open |
| **QA-D3** | Medium | WDR-01 | **Certificates card is stale after a withdrawal.** The leaving certificate and fee clearance are issued (API confirms both), but the Certificates card on the same page still says "No certificates issued yet" until the page is reloaded. | Resolved - certificate feature removed 2026-09-19 |
| QA-O1 | Dev only | setup | The dev apps' `/api` proxy (`next.config` rewrites) did not route a `qa…` tenant host and silently fell back to the **demo** school, so a sign-in returned "invalid credentials" with nothing pointing at routing. Production routes at the edge. The suite forwards its own API calls. | Worked around in tests |
| QA-O2 | Low | SMS-04 | A withheld SMS log stores the recipient as typed (`0300…`) while sent ones store `+92…`, so the same parent appears under two spellings in Sent messages. | Open |
| QA-O3 | Info | harness | Two-factor codes are checked against the current 30-second window only, and a used code is not rejected on reuse (confirms decision D11). The harness waits out the last seconds of a window. | Decision D11 |

## Results — 2026-09-17

**Run:** `npx playwright test --project=qa` against the local dev stack at `fd8ee5f` + this suite, SMS worker running. One fresh QA school.
**Outcome:** 49 passed, 2 failed, 0 skipped, 0 flaky (4.3 min). Both failures are the open defects above; no test-harness failures remain.

| Area | Cases | Pass | Fail |
|---|---|---|---|
| World / NAV | 5 | 5 | 0 |
| AUTH | 4 | 4 | 0 |
| FEE | 5 (FEE-01+02 combined) | 5 | 0 |
| GUA | 3 (GUA-02+03 combined) | 3 | 0 |
| WDR | 4 | 3 | 1 — QA-D3 |
| ACT | 2 (ACT-01+02 combined) | 2 | 0 |
| REP | 2 (REP-02+03 combined) | 2 | 0 |
| DEF | 3 | 3 | 0 |
| CMP / SET | 2 | 2 | 0 |
| SMS | 4 (SMS-01+02 combined) | 4 | 0 |
| PAY | 12 | 11 | 1 — QA-D1 |
| PRO | 2 (PRO-02+03 combined) | 2 | 0 |

**Expectations corrected during execution** (the plan was wrong, not the product): NAV-03 — a teacher's personal pages are under **More**, not the sidebar; PRO-03 — promoted students belong to the new year, so a second review lists nobody (button disabled) rather than "Already moved".
