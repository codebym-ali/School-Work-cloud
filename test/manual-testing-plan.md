# Manual Testing Plan — Actor completeness, Access management & Dashboards

Covers everything added in the 2026-07-21 work: recruitment pipeline (status/hire), parent portal,
teacher/staff self-service, admissions & recruitment summaries, consolidated `/access` role grants,
the one-campus-admin rule, the **module-access system**, and all the new/reworked screens
(grouped sidebar, owner dashboard, recruitment & admissions dashboards, parent/teacher/staff portals,
Staff → Manage access drawer, accountant reports).

> Automated coverage already green (backend): matrix-conformance **160+ cases**, `teacher-applications.e2e`
> (pipeline + hire + terminal states), `ownership.e2e` (parent portal isolation), `teaching.e2e` (roster 403),
> `module-access.e2e`, `hr-access.e2e` (via `/access`), `users.e2e` (one-campus-admin 409).
> This plan is the **manual/browser layer** on top of that.

---

## 0. Environment & test accounts

| Item | Value |
|---|---|
| Web | `http://demo.localhost:3001` |
| API | `:4000` (`API_PORT=4000` in `.env`; web proxies via `apps/web/.env.local`) |
| Stack | `docker compose up -d` · `pnpm start:api:dev` · `pnpm start:worker:dev` · `cd apps/web && pnpm dev` |

| Actor | Login | Password |
|---|---|---|
| Owner | `owner@demo.pk` | `Owner!Secret12` |
| Campus admin | `falconschoolgirlscampus@gmail.com` | (owner-reset before use) |
| Accountant | `acc.girls@demo.pk` | `Test!Secret12` (reset 2026-07-21) |
| Admission controller | `admissions-girls@demo.pk` | `Test!Secret12` (reset 2026-07-21) |
| Teacher / Parent / Student | `teacher@demo.pk` / `parent@demo.pk` / `student@demo.pk` | see `scripts/seed-test-users.ts` (reset via owner if login fails — seeded users may predate the current DB) |

Before starting: sign out between actors, or use separate browser profiles/incognito windows per actor.

---

## 1. Sidebar, landing & navigation (all actors)

| # | Actor | Steps | Expected |
|---|---|---|---|
| 1.1 | Owner | Log in | Lands on **/dashboard**; sidebar grouped: Overview / Enrollment / Academics / Finance / People / Administration, all 12 items |
| 1.2 | Campus admin | Log in | Lands on /dashboard; no Fees, no Campus Hub; has Admission Portal item |
| 1.3 | Accountant | Log in | Lands on /dashboard; sees Dashboard, **Reports**, Fees only |
| 1.4 | Admission controller | Log in | Lands on **/admissions**; sidebar shows Admissions only |
| 1.5 | Teacher | Log in | Lands on **/attendance**; sees Attendance, **My Classes**, Exams, My Payslips — **no Dashboard** |
| 1.6 | HR-granted teacher | Grant HR (see §4), re-login | Lands on **/recruitment**; Recruitment + Teachers appear alongside teacher items |
| 1.7 | Parent | Log in | Lands on **/parent**; sidebar = My Children only |
| 1.8 | Student | Log in | Lands on /me; My Portal group (4 items) |
| 1.9 | Any restricted actor | Paste a forbidden URL (e.g. teacher → `/fees`) | "Not authorized" card, no crash |
| 1.10 | All | Check every group header | No empty group headers rendered |

## 2. Owner dashboard (redesigned)

| # | Steps | Expected |
|---|---|---|
| 2.1 | Log in as owner → /dashboard | Greeting + date header; sections: Academics & Enrollment / Finance / Communication / Admissions pipeline / People & Recruitment |
| 2.2 | Inspect "Needs attention" strip | Amber with count when items pending (defaulters, pending leaves, failed SMS, ready-to-admit, tests-today, new applications); green "✓ All clear" otherwise |
| 2.3 | Click an attention chip | Navigates to the right screen showing that exact item |
| 2.4 | Hover any metric tile | Lift + "View →" appears; click navigates (Active students → /students, Collections → /fees, …) |
| 2.5 | Create a submitted teacher application, revisit | "New applications" tile shows count + amber accent; attention chip appears |
| 2.6 | Log in as campus admin → /dashboard | Same page, **no** Admissions-pipeline errors — sections the API denies are absent, page still renders |
| 2.7 | Log in as accountant → /dashboard | Financial metrics only (per `visible`); recruitment/admissions sections hidden |

## 3. Recruitment (HR manager / owner)

| # | Steps | Expected |
|---|---|---|
| 3.1 | /recruitment as owner | KPI row (open vacancies, positions, new applications, shortlisted, new-this-week, hired-this-month) matches DB |
| 3.2 | Post a vacancy (all fields) | Appears in table, OPEN badge; KPIs update after reload |
| 3.3 | Teachers → Add teacher (full form) | Applicant appears in pipeline "New applications" column |
| 3.4 | Shortlist the applicant | Card moves to Shortlisted; toast confirms |
| 3.5 | **Hire** (modal: employee code required) | Success toast "staff login created"; card → Hired; person appears in **Staff** directory as INVITED teacher |
| 3.6 | Try status change / re-hire on the hired card | Buttons gone (Hired column has no actions) |
| 3.7 | Reject a fresh applicant | Card → Rejected; no further actions on it |
| 3.8 | Close the vacancy | Confirm dialog → CLOSED badge; re-close blocked (409 toast if forced via API) |
| 3.9 | As campus admin | Only own campus's vacancies/applications visible |

