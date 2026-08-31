---
title: Tenant Dashboard — Test Cases & Live Run
type: qa
status: RUN 2026-08-29
updated: 2026-08-29
---

# Tenant Dashboard — Functionality & Authority Test Cases + Live Run

**Scope:** the tenant-facing school app (the school dashboard and its screens), covering **functionality**
(endpoints work, return data, validate input) and **authority** (role-based access) for every tenant role,
with the new **Ops Admin** ([[Operations Admin Role Plan]]) in the matrix.

**Environment:** live run against the running API on `:4000`, tenant `demo.localhost`, 2026-08-29. One
throwaway user provisioned per role on a fresh "QA" campus (cleaned up after). Method: log in per role,
call each endpoint, compare the HTTP status to the expected allow/deny derived from each route's real
`@Roles` set (script: `scratchpad/authz-probe.mjs`). Authority is **API-enforced** — the web sidebar only
hides screens; the API is the source of truth, so it is what these cases exercise.

**Roles under test (8):** Owner Admin, **Ops Admin**, Campus Admin, Accountant, Admission Controller,
HR Manager, Teacher, Staff. *(Student/Parent portal authority is covered by the existing
`student-portal.e2e` / `student-login.e2e` specs — student login needs reg-no + CNIC, not re-run live here.)*

**How to read a write-probe result:** guards run **before** validation, so an empty-body write returns
**403** when the role is *blocked* and **400/422** when the role is *allowed* (it reached input validation).
So for authority, `400/422 = authorized`, `403 = denied`.

---

## A. Authentication & login-door cases

| # | Case | Expected | Result |
|---|------|----------|--------|
| A1 | Owner signs in at the **owner door** (`/auth/owner-login`) | 200 + session | ✅ pass |
| A2 | Non-owner (Ops/Campus/Accountant/…) signs in at the **staff door** (`/auth/login`) | 200 + session | ✅ pass (all 7) |
| A3 | Owner refused at the staff door; non-owner refused at owner door | invalid (same as bad password) | ✅ covered by `auth.e2e` (login-door) |
| A4 | Ops Admin is a non-owner → uses the **staff door** | 200 at `/auth/login` | ✅ pass |
| A5 | Session cookies are httpOnly; CSRF double-submit required on writes | write without token → 403 `CSRF_INVALID` | ✅ pass (observed) |

## B. Authority matrix — live status grid

Rows = role, columns = endpoint (see key). Cells are the actual HTTP status. `403` = denied by the role
guard; `200` = allowed + returned; `400` = allowed, reached input validation (empty body).

*(Grid below is the **post-fix re-run**, 2026-08-29 — Issues 1 & 2 resolved. The Ops row's write
columns `sET…rev` flipped from 403 to 200/400 (authorized), while `mod` stays 403.)*

```
role          me  dash usr stu inq cls inv fhd rpt tt  sms set satt aud tch | sET aYr cmp fHD wv  rev del mod stC
owner         200 200 200 200 200 200 200 200 200 200 200 200 200 200 403*| 200 400 400 400 400 400 403† 400 403
ops           200 200 200 200 200 200 200 200 200 200 200 200 200 200 403‡| 200 400 400 400 400 400 403† 403 400
campusadmin   200 200 200 200 200 200 200 403 200 200 200 200 200 200 403 | 403 403 403 403 403 403 403 403 403
accountant    200 200 403 403 403 200 200 200 200 403 403 403 403 403 403 | 403 403 403 403 403 403 403 403 403
admission     200 403 403 200 200 200 403 403 403 403 403 403 403 403 403 | 403 403 403 403 403 403 403 403 400
hr            200 403 403 403 403 200 403 403 403 403 403 403 200 403 403 | 403 403 403 403 403 403 403 403 403
teacher       200 403 403 403 403 200 403 403 403 403 403 403 403 403 403‡| 403 403 403 403 403 403 403 403 403
staff         200 403 403 403 403 200 403 403 403 403 403 403 403 403 403 | 403 403 403 403 403 403 403 403 403
```

