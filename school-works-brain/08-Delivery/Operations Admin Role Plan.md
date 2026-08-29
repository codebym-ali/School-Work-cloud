---
title: Operations Admin Role Plan
type: plan
status: PLANNED — not built
updated: 2026-08-29
---

# Operations Admin Role Plan — the owner's operational deputy

**Raised by the operator (2026-08-29):** *"Owner admin should not have this much time to perform tasks.
The owner should be able to give access to an ops role — a person he chooses from staff/teachers — who
performs tasks on the owner's behalf."* Plan the ideal design for this role.

**Status:** 📋 **PLANNED — not built.** This document is the design; implementation is a follow-on
(phases in §7). Companion context: [[Owner Login Plan]] (the owner door), [[Finance Roles Plan]]
(segregation of duties), [[Multi-Tenancy & Isolation]], [[Key Decisions]].

---

## 1. The problem, in one line
The **Owner Admin** today is the single all-powerful account for a school and is expected to *do*
everything. Owners are busy and want to **delegate the day-to-day running** to a trusted person —
**without handing over ultimate control** or creating a second owner they can't rein back in.

## 2. Decision — a new school-wide role: `OPERATIONS_ADMIN`
Introduce **Operations Admin** — a near-owner **operational deputy** the owner **appoints** (and can
**revoke** at will). It runs everything operational across the whole school; the owner keeps a small,
deliberate set of *root* powers so they remain the single ultimate authority.

> **Why a new role, not "make them a second owner"?** A blanket clone of `OWNER_ADMIN` is a second
> root account — if it could appoint/dismiss owners it could **lock the real owner out**. A distinct
> role with a defined ceiling keeps the owner as the **single root of trust** (the same principle the
> vendor side already uses to protect the last super-admin). And a delegate acting under **their own
> login** gives a truthful audit trail — *better* accountability than an "act as the owner" mode where
> every action looks like the owner's.

> **Why not just stack existing seats?** The owner *can* already delegate slices (Campus Admin,
> Accountant, Admission Officer — see Campus Hub). But there is no single "run the whole school for me"
> grant. This role is exactly that: one appointment, broad default, walk away.

## 3. The boundary — what the Operations Admin CAN and CANNOT do
### ✅ CAN (broad operational default — the point is to offload the owner)
- **Academics & enrolment:** students, admissions oversight, classes/sections/subjects, timetable, campuses.
- **Teaching ops:** attendance oversight, cover, exams & results, report cards.
- **Finance:** fee setup, invoicing, collect payments/receipts, discounts, defaulters, **and** waivers /
  reversals *(audited — see decision D-B in §9)*.
- **People:** manage staff; **grant any role BELOW Operations Admin** (Teacher, Accountant, Campus Admin,
  Admission Officer, HR) so they can actually staff the school; approve leaves; run payroll *(approval
  gate — see D-C in §9)*.
- **Comms & config:** SMS, school settings, calendar, reports.

### 🚫 CANNOT (owner-reserved — the root of trust)
- **Appoint or dismiss an Operations Admin, or any Owner** — only the Owner manages their own deputies.
- **Touch the Owner's own account** (reset/remove/demote the owner).
- **Vendor-side actions** (billing, plan, subdomain, school export/deletion) — already unavailable to
  *any* tenant user; unchanged.
- *(Optional, operator's call — see §9)* bulk fee-waive / payment-reversal above a threshold, and/or
  payroll **approval**, may be kept owner-reserved.

## 4. Security invariants (the rules the build must hold)
- **OP-1 — Owner is the single root.** Only `OWNER_ADMIN` may grant or revoke `OPERATIONS_ADMIN`.
- **OP-2 — Hierarchy rule for grants.** A grantor may only assign roles **strictly below** their own
  level. So an Operations Admin can appoint teachers/accountants/campus-admins but **never** another
  Operations Admin or an Owner. (Formalises "you can't mint your own equal or your boss.")
- **OP-3 — Acts as themselves.** The delegate uses their **own** login; every write is audited under
  their user id in `audit_logs` — never disguised as the owner.
- **OP-4 — Instantly revocable.** Revocation takes effect on the delegate's **next request** (the guards
  re-check roles live, as they already do for suspends).
- **OP-5 — MFA mandatory.** Add `OPERATIONS_ADMIN` to `MANDATORY_MFA_ROLES` (currently `OWNER_ADMIN`,
  `ACCOUNTANT`) — a near-owner account must have 2FA.
- **OP-6 — Isolation untouched.** It's a normal tenant user: RLS-scoped to its one school, no BYPASSRLS,
  never crosses tenants.
- **OP-7 — Don't offer what they can't do.** Reserved controls (appoint-deputy, owner account) are
  **hidden** from the Operations Admin UI, not shown-then-403'd.

## 5. Data model
- **Add `OPERATIONS_ADMIN` to the `Role` enum** (Prisma migration — an enum value add; no data
  migration, no backfill). Sits between `OWNER_ADMIN` and `CAMPUS_ADMIN` in the hierarchy.
- Stored in the existing **`User.roles[]`** array like every other role; **school-wide** (not
  campus-tied), exactly like `OWNER_ADMIN`.
- **No new table.** Appointment/revocation is recorded in the existing tenant `audit_logs`
  (`OPS_ADMIN_APPOINT` / `OPS_ADMIN_REVOKE`). *(A dedicated `role_grants` audit table is a possible
  future nicety, not needed for v1.)*