## 4. Access management — Staff → Manage access (owner only)

| # | Steps | Expected |
|---|---|---|
| 4.1 | /staff as owner → any row → **⚙ Manage access** | Drawer: 4 capabilities (HR Manager, Campus Admin, Accountant, Admission Controller) |
| 4.2 | Grant **HR Manager** to a teacher | "on" badge; **same login** — no new account anywhere; audit row (`HR_ACCESS_GRANTED`) in /reports audit browser |
| 4.3 | Re-login as that teacher | Recruitment now in sidebar and reachable |
| 4.4 | Revoke HR | After re-login: Recruitment gone, /vacancies → 403 |
| 4.5 | Grant **Campus Admin** on a campus that already has one | Error toast: "campus already has a campus admin (email)" — 409 rule holds |
| 4.6 | Grant Campus Admin to a campus-less user | Button disabled "Needs a campus" |
| 4.7 | As campus admin, open /staff | **No** Manage-access button (owner-only) |

## 5. Module toggles (fine-grained access)

| # | Steps | Expected |
|---|---|---|
| 5.1 | Grant HR to a teacher → drawer shows 3 nested modules (Vacancies, Applications, Hiring), all **On** | Default all-on |
| 5.2 | Switch **Hiring → Off**; re-login as that teacher → /recruitment | Shortlist/Reject visible, **Hire button gone** |
| 5.3 | Same user, force the API: `POST /teacher-applications/:id/hire` | **403** "module is switched off" (UI hiding is cosmetic; backend enforces) |
| 5.4 | Switch Hiring back **On**; teacher re-login | Hire button back; hire succeeds |
| 5.5 | Switch **Applications → Off** | Pipeline actions hidden; PATCH status via API → 403 |
| 5.6 | Owner's own view | Owner sees every action regardless of any toggles (owner bypass) |
| 5.7 | Admission controller: owner toggles **Admit students → Off** | Controller sees inquiry actions but **Admit** hidden; POST /admissions → 403 |
| 5.8 | Accountant: toggle **Payments → Off** | Collect button gone on /fees; invoicing still works |
| 5.9 | `/auth/me` for a restricted user | `modules[]` excludes the switched-off keys |

## 6. Admissions dashboard (admission controller / owner)

| # | Steps | Expected |
|---|---|---|
| 6.1 | /admissions | KPI row (open, tests today, ready to admit, admitted-this-month, conversion %) + funnel chips with zero-filled counts |
| 6.2 | Click a funnel chip (e.g. ENTRY_TEST_PASSED) | Table filters to that status; chip highlights |
| 6.3 | Full journey: new inquiry → schedule test → record pass → admit (form pre-filled) | Status walks the state machine; admitted student appears in /students; KPIs/funnel update |
| 6.4 | As admission controller (campus-bound) | Sees only own campus's pipeline; summary numbers match their campus |

## 7. Parent portal

| # | Steps | Expected |
|---|---|---|
| 7.1 | Log in as parent | /parent — one card per child: class/section, attendance %, outstanding Rs |
| 7.2 | Child card → Overview / Attendance / Results / Fees tabs | Each renders the child's real data; tab chips highlight current |
| 7.3 | Tamper: paste another family's studentId in the URL | 403-driven error state ("Couldn't load"), **no data leak** |
| 7.4 | Parent with no linked children | Friendly empty state, no crash |

## 8. Teacher & staff self-service

| # | Steps | Expected |
|---|---|---|
| 8.1 | Teacher → /my-classes | Assigned sections with live student counts; subject + class-teacher badges |
| 8.2 | View roster | Students sorted by roll number; Attendance/Marks links work |
| 8.3 | Tamper: roster URL for an unassigned section | Error state (403), no data |
| 8.4 | Staff → /my-attendance | Own records + % tile only |
| 8.5 | /my-payslips (teacher or staff) | Own payslips; PDF opens presigned link (or clean error if none) |

## 9. Accountant

| # | Steps | Expected |
|---|---|---|
| 9.1 | /reports as accountant | Dropdown shows **only** Daily collection, Defaulters, Fee ledger; default is financial |
| 9.2 | Run daily-collection + CSV download | 200, rows/CSV correct |
| 9.3 | /reports as owner | All seven reports |
| 9.4 | /fees as accountant | Generate + Collect both work (modules on) |

## 10. Regression sweep (unchanged areas)

- [ ] Students CRUD + CSV import unchanged
- [ ] Exams: marks entry → publish → report cards unchanged
- [ ] Attendance marking (teacher) unchanged
- [ ] Campus Hub user management unchanged; `POST /users` still creates fresh logins (new people only)
- [ ] Student portal /me/* unchanged
- [ ] `pnpm test` green (run with **no stray worker** — a running `start:worker:dev` steals SMS-queue jobs and flakes 2 attendance/exams specs)
- [ ] `pnpm lint && pnpm build` + web `tsc --noEmit` green

---

## Suggested Playwright additions (automate later)
1. `access.spec.ts` — owner grants HR → toggles Hiring off → teacher sees no Hire button (UI mirror of module-access.e2e)
2. `recruitment-pipeline.spec.ts` — vacancy → applicant → shortlist → hire → staff row appears
3. `parent.spec.ts` — parent login → child card → 4 tabs render
4. `owner-dashboard.spec.ts` — attention chip navigates to the matching screen