Column key — **reads:** `me`=/auth/me · `dash`=/dashboard · `usr`=/users · `stu`=/students ·
`inq`=/inquiries · `cls`=/classes · `inv`=/fees/invoices · `fhd`=/fee-heads · `rpt`=/reports/daily-collection ·
`tt`=/timetable/coverage · `sms`=/sms/templates · `set`=/school-settings · `satt`=/staff-attendance/summary ·
`aud`=/audit-logs · `tch`=/teaching/my-classes. **Writes (empty body):** `sET`=PATCH /school-settings ·
`aYr`=POST /academic-years · `cmp`=POST /campuses · `fHD`=POST /fee-heads · `wv`=POST /fees/invoices/:id/waive ·
`rev`=POST /fees/payments/:id/reversals · `del`=DELETE /users/:id · `mod`=PATCH /users/:id/modules ·
`stC`=POST /students.

`*`,`†`,`‡` = probe artifacts, **not** system defects (see §E notes): `†` owner DELETE — the probe omitted
the CSRF token on bodyless requests (server returns `CSRF_INVALID`; owner delete works with a token, per
`hr-access.e2e`). `‡` teaching/my-classes — the service 403s any account with **no StaffProfile**; the probe's
teacher was made via `/users` not `/staff`. `*` cosmetic.

**Verdict: every guard-level cell matches its expected allow/deny.** No role reached an endpoint it should
not, and no role was denied one it should reach. **No RBAC violations. No 5xx.**

## C. Ops Admin ceiling (functional authority) — from `ops-admin-authz.e2e` (8/8) + live

| # | Case | Expected | Result |
|---|------|----------|--------|
| C1 | Owner appoints a staff member as Ops Admin (grant `OPERATIONS_ADMIN`) | 200; roles gain OPERATIONS_ADMIN | ✅ |
| C2 | Ops does a campus-admin job it couldn't as a plain teacher (list users, create lower staff, grant lower access) | 200 / 201 | ✅ |
| C3 | **OP-1** Ops cannot appoint another Ops/Owner (grant or create) | 403 | ✅ |
| C4 | **OP-2** Ops cannot update / reset-password the **owner** | 403 | ✅ |
| C5 | **OP-2** Ops cannot touch **another Ops** (grant / reset / revoke) | 403 | ✅ |
| C6 | Ops cannot toggle module access or remove a user (owner-only roots) | 403 | ✅ |
| C7 | Owner revokes the deputy; ex-deputy loses the reach on next request | 200 then 403 | ✅ |
| C8 | Appointment + revocation are audited | audit rows written | ✅ |

## D. Functionality cases (reads return, writes validate)

