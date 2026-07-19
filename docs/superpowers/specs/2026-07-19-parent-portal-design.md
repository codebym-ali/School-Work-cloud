# Feature #1 — Parent Portal (Design Spec)

> **Status:** Design APPROVED (2026-07-19). Release 1. Foundation for all parent-facing features.
> **Confirmed decisions:** (1) Fee = **view + printable challan only**, no payment gateway in v1.
> (2) Portal is **read-only mirror + downloads**, no write-actions in v1. (3) Onboarding =
> **self-service phone + OTP**.

## Open Decisions (none blocking — all confirmed)

- ✅ Login method: phone + OTP (schema `ParentProfile` already carries OTP columns).
- ✅ Fee: printable challan, pay at counter/bank. Online gateway → v2.
- ✅ Scope: read-only. Leave requests / teacher messaging → later.
- ⚠️ **Diary tab ships dormant.** Homework data does not exist until feature #5. The parent
  portal's "Diary/Homework" tab is either hidden in v1 or shows an empty state until #5 lands.
  Recommendation: **hide the tab in v1**, enable via feature flag when #5 ships.

## 1. Business Analysis

- **Problem:** Parents phone the front desk daily for attendance/fee/result. The portal makes this
  self-service, cuts front-desk load, and is the #1 thing a school owner asks to see in a demo.
- **Who uses it:** Parent (one parent → many children within one school). A child may have multiple
  guardians, each with their own login.
- **Who must NOT:** teachers/admins (they have their own screens); a parent must never see another
  parent's or another school's child.
- **Current manual workflow:** parent calls/visits → front desk looks up ledger/attendance → verbal.
- **Foundation already present:** `ParentProfile` (OTP columns: `otpCodeHash`, `otpExpiresAt`,
  `otpAttempts`, `phoneVerifiedAt`, `smsOptOut`), `StudentGuardian` (parent↔student, `isPrimary`,
  `relation`), `Student.userId` self-scoped portal pattern in `student-portal.service.ts`,
  `phone-verification.service.ts` OTP helper, comms/SMS pipeline for OTP delivery.

## 2. Users & Roles

| Role | Access |
|---|---|
| PARENT | Own linked children only, read-only. |
| everyone else | No access to `/parent/*`. |

## 3. Authentication & Onboarding Flow

A **separate parent auth path** from the admin email+password+TOTP path.

```
1. /parent/login → parent enters phone (0300-xxxxxxx)
2. POST /parent/auth/request-otp
   - normalize to E.164 → match ParentProfile.phone (within school, resolved by host subdomain)
   - no match  → return generic 200 "if registered, an OTP was sent" (enumeration-safe)
   - match     → generate 6-digit OTP, store HMAC in otpCodeHash, 5-min expiry, enqueue SMS
                 (template triggerKey = ACCOUNT_INVITE / a new PARENT_OTP key)
3. /parent/login (step 2) → parent enters OTP
4. POST /parent/auth/verify-otp
   - verify HMAC, check otpExpiresAt, otpAttempts ≤ 5 (else lock + cooldown)
   - success → set phoneVerifiedAt, issue parent session JWT (role PARENT, sub = user/parent id),
               httpOnly + Secure + SameSite=Strict cookie; clear OTP columns
5. Landing: GET /parent/children
   - 1 child  → redirect to that child's overview
   - N children → child-switcher
```

- **No TOTP MFA for parents** — the OTP is itself the second factor.
- **Rate limits:** max 3 OTP requests / phone / 15 min; 5 verify attempts before lock.
- **Session:** short-lived access + refresh rotation (reuse `RefreshToken` model + `token.service.ts`
  patterns). Refresh cookie path-limited as existing admin sessions are.
- **Reuse:** `phone-verification.service.ts` OTP hashing; `sms-producer.service.ts` for delivery.

## 4. Data Scoping (most important — security)

Parents are multi-child, so `/me`-style single-row scoping does not apply. Instead:

- Every parent request resolves `ParentProfile` from the **session** → `StudentGuardian` rows →
  the set of `studentId`s this parent is linked to.
- **The client never selects a child by passing an arbitrary id.** Any `:studentId` path param is
  validated against the resolved guardian-link set **in the service** (§22.8 — not a guard, because
  guards run before the `withTenant` tx and RLS would return 0 rows). Mismatch → **404** (not 403,
  to avoid leaking existence).
- RLS still isolates by `school_id` underneath; parent-scope is layered on top.

## 5. Data Model

**No schema migration required for v1.** All needed models exist (`ParentProfile`, `StudentGuardian`,
`Student`, `StudentEnrollment`, `AttendanceRecord`, `FeeInvoice`, `ReportCard`, `Document`).

Optional small additions (only if needed):
- A `PARENT_OTP` value in the SMS template `triggerKey` set (currently `ACCOUNT_INVITE` can be reused).
- `ParentProfile.lastLoginAt` if login analytics are wanted (nice-to-have, skip for v1).

