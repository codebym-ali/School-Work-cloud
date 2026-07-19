# Feature #4 — Admin Screens + SMS/Comms Center (Design Spec)

> **Status:** Design DRAFT (2026-07-19). Release 2. Mostly frontend over ready backend.
> **Goal:** Build the admin-facing screens whose backend already exists but which have no UI, and
> **close the security gaps** the 2026-07-19 audit found while wiring them.

## Open Decisions (confirm before build)

1. **Which screens are in this batch?** Recommendation: **SMS/Comms Center, Leave-Approval Queue,
   Users & Roles, Audit-Log Browser** (the four with ready backends). ⚠️ Confirm scope; Teacher
   assignments/timetable editor is deferred to feature #5, Payroll/Documents screens can be a later batch.
2. **Users & Roles — self-service invite or admin-only?** Recommendation: OWNER_ADMIN/CAMPUS_ADMIN
   invite staff by email → INVITED status → set-password flow (the `User.status = INVITED`,
   `passwordHash = null` path already exists). ⚠️ Confirm.
3. **Audit-log browser retention/scope.** Recommendation: filter by actor, action, date, entity;
   read-only; OWNER_ADMIN (all) / CAMPUS_ADMIN (own campus). ⚠️ Confirm campus scoping on audit reads.

## 1. Business Analysis

- **Problem:** Powerful backends (SMS pipeline, leave approval, RBAC, audit log) are invisible because
  they have no screens. The school can't self-serve; every change needs a developer. Also, two of these
  endpoints are currently **security holes** (unguarded SMS reads, over-permissioned leave create).
- **Why now:** high value-per-effort — frontend over existing, tested APIs. Turns latent capability
  into demoable, sellable features and hardens the app.
- **Existing foundation:** `comms.controller.ts` + comms/SMS module; `leaves.controller.ts` +
  `leaves.service.ts`; auth/users module + `Role` enum (PLATFORM_ADMIN…STUDENT); `AuditController`
  (`GET /api/v1/audit-logs`) + audit log model.

## 2. Screens & Backends

| Screen | Backend (exists) | Primary roles |
|---|---|---|
| **SMS/Comms Center** | `comms.controller.ts` `/sms/templates`, `/sms/credits`, `/sms/logs`, manual send | OWNER_ADMIN, CAMPUS_ADMIN, ACCOUNTANT(fee) |
| **Leave-Approval Queue** | `leaves.controller.ts` (student + staff leaves, approve/reject) | OWNER_ADMIN, CAMPUS_ADMIN, TEACHER(own section) |
| **Users & Roles** | auth/users module (invite, roles, status, lockout) | OWNER_ADMIN, CAMPUS_ADMIN(own campus) |
| **Audit-Log Browser** | `AuditController` `/audit-logs` | OWNER_ADMIN, CAMPUS_ADMIN(own campus) |

## 3. Security fixes to fold in (from audit — these are bugs)

**Do these as part of wiring the screens so they get test coverage:**

1. **`GET /sms/templates`, `/sms/credits`, `/sms/logs` have NO `@Roles`** → any authenticated user
   (incl. PARENT/STUDENT) can read SMS logs + credit balances. **Add `@Roles(OWNER_ADMIN, CAMPUS_ADMIN,
   ACCOUNTANT)`** (logs/credits), scope ACCOUNTANT to fee-related where applicable. Add matrix rows —
   currently `test/matrix/permission-matrix.ts` has **zero** rows for these, so the gap was invisible.
2. **`POST /student-leaves` allows OWNER_ADMIN/CAMPUS_ADMIN** to create; blueprint restricts create to
   TEACHER(own section)/PARENT(own child). **Tighten the guard**; admins get R,A (read, approve) only.
3. **Teacher can file leave for any student** (no section-ownership check, no `source` field). Add the
   **service-layer section-ownership check** (§22.8) + capture a `source` field on the leave.

## 4. Permissions (per screen — authoritative)

**SMS/Comms Center**