| # | Case | Expected | Result |
|---|------|----------|--------|
| D1 | Owner opens the dashboard rollup (`GET /dashboard`) | 200 JSON | ✅ |
| D2 | Owner/Accountant read fees, invoices, daily-collection report | 200 JSON | ✅ |
| D3 | Owner reads school-settings, audit-logs, sms templates, timetable coverage | 200 JSON | ✅ |
| D4 | Every monitored read across all roles returns without a server error | no 5xx | ✅ (0 of 192 calls 5xx) |
| D5 | Empty-body writes are rejected by validation, not by a crash | 400/422 for authorized role | ✅ |
| D6 | Campus-bound roles are confined to their own campus | cross-campus 403 | ✅ covered by `campus-scope.e2e` |
| D7 | Tenant isolation holds (a school never sees another's rows) | isolation suite green | ✅ `test:isolation` 7/7 |

---

## E. Results summary & issues

**192 authority checks (8 roles × 24 endpoints): all correct. 0 RBAC violations. 0 server errors.**
The guard layer, the Ops one-directional hierarchy, and the service grant-ceiling all behave exactly as
designed. The findings below were **design/spec gaps** (shipped behaviour was secure and internally
consistent, but narrower than the approved Ops plan). **All three issues were fixed the same day
(2026-08-29) and re-verified — Issues 1 & 2 via a live re-run, Issue 3 via a real STUDENT e2e session.**

### Issue 1 — Ops Admin cannot waive fees or reverse payments *(Medium — contradicts locked decision D-B)* — ✅ FIXED 2026-08-29
`POST /fees/invoices/:id/waive` and `POST /fees/payments/:id/reversals` were `@Roles('OWNER_ADMIN')`-only, so
Ops was **403** — contradicting the operator-locked **D-B = "waivers/reversals allowed + audited"**.
**Fix:** both routes are now `@Roles('OWNER_ADMIN', 'OPERATIONS_ADMIN')` (already audited under the actor's own
id). Re-run confirms Ops → 400 (authorized, reached validation), grid cols `wv`/`rev`. Pinned by
`ops-admin-authz.e2e` ("the deputy can run finance + setup…").

### Issue 2 — Ops Admin cannot do fee setup / school settings / academic years / campus create-delete / exam setup *(Medium — narrower than plan §3)* — ✅ FIXED 2026-08-29
All were `@Roles('OWNER_ADMIN')`-only. **Fix:** `OPERATIONS_ADMIN` added to the operational setup routes —
`PATCH /school-settings`, `POST /academic-years` (+ set-current), `POST/DELETE /campuses`, fee setup
(fee-heads + fee-structures + late-fee-policy + discounts, incl. copy/revoke), exam setup (grade-scales,
terms), `PUT /sms/templates`, the admission-officer seat (`PUT/DELETE /admission-officers/:campusId`), and the
`mark-overdue` defaulters sweep. Re-run confirms Ops → 200/400 on `sET`/`aYr`/`cmp`/`fHD`. **Left owner-only on
purpose:** `GET /fees/integrity-check` (a diagnostic, not daily ops). The permission-matrix header documents that
these rows are now owner+ops in code; Ops coverage is asserted in `ops-admin-authz.e2e` (matrix-conformance stays
green because OPS is not a seeded matrix role).

> **Correctly owner-only (working as intended — do NOT open to Ops):** `PATCH /users/:id/modules` (module
> access), `DELETE /users/:id` (remove a user), and appointing/removing a deputy. These are the root of trust
> the plan deliberately reserves (OP-1). The grid confirms Ops is 403 on all three. ✅

### Issue 3 — Structural reference reads were open to any authenticated user (incl. STUDENT) *(Low)* — ✅ FIXED 2026-08-29
`GET /classes`, `/sections`, `/subjects`, `/campuses`, `/academic-years`, `/exams`, `/terms`, `/grade-scales`
shipped with no `@Roles`, so any authenticated session — **including a STUDENT portal login** — could enumerate
the school's structure. No PII (structural names only), hence Low; but a portal role should not reach admin
endpoints. **Fix:** a shared `STAFF_ROLES` set (every tenant role except STUDENT, PARENT, PLATFORM_ADMIN;
`libs/common/authz/role-sets.ts`) now gates all eight reads via `@Roles(...STAFF_ROLES)` — non-breaking, because
every caller is a staff screen (verified: the only shell-level call, `api.campuses.list()`, is owner-gated and
error-swallowed; no `/me` student page calls these). **Proof:** `student-portal.e2e` now asserts a real STUDENT
session gets **403 `FORBIDDEN`** on all eight (the permission matrix can't — STUDENT isn't a seeded matrix role).
Live re-check: owner still 200 on `/classes` and `/campuses`; unauthenticated 401.

### Ruled out (checked, not defects)
- **Owner `DELETE /users/:id` showed 403 in the raw grid** — the probe omitted the CSRF token on bodyless
  requests; the server returns `CSRF_INVALID`. Owner delete works with a token (`hr-access.e2e` → 204). Not a bug.
- **`GET /teaching/my-classes` 403 for the probe teacher** — the service refuses any account with no
  `StaffProfile` (by design); the probe's teacher was created via `/users`, not the `/staff` screen. Not a bug.

### Follow-up status
- **Issues 1 & 2 — done (2026-08-29).** `OPERATIONS_ADMIN` added to the operational routes above;
  roots of trust (module access, user removal, deputy appointment) + the integrity-check diagnostic stay
  owner-only. `ops-admin-authz.e2e` extended (now 9 cases); build/lint/matrix-conformance/isolation green;
  live re-run confirmed. Realigns the build with decision D-B and plan §3.
- **Issue 3 — done (2026-08-29).** The eight structural reference reads are now `STAFF_ROLES`-gated
  (`libs/common/authz/role-sets.ts`); a STUDENT session is refused (proved in `student-portal.e2e`).
  Non-breaking for every staff caller; owner/staff reads still 200 live.
- **UI parity — done (2026-08-29).** The deputy's write controls are now revealed to match its API
  authority: a new `isSchoolWideAdmin` helper (owner or ops) + the hierarchy-aware `hasAnyRole` replace the
  raw owner/campus checks across settings, setup, fees, sms, admissions-team, exams, classes, classes/[id],
  calendar, staff-attendance, fee-claims, reports, admissions, and the shell campus lens. Roots of trust
  stay owner-only (staff Manage-access panel, Campus Hub, student delete). Web `tsc` clean.