## 6. API Surface (`/api/v1/parent/*`)

New `ParentPortalModule`: `ParentPortalController` + `ParentPortalService` + a `ParentAuthController`.

| Method + Path | Purpose | Guard |
|---|---|---|
| `POST /parent/auth/request-otp` | phone → OTP SMS (rate-limited, enumeration-safe) | public |
| `POST /parent/auth/verify-otp` | OTP → parent session | public |
| `POST /parent/auth/logout` | clear session | PARENT |
| `GET /parent/children` | linked children (id, name, class/section, active flag) | PARENT |
| `GET /parent/children/:studentId/overview` | summary: attendance %, outstanding fee, latest published result, unread notices | PARENT |
| `GET /parent/children/:studentId/attendance` | attendance history (paginated) | PARENT |
| `GET /parent/children/:studentId/results` | **published** results / report cards only | PARENT |
| `GET /parent/children/:studentId/fees` | invoices + outstanding (excludes reversed) | PARENT |
| `GET /parent/children/:studentId/fees/:invoiceId/challan.pdf` | bank-style challan PDF (shared generator, feature #3) | PARENT |
| `GET /parent/children/:studentId/documents` | certificates / downloads (presigned URLs) | PARENT |

**Invariants:**
- Every `:studentId` validated against guardian links (→ 404 on mismatch).
- Only finalized/published data is ever returned: no draft results, no unpublished report cards,
  no reversed/voided payments.
- All list endpoints paginated + sorted, using existing envelope + pagination conventions (§25).

## 7. UI (Next.js — `apps/web/app/(app)/parent/*` or a dedicated parent layout)

Mobile-first (parents are on phones). Uses the same API client layer as `apps/web/lib/api.ts`
(add `api.parent.*`).

- `/parent/login` — 2-step phone → OTP.
- `/parent` — child-switcher (auto-select if 1 child) + overview cards
  (attendance %, outstanding fee with "Download Challan", latest result, notices).
- `/parent/[studentId]/attendance` · `/results` · `/fees` · `/documents`.
- Persistent top bar: child-switcher dropdown ("Ali — Grade 4-B ▾"), logout.
- `apps/web/lib/roles.ts`: add PARENT `NAV` entries + `landingPath()` sends pure-PARENT users to `/parent`.

## 8. Edge Cases

| Case | Behavior |
|---|---|
| Child has 2 guardians | Both get their own login + full read access. Only `isPrimary` receives SMS/notices. |
| Child withdrawn/inactive | Historical data (results, paid challans) stays visible, read-only, with an "Inactive" badge; nothing new. |
| All of a parent's children inactive | Login works; empty state ("no active enrollment"). |
| Parent phone changed/typo | Admin updates `ParentProfile.phone`; `phoneVerifiedAt` resets, re-verify on next login. |
| Guardian link added after admission | New child appears immediately (live query, no stale cache). |
| OTP flooding | Rate-limit per phone (3/15min); attempt-lock after 5 fails. |
| Fee reversed/refunded | Outstanding recomputed live; parent never sees stale "paid". |
| `smsOptOut = true` | OTP still sends (transactional, not marketing). |
| Two parents log in simultaneously | Independent sessions; no shared state. |

## 9. Testing Checklist

- **Isolation:** parent A cannot read parent B's child (cross-guardian); cross-tenant blocked by RLS.
  Add to the merge-blocking isolation suite.
- **OTP:** expiry, max-attempts lock, replay-safe, enumeration-safe response shape.
- **Scoping:** `:studentId` tampering → 404 for both foreign-parent and foreign-tenant ids.
- **Only-published:** draft result / unpublished report card / reversed payment absent from responses.
- **Multi-child** switcher + **single-child** auto-select.
- **Matrix-conformance:** add PARENT rows for every `/parent/*` route (the audit found PARENT rows missing).
- **Playwright e2e:** login → switch child → view fees → download challan PDF.

## 10. Scalability

- Parent auth is stateless (JWT cookie); OTP state is short-TTL in DB/Redis → scales to 50k+ parents.
- `StudentGuardian(schoolId, parentId)` index already exists for fast child resolution.
- All reads paginated + indexed.

## 11. Build Order (for the implementer)

1. `ParentPortalModule` scaffold + `ParentPortalService` copying the `student-portal.service.ts` shape.
2. Parent auth (request-otp / verify-otp) reusing `phone-verification.service.ts` + `token.service.ts`.
3. `GET /parent/children` + guardian-link scoping helper (the §22.8 service check).
4. Read endpoints (overview, attendance, results, fees, documents) — published-only filters.
5. Challan PDF endpoint — coordinate with feature #3 spec (shared generator).
6. Frontend: login, child-switcher, tabs; `api.parent.*`; `roles.ts` NAV + landing.
7. Tests: isolation + matrix rows + Playwright.
8. Brain update: Progress Tracker + `03-Domain` or a new portal note + Key Decisions (parent auth path).