## 6. How it fits the existing system (the build surface)
1. **`ROLE_INFO` (web `lib/roles.ts`):** add `OPERATIONS_ADMIN` → `landing: '/dashboard'`, label
   *"Operations Admin"*, uses the **admin shell** (not the teacher shell). It appears in `primaryRole`
   just under Owner.
2. **Authz sweep (the main work):** everywhere a route allows `OWNER_ADMIN` for an *operational* action,
   also allow `OPERATIONS_ADMIN` — **except** the reserved set (§3). The **permission matrix**
   (`test/matrix` / `permission-matrix.ts`) is the checklist: every route gets an `OPERATIONS_ADMIN`
   row — allowed → 2xx, reserved → 403 — so the ceiling is *proven*, not assumed.
3. **Grant-hierarchy enforcement:** the role-assignment service (Campus Hub / staff access) enforces
   **OP-1 + OP-2** server-side: reject any attempt to grant `OPERATIONS_ADMIN`/`OWNER_ADMIN` by a
   non-owner, and any attempt to grant a role ≥ the grantor's level.
4. **MFA:** add to `MANDATORY_MFA_ROLES` (OP-5).
5. **Login door:** the Operations Admin is a staff member → signs in at **`/staff-login`**. The
   `/owner-login` door stays owner-only (it already refuses non-owners, byte-identically).
6. **Nav:** the delegate sees the **owner navigation minus the reserved items** — driven by the existing
   role-per-nav-item gating (`isUsable`), so no separate shell is built.

## 7. UI/UX design
### Appointing (the owner's flow)
- On **Campus Hub → "School-wide"** (where the Owner already sits, above the campuses), add an
  **"Operations Admins"** block with **"+ Appoint operations admin"**:
  - **Pick an existing staff member** (dropdown of current staff), *or* **add a new person** (name +
    email → a **one-time onboarding link**, **no password typed** — mirrors SA2 provisioning / SA4b
    operator invite, the house pattern).
  - A one-line explainer: *"An Operations Admin runs the school day-to-day on your behalf — everything
    you can do except appointing another operations admin or changing your owner account. Revoke any
    time."*
  - Appointed people are listed with their status and a **"Revoke"** button.
- *(Alternative placement to weigh in §9: a dedicated **"Team & access"** screen under Administration
  that unifies role grants — cleaner long-term, more build.)*

### The delegate's experience
- Signs in at `/staff-login` → lands on **`/dashboard`** (the owner-style dashboard).
- Sees the **full owner nav minus reserved items**; a subtle top banner: *"Operations Admin — acting for
  {School}. Your actions are recorded under your name."*
- Reserved controls are simply **absent** (OP-7).

### Revocation
- Owner clicks **Revoke** → the person drops to their base role (e.g. back to Teacher) or loses elevated
  access; effective on their next request (OP-4); audited.

## 8. Phased rollout
- **Phase 1 — the role + guardrails (core):** enum value, `ROLE_INFO`, the authz sweep + matrix rows,
  grant-hierarchy enforcement (OP-1/OP-2), MFA (OP-5). Ships even with no dedicated appoint UI (grantable
  via the existing staff/campus role UI once the hierarchy rule is in).
- **Phase 2 — the appoint UX:** the Campus Hub "Operations Admins" block + onboarding-link invite +
  delegate banner + Revoke.
- **Phase 3 — optional guards & visibility:** owner-reserved finance threshold (D-B) / payroll-approval
  reservation (D-C); a small "delegation activity" view for the owner (recent actions by their deputy,
  read from the audit log).

## 9. Open decisions (need the operator's call)
- **D-A — Name/label.** *Operations Admin* (proposed) vs *School Manager* / *Principal* / *Administrator*.
  (Enum can stay `OPERATIONS_ADMIN` regardless of the display label.)
- **D-B — Finance ceiling.** Are **bulk fee-waives / payment reversals** allowed for the Operations Admin
  (audited), or **owner-reserved**? *(Recommendation: allowed + audited for v1; add a threshold later.)*
- **D-C — Payroll approval.** Is **payroll approval** (money out) owner-reserved? *(Recommendation:
  Operations Admin may run/prepare payroll; **approval** stays owner-reserved for v1 — classic
  segregation of duties.)*
- **D-D — One or many.** May the owner appoint **multiple** Operations Admins? *(Recommendation: yes.)*
- **D-E — Appoint UI placement.** Campus Hub "School-wide" block (least build) vs a new "Team & access"
  screen (cleaner long-term).

## 10. Edge cases
- **Dual-role person (Teacher + Operations Admin):** uses the admin shell (the higher role wins for
  shell/landing), still audited as themselves.
- **Revoked mid-session:** the next request re-checks roles → access dropped (OP-4).
- **Owner steps back:** the Operations Admin keeps the school running; the owner can always return and
  revoke (OP-1) — the owner can never be locked out by their own deputy.
- **Deputy tries to remove/demote the owner or mint another deputy:** blocked server-side (OP-1/OP-2).

## 11. Gates (Definition of Done for the build)
Permission-matrix rows for `OPERATIONS_ADMIN` on **every** route (allowed → 2xx, reserved → 403);
authz e2e (deputy can do operational X; **cannot** appoint ops/owner or touch the owner; owner can
revoke; last-owner protection intact); the **tenant-isolation suite** unaffected (still a tenant user);
plus the standing gates — lint, strict typecheck, api+worker build. Update the brain (this plan → shipped,
Progress Tracker, Key Decisions) with the build.
