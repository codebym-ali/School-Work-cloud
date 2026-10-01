# Campus Ops Admin & Read-only Owner — Plan (2026-09-30)

> Status: **PLAN ONLY — no code changed for this.** Awaiting the decisions in §7.
> Note: the earlier same-day change that hid money from Ops Admin (`insights.service.ts` `hidesMoney()`) contradicts this model
> and is to be **reverted** in phase 1.

## 1. Intent (owner's words, restated)
- **Owner Admin = watch only.** Dashboard, reports, audit — across every campus. No day-to-day tasks.
- **Ops Admin = the doer, one per campus.** Performs everything the owner can do today, **for their own campus only**.
- **Every portal says which campus the person belongs to** (Ops Admin, teacher, accountant, student, guardian).

## 2. What exists today (verified in code)
| Fact | Where |
|---|---|
| `OPERATIONS_ADMIN` is a **school-wide deputy**: expands to CAMPUS_ADMIN/ADMISSION/HR/ACCOUNTANT/TEACHER/STAFF, bypasses campus scope | `packages/roles/src/index.ts` (`OPERATIONS_ADMIN_COVERS`), Key Decisions L756 |
| `CAMPUS_ADMIN` is the **per-campus** role, one seat per campus, bound to a `campusId`, scoped by `restrictedCampusId()` | `users.service.ts` seat roles |
| Owner passes almost every `@Roles(...)`: 224 `OWNER_ADMIN` mentions in 42 API files | `apps/api/src/modules` |
| Campus-scoped services already exist (~27 files use `restrictedCampusId`/`effectiveCampusFilter`) | api |
| Users list already returns `campusName`; no campus chip in the portal shells | `users.service.ts`, shells |

**Root mismatch:** the "per-campus doer" is `CAMPUS_ADMIN`, the "Ops Admin" label belongs to a school-wide role. Two roles overlap and neither matches the model.

## 3. Target design
### 3.1 Roles
- **OWNER_ADMIN** — read-only + a small set of owner-only governance actions (see §3.3).
- **OPERATIONS_ADMIN ("Ops Admin")** — **campus-bound**: `campusId` mandatory, exactly one per campus (seat role), scoped with `restrictedCampusId`. Covers everything CAMPUS_ADMIN/ACCOUNTANT/HR/ADMISSION cover, **including fees and money** for that campus.
- **CAMPUS_ADMIN** — retired as a separate concept: migrate existing holders to OPERATIONS_ADMIN (same campus), keep the enum value as a backward-compatible alias until the migration is verified.
- Teacher / accountant / staff / admission officer remain per-campus as today.

### 3.2 Backend — one enforcement point, not 224 edits
1. **Campus binding:** OPERATIONS_ADMIN removed from the school-wide bypass list; `restrictedCampusId()` returns the user's campus for them; user create/update refuses a null campus for this role; seat uniqueness (like CAMPUS_ADMIN).
2. **Owner read-only guard** (global, after auth): if the caller's *granted* roles contain OWNER_ADMIN and none of the operating roles, reject `POST/PUT/PATCH/DELETE` with `403 OWNER_READ_ONLY`, except an **allowlist** (`owner-writable.ts`). Explicit allowlist = safe default; new write routes are blocked for owner unless listed.
3. Matrix/coverage tests: extend `permission-matrix.ts` with an owner-write column; a test that fails if a write route is neither owner-blocked nor allowlisted.
4. Dashboard/insights: Ops Admin gets **campus-scoped** numbers including money; owner gets school-wide, campus-filterable numbers (existing campus lens).
5. Every write by Ops Admin audited with campus (audit already exists).

### 3.3 Owner-writable allowlist (proposal — needs your confirmation, §7)
Appointing/removing Ops Admins, creating/closing campuses, school-level settings, module access, MFA/own profile, read-only exports. Everything operational (admit, record payment, mark attendance, payroll drafting, notices) → Ops Admin only.

### 3.4 Frontend
- **Owner nav/pages:** action buttons hidden when `isOwnerReadOnly`; pages keep data, charts, drill-downs. Owner "Campus Hub" shows each campus, its Ops Admin, and health (attendance %, collections, defaulters) — with an "Appoint Ops Admin" action (the one write).
- **Ops Admin portal:** campus pinned, no campus switcher; all existing operational pages.
- **Campus identity everywhere:** a `CampusBadge` in each shell header ("Edify · Gulberg Campus") fed by session (`campusName`), for staff, teacher, student and guardian; the owner sees "All campuses" + lens.
- Reuse existing campus-lens work; no new filtering logic.

## 4. Phases
| # | Phase | Output | Gate |
|---|---|---|---|
| 1 | Revert `hidesMoney`; make OPERATIONS_ADMIN campus-bound (role logic, seat rule, scoping, login door) | Ops Admin sees only own campus incl. money | isolation + campus-scope e2e green |
| 2 | Migrate CAMPUS_ADMIN → OPERATIONS_ADMIN (SQL migration + seed: one Ops Admin per campus) | one doer per campus | seed + RLS check |
| 3 | Owner read-only guard + allowlist + matrix tests | owner can't write | new guard spec; route coverage |
| 4 | Owner UI read-only (hide actions, Campus Hub "Appoint Ops Admin") | view-only owner portal | live check |
| 5 | `CampusBadge` in all five shells + session `campusName` | campus visible on every portal | live check each role |
| 6 | Brain update, Playwright for owner-blocked / ops-scoped / badge | done | full quality gates |

