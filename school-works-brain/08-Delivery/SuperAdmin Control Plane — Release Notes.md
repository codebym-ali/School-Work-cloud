# SuperAdmin Control Plane — Release Notes (SA0–SA7)

**Status:** ✅ Shipped & merged to `main` — merge commit `9342968` (2026-08-28). Built 2026-08-20 → 27
across 10 commits, one phase per commit. Companion docs: [[SuperAdmin Control Plane Plan]] (the design)
and [[Progress Tracker]] (the per-phase build log).

> Originally drafted as the pull-request description for `feat/superadmin-sa0`; kept here as the release
> note. The branch was merged directly with git (`--no-ff`) and then deleted — there is no open PR.

## Summary

The **vendor (SaaS operator) control plane** — the console the *vendor* uses to run the whole fleet of
schools, entirely separate from what a school's own admins do. The SuperAdmin is the **product owner**,
not a school entity: they create and monitor schools, and never touch a school's records except through
an audited, read-only break-glass door.

## What each phase adds

- **SA0 — Foundation.** `platform_users` role split (`SUPER_ADMIN` / `SUPPORT` / `BILLING` / `ANALYST`);
  reads open to all operators, writes `SUPER_ADMIN`-only. Operator **MFA** (TOTP + single-use recovery
  codes) + two-step login. Every write appends a **`platform_audit_logs`** row; suspend requires a
  reason. The tenant `PLATFORM_ADMIN` role is removed (an operator is a `platform_users` row, never a
  tenant `Role`).
- **SA1 — Fleet overview.** A nightly `platform_stats` snapshot + `GET /platform/overview` — schools /
  active students / staff / new-30-days, defined **once** server-side, read as O(one row).
- **SA2 — Safe credential handoff.** The plaintext `ownerPassword` is removed from provisioning; the
  console never accepts a typed password. Provisioning mints a one-time onboarding link; the owner sets
  their own (server-enforced, not just a UI omission).
- **SA3 — Plans, assignment & usage.** A server-side entitlement catalog (`PLAN_LIMITS`), plan change
  (audited), and usage-vs-cap surfacing. **Soft cap** — surface the overage, never block a child's
  admission at the counter — the deliberate call for this market.
- **SA4 — Operator management & invite.** List / enable / disable / re-role operators (never your own
  row → the last SUPER_ADMIN is protected for free), plus invite a new operator with a no-password
  onboarding link.
- **SA5 — Break-glass "login-as" (SA-P8).** A time-boxed, **read-only**, **RLS-scoped** vendor session
  into ONE school. It rides the **normal tenant path** (never `BYPASSRLS`), so it is confined to the
  target school by `TenantScopeGuard` + RLS *by construction*; read-only enforced by a guard.
- **SA6 — Vendor billing (in-house, per-student, offline).** Decision **D3**: the vendor charges each
  school a monthly rate **per active student**, set per school by a SUPER_ADMIN/BILLING operator;
  payments recorded **offline** (bank transfer / cash / cheque). Amounts frozen at issue;
  MRR / outstanding / collected on a dashboard.
  - **SA6b — automation.** `platform-billing-run` (monthly) auto-generates each priced school's invoice;
    `platform-dunning` (daily) auto-suspends a school whose invoice is unpaid > 7 days past due. System
    actions with a **null audit actor**.
  - **SA6c — opt-in auto-reactivate.** When a school suspended **for non-payment** clears its overdue
    balance, it comes back online automatically — **only if the operator opted in** (a toggle, default
    off), and **never** for a school suspended by hand (guarded by `schools.suspended_reason`).
- **SA7 — Tenant export + hard-delete / crypto-shred (SA-P5).** Offboard a school completely and
  provably: a reversible 30-day retention window, a redacted full export, then an irreversible purge
  proven to leave **zero orphans**.

## Design invariants held throughout

- **Containers, not contents** — fleet totals and tenant containers, never a school's individual records
  (except the audited read-only break-glass door).
- **Every write is audited** (`platform_audit_logs`), reason mandatory on destructive actions.
- **Credentials never shown or typed** (SA-P3) — one-time onboarding links, server-enforced.
- **`BYPASSRLS` confined** — break-glass is RLS-scoped, never `BYPASSRLS` (SA-P8).
- **Irreversible actions are two-step and recoverable** (SA-P5) — retention window + typed confirmation.
- **One definition per fleet number** (Law 4) — "active students" means the same on the dashboard, the
  plan-cap surface, and a billing invoice.

## Engineering decisions worth remembering

- **FK-ordered delete from the LIVE graph, not a hand list** (`libs/database/src/tenant-purge.ts`): Kahn's
  algorithm over `pg_constraint`, children-first, cached; **fails loudly if the school survives**. A
  hand-maintained list rotted once and left 251 dead schools + 11 orphaned audit rows behind. **One copy
  of the walk** — the test teardown delegates to it, so cleanup can't drift from the real purge.
- **Platform tables reference a school by `tenant_id`, never `school_id`.** The RLS-coverage gate flags
  any `school_id` column without a `tenant_isolation` policy (and does not exempt `platform_*` tables), so
  vendor-side tables (`platform_audit_logs`, `platform_invoices`) use `tenant_id`, go on the NON_TENANT
  allowlist, and are revoked from `app_user`. `platform_invoices.tenant_id` is `ON DELETE SET NULL` + a
  subdomain snapshot, so **billing history survives an SA7 purge**.
- **Money is `Prisma.Decimal` end-to-end**, frozen onto the invoice at issue (re-pricing never rewrites
  history); OVERDUE is derived, never stored.
- **A suspend records WHY** (`schools.suspended_reason`: `NON_PAYMENT` vs `MANUAL`) so automated
  reactivation can lift a non-payment lock without ever touching a manual/legal hold.
- **Test for effect, not just logic.** Several controls in this codebase were once implemented, read
  correctly, and never actually fired; the platform specs assert observable effects (a 403 that leaves no
  audit row, a purge that leaves zero orphans, an amount that equals students × price).

## New tables / migrations

`platform_users` (+ role/MFA), `platform_refresh_tokens`, `platform_audit_logs` (actor nullable since
SA6b), `platform_mfa_recovery_codes`, `platform_stats`, `platform_password_reset_tokens`,
`platform_invoices`, `platform_settings`; `schools` gains `purge_after` / `termination_reason` (SA7),
`price_per_student` (SA6), and `suspended_reason` (SA6c). Every vendor table is allowlisted in
`scripts/check-rls-coverage.mjs` and revoked from `app_user` in `prisma/sql/06_grants.sql` — the
**vendor-isolation** gate proves `app_user` holds no privilege on any `platform_*` table.

## Verification (green on `main`)

**api + worker build** · **eslint** (`--max-warnings 0`) · **web `tsc --noEmit`** · `db:check-rls` (RLS
coverage + tenant enrolment + **vendor isolation**) · the **tenant-isolation suite (7)** · and the platform
integration specs — **11 suites / 86 tests** covering MFA, authz+audit, overview, provisioning, plans,
operators, invite, break-glass confinement + read-only, tenant lifecycle incl. the **zero-orphan integrity
gate**, and billing incl. **billing history surviving a purge**, the auto-invoice / dunning jobs, and the
opt-in auto-reactivate. SA5, SA6, and SA6c were additionally verified live on the running console.

## Deferred (follow-ups, none blocking)

Partial payments / refunds; a real **payment gateway** (Stripe / local PK rails); wiring **MRR into SA1's
nightly snapshot**; an optional operator **IP allowlist** (SA4); a **write-capable break-glass** (needs the
nullable-`actor` tenant-audit change, decision D5) + owner notification (decision D4).