| Action | OWNER_ADMIN | CAMPUS_ADMIN | ACCOUNTANT | others |
|---|---|---|---|---|
| View templates | ✅ | ✅ (own campus) | fee templates | — |
| Edit template | ✅ | ✅ | — | — |
| Manual send | ✅ | ✅ | fee reminders | — |
| View logs | ✅ | ✅ (own campus) | fee-related | — |
| View credits | ✅ | ✅ | ✅ | — |

**Leave-Approval Queue**

| Action | OWNER_ADMIN | CAMPUS_ADMIN | TEACHER | PARENT |
|---|---|---|---|---|
| View queue | ✅ | ✅ (own campus) | own section | own child (read status) |
| Approve/Reject | ✅ | ✅ | own section | — |
| Create student leave | — | — | own section (source recorded) | own child |

**Users & Roles**

| Action | OWNER_ADMIN | CAMPUS_ADMIN |
|---|---|---|
| Invite user | ✅ | ✅ (own campus, non-owner roles) |
| Assign/revoke roles | ✅ | ✅ (limited) |
| Lock/unlock, deactivate | ✅ | ✅ (own campus) |

**Audit-Log Browser:** OWNER_ADMIN (all), CAMPUS_ADMIN (own campus). Read-only.

## 5. API Surface

Mostly exists; add/guard:
- Guard the three SMS GETs (fix #1).
- Tighten `POST /student-leaves` (fix #2) + section-ownership + `source` (fix #3).
- `Users & Roles`: ensure invite / role-update / lock endpoints exist and are campus-scoped in service.
- `Audit-Log Browser`: ensure `/audit-logs` supports filters (actor, action, entity, date range) +
  campus scoping in the service.

## 6. UI (Next.js, `apps/web/app/(app)/*`)

New routes + `roles.ts` `NAV` entries (gated per role):
- `/comms` — SMS center: template editor, manual send, delivery logs (channel filter — ties to #2
  WhatsApp), credit balance + ledger. (WhatsApp tab appears once #2 lands.)
- `/leaves` — approval queue: pending student + staff leaves, approve/reject, filters by section/campus.
- `/users` — user list, invite modal, role chips, status/lock controls.
- `/audit` — filterable, paginated, read-only audit table.

## 7. Edge Cases

| Case | Behavior |
|---|---|
| CAMPUS_ADMIN views another campus | Server-side campus scope filters rows (§22.8 in service); UI never receives them. |
| Manual SMS with 0 credits | Block + prompt to top up; never send unpaid. |
| Invite existing email | Reject with clear "user already exists" (respect `@@unique([schoolId, email])`). |
| Revoke own OWNER_ADMIN role | Block self-lockout (must keep ≥1 active OWNER_ADMIN). |
| Approve already-approved leave | Idempotent / conflict message; no double state change. |
| Teacher approves out-of-section leave | Rejected by section-ownership check. |
| Audit browser huge result set | Server pagination + indexed filters; never load all. |

## 8. Testing Checklist

- **Security regression tests** for all three audit fixes + **matrix-conformance rows** for the newly
  guarded SMS endpoints and the tightened leave create (the whole point — make the holes untestable-to-regress).
- Campus scoping: CAMPUS_ADMIN cannot see/act on other campuses (comms logs, leaves, users, audit).
- Self-lockout prevention (last OWNER_ADMIN).
- Invite → INVITED → set-password happy path.
- Leave approve/reject state machine + idempotency.
- Playwright: each screen loads role-appropriately; a PARENT/STUDENT is denied `/comms`, `/users`, `/audit`.

## 9. Scalability

- All lists paginated + indexed; audit + logs are the highest-volume — ensure `(schoolId, createdAt)`
  indexes are used (they exist on `SmsLog`).

## 10. Build Order

1. **Security fixes first** (guards on SMS GETs, tighten leave create, section-ownership + `source`) +
   their tests/matrix rows — independently shippable hardening.
2. SMS/Comms Center UI (leaves room for #2's WhatsApp tab).
3. Leave-Approval Queue UI.
4. Users & Roles UI.
5. Audit-Log Browser UI.
6. `roles.ts` NAV + landing gating; Playwright per screen.
7. Brain update: Progress Tracker (mark the previously-silent UI gaps as closed), Key Decisions
   (audit fixes), Security note (surface the now-closed holes).