## 5. Pakistani-school operations notes
- A campus principal/administrator normally handles admissions, fees, and staff day to day; owners review reports and approve exceptions. Hence the **approval question** (§7-2): fee waivers and payroll are the usual owner sign-offs.
- Multi-campus schools commonly keep a **separate fee account per campus**; our per-campus Ops Admin + campus-scoped collections supports that.
- MFA stays mandatory for Ops Admin and accountants (money handlers).

## 6. Risks
- Migration of existing CAMPUS_ADMIN users and all `@Roles('CAMPUS_ADMIN')` / UI `hiddenFor` rules — mitigated by keeping CAMPUS_ADMIN as an alias until verified.
- Owner could be locked out of something they need — mitigated by the allowlist being editable in one file and a clear `OWNER_READ_ONLY` message.
- Owner currently has no MFA enrolled, and MFA-gated owner actions (user appoint) already 403 — appointment flow needs MFA enrolment first.

## 7a. Decisions received (2026-09-30) — these supersede the recommendations in §3/§7 where they differ
1. **Do NOT merge CAMPUS_ADMIN into OPERATIONS_ADMIN.** Both roles stay. One person may hold **several roles** (already supported: `User.roles[]`), e.g. Ops Admin + Accountant. Drop "migrate CAMPUS_ADMIN" (old phase 2).
2. **Owner approves fee vouchers.** No approval step exists today (verified: invoices are generated/waived directly; only waive/reverse exist). Needs a new approval flow — scope pending, see open questions below.
3. **Remove the school-wide Ops Admin.** Ops Admin becomes campus-bound (campusId required, one per campus), no school-wide bypass.
4. **Ops Admin cannot see other campuses' numbers.**

### FINAL decisions (answers to the open questions below)
- **Voucher approval = monthly voucher batch.** Generated vouchers for a campus sit in `PENDING_APPROVAL` until the owner approves; only then are they issued/SMS'd to parents.
- **Ops Admin = campus head, above Campus Admin.** Ops Admin does everything in the campus incl. fees, staff, settings. Campus Admin stays the principal-level academic/admin seat **without money access**. A person can hold both (multi-role).
- **School-wide setup: Ops Admin proposes, owner approves** (fee heads/structures, grade scale, terms, school settings).

### Resulting design delta (replaces phases 2–4 of §4)
One generic **Approval Request** module serves both flows: `ApprovalRequest { id, schoolId, campusId, type (VOUCHER_BATCH | SETUP_CHANGE), payload (JSON), status PENDING|APPROVED|REJECTED, requestedBy, decidedBy, decidedAt, reason }`, tenant table + RLS + isolation test.
- **VOUCHER_BATCH:** invoice generation writes invoices as `PENDING_APPROVAL` + an ApprovalRequest; owner approves → invoices become ISSUED and the SMS/parent-visible step fires; reject → invoices voided with reason. Parent/student portals never show pending vouchers.
- **SETUP_CHANGE:** Ops Admin's school-wide setup writes become a *proposal* (payload = the intended call); owner approve → the service applies it. Campus-level setup (sections, timings of own campus) applies directly.
- **Owner read-only guard:** allowlist = approve/reject requests, appoint/remove Ops Admin, campus create/close, module access, own profile/MFA.
- **Owner inbox:** "Approvals" page + dashboard "Needs your attention" card (pending vouchers/proposals per campus) — the owner's only action surface.
- **Money split:** `/fees`, payroll, payments → Ops Admin + Accountant only; Campus Admin loses them (`hiddenFor`/`@Roles` change), revert `hidesMoney` for Ops Admin (money is campus-scoped instead).

### Phases (final)
1. Ops Admin campus-bound + remove school-wide bypass (`campus-scope.ts`, `role-hierarchy`, `users.service` seat rule, `isAdminRole`, login/seed: one Ops Admin per campus, retire school-wide `ops@demo.pk`), revert `hidesMoney`.
2. Campus Admin money removal + multi-role UI check.
3. Approval Request module (schema, migration, RLS, service, controller, matrix rows, isolation test).
4. Voucher batch approval (invoicing state + owner approve/reject + portal hiding).
5. Setup-change proposals.
6. Owner read-only guard + allowlist + owner Approvals page/dashboard card.
7. `CampusBadge` in all five shells.
8. Tests (unit, integration, isolation, Playwright), brain Progress Tracker + Key Decisions.

### Open questions raised by these answers (now answered above)
- Which "fee voucher" does the owner approve: monthly invoice batch, individual waivers/discounts, or both?
- What separates Ops Admin from Campus Admin inside one campus, if neither is merged?
- School-wide setup today gated `@Roles('OWNER_ADMIN','OPERATIONS_ADMIN')` (fee heads/structures, grade scale, terms, school settings) — with a campus-bound Ops Admin and a read-only owner, who edits these?

## 7. Decisions needed before building (original list, kept for history)
1. **Merge roles?** Recommended: Ops Admin = the one campus role; CAMPUS_ADMIN migrated into it. Alternative: keep both (Ops Admin = deputy inside a campus above the principal).
2. **Does the owner still approve anything** (fee waivers, payroll approval, fee-clearance override)? Recommended: keep these as owner-only *approvals*, since they are oversight, not daily work.
3. **Should the school-wide deputy (today's Ops Admin, ops@demo.pk) survive?** Recommended: no — one Ops Admin per campus; the owner is the only school-wide view.
4. Can an Ops Admin see **other campuses' numbers** (read-only comparison)? Recommended: no.
