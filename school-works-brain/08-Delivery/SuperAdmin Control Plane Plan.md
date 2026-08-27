# SuperAdmin (Vendor Control Plane) Plan (SA0–SA7)

**Raised by the operator, 2026-08-20:** *"This system will be implemented in more schools. We need
the record of everything — how many schools, how many students, who controls them. The SuperAdmin is
the owner of this SaaS product who creates schools, their admin credentials, and controls the whole
product."*

**Status:** 📋 **PLANNED — not built.** Sequenced by dependency below (SA0 → SA7).
**Audited 2026-08-20** as senior engineer/architect; six findings folded in (§9, with the full
before/after). The boundary correction (SuperAdmin = product owner, not a school entity) is recorded
in [[Key Decisions]] → *Security invariants*.

> Related: [[Owner Login Plan]] (the tenant-side door — a *different* identity), [[Multi-Tenancy & Isolation]]
> (the isolation floor this rides on), [[System Structure]] (Law 4 "one server-side implementation"
> applies to fleet numbers too), [[Roadmap & Milestones]].

---

## 0. The boundary principle — read this before any phase

There are **two worlds**, and the SuperAdmin lives in the outer one:

- **Platform world** — the vendor (you). The SuperAdmin runs the *product*: onboards schools, bills
  them, monitors the fleet, supports them.
- **Tenant world** — each school, run by its own Owner Admin and staff.

**The SuperAdmin controls *containers*, not *contents*.** It creates a school, sets its plan, turns
modules on, watches the totals — it does **not** admit a student, mark attendance, or collect a fee.
Those are a School Admin's job. When the vendor genuinely must touch one school's records (a support
case), it happens through **audited, time-boxed "login-as" (SA5)** — never a global student table.

⚠️ **This corrects the first framing of this feature.** The original question was "how deep can the
SuperAdmin see into a school's data" — a *tenant* lens, and the wrong one. The SuperAdmin's native
surface is the **fleet**; per-school data access is the exception (break-glass), not a permission
dial. Every phase below honours that.

---

## 1. What exists today (grounded — verified in the audit)

The **hard, invisible half is already built** — the isolation floor:

| Piece | Where | State |
|---|---|---|
| Separate vendor identity | `platform_users` table (no `school_id`, no RLS) | ✅ exists |
| Cross-tenant DB power | `platform_admin` role, **BYPASSRLS**, creds never reach the API container | ✅ exists |
| Vendor auth stack | `PlatformAuthService` — argon2id, rotating refresh w/ family-reuse detection, own cookies + JWT `typ` | ✅ exists |
| Guard | `PlatformAuthGuard` — CSRF on writes, **re-checks status every request** | ✅ exists |
| Console UI | `apps/web/app/admin/` — "🛠️ Vendor Console" | ✅ thin |
| Console actions | `list / provision / suspend / reactivate` | ⚠️ minimal |
| Plan tier | `PlanTier { BASIC PLUS PRO }` on the school | ⚠️ stored, not controllable/enforced |
| Plan → entitlement precedent | SMS credits are plan-driven: `smsCreditLedger` + `PLAN_MONTHLY_SMS_CREDITS[planTier]` | ✅ **the pattern SA3 copies** |
| Password-reset infra | `password_reset_tokens` (30-min, hashed, tenant-scoped) | ✅ **SA2 reuses this** |

The **visible control plane on top is what's missing.** The console today is domains A + D (from the
research) in their thinnest form.

### ⚠️ Four current-state facts the audit pinned — the phases must respect these

1. **There is NO tenant hard-delete / crypto-shred job.** The worker's `MaintenanceJob` union is
   `mark-overdue · fee-integrity-check · idempotency-purge · sms-log-purge · sms-monthly-credit ·
   staff-attendance-close` (`apps/worker/src/maintenance/maintenance.service.ts`). The **only** tenant
   deletion ever performed was the hand-written, FK-ordered, leaf→root transaction used to delete the
   E2E campus (2026-08-19), because `ON DELETE RESTRICT` across ~40 tables (some FKs `NOT VALID`) makes
   it dangerous. → **Hard-delete is its own phase (SA7), not a one-line reuse.**
2. **`module_access` is per-USER RBAC, not per-tenant entitlement.** `@@unique([userId, moduleKey])`
   gates whether *a user* may open a module — not whether *a school* has it. There is no tenant-module
   table today. → **SA3 models entitlement separately** (following the SMS-credit precedent above),
   and must not repurpose `module_access`.
3. **`audit_logs` is hard-keyed to tenant users** (`userId + schoolId` composite FK → `users`). A
   `platform_user` has no `users` row, so vendor actions **cannot** be written to it as-is. → **SA5
   needs a nullable/`actingAsVendor` actor shape** before it can stamp a school's own audit.
4. **The plaintext `ownerPassword` field** in `admin/page.tsx`'s `NewTenant` form violates SA-P3. →
   **SA2 replaces it** with a `password_reset_tokens`-backed onboarding link.

### Vestigial role to clean up

⚠️ **`Role.PLATFORM_ADMIN` (tenant enum) is vestigial** — it mints an admin-looking shell in
`apps/web/lib/roles.ts` but has **no** platform power; the real SuperAdmin is `platform_users`. SA0
removes or reconciles it so it stops reading as a second, fake SuperAdmin.

---

## 2. Design invariants (every phase honours these)

- **SA-P1 · Containers, not contents.** No global student/fee/attendance browsing UI is ever built.
  School data is reached only via SA5 break-glass, audited.
- **SA-P2 · Every platform write is audited.** Who (operator), what, which tenant, when — and a
  **reason** on destructive actions. This is why SA0 comes first.
- **SA-P3 · Credentials are never shown in plaintext.** First-admin onboarding is a one-time secure
  link with a forced password reset (reusing `password_reset_tokens`); the console never displays or
  stores a typed password.
- **SA-P4 · BYPASSRLS stays confined** to the `platform/` module (+ the one verified `comms.service`
  webhook exception). No later phase leaks it onto the tenant request path.
- **SA-P5 · Irreversible actions are two-step and recoverable.** Terminate/purge require explicit
  confirm + reason, and stay reversible within a retention window before the hard delete/crypto-shred.
- **SA-P6 · The API is the authority.** The console can only *narrow*; it never widens what a platform
  role is allowed. Server enforces every limit and role.
- **SA-P7 · Fleet numbers have one server-side implementation** (System Structure Law 4), **and a
  defined meaning** (see SA1). No total is recomputed in the browser, and no total is ambiguous.
- **SA-P8 · Break-glass runs on the RLS-scoped tenant path, NEVER BYPASSRLS.** *(Added in the audit.)*
  An impersonation session acts as `app_user` with the target school's GUC set — a real, RLS-bound
  tenant session — so it is physically incapable of seeing a second tenant. Using the BYPASSRLS
  connection for impersonation would silently defeat the entire isolation model. Proven by an
  isolation-suite test (SA5).

---

## 3. The phases

Ordered so each unblocks the next, **with the audit's re-sequencing applied**: MFA + a role split are
pulled forward into SA0 (they guard everything after), and tenant hard-delete is lifted out of SA2
into its own phase (SA7).

### SA0 — Foundation: platform audit + MFA + role split *(guards everything after it)*
**Goal:** make every platform action recordable, the login strong, and privilege least — before
adding more powerful actions.
- **DB:** `platform_audit_logs` (id, platform_user_id, action, target_tenant_id?, metadata jsonb,
  reason?, ip, created_at). Not a tenant table — no `school_id`. **Add it to `NON_TENANT_TABLES` in
  `scripts/check-rls-coverage.mjs`** or the enrolment gate fails the build (§8).
- **API:** wrap `provision / suspend / reactivate` (and all future writes) to append an audit row;
  require a `reason` on suspend/terminate.
- **MFA:** add a second factor to the platform login — today the single most powerful account has none.
- **Roles:** minimum split now — **read-only (Analyst/Support view)** vs **full operator** — so SA1's
  dashboard and SA2's destructive actions land on distinct privilege levels. (Full operator management
  is SA4.)
- **Cleanup:** resolve the vestigial `Role.PLATFORM_ADMIN` (decision D1).
- **Done when:** every write leaves an audit row; a destructive call without a reason is a 400;
  platform login requires a second factor; a read-only operator cannot mutate; no tenant user can
  obtain platform-shell UI via `PLATFORM_ADMIN`.

### SA1 — Fleet Overview dashboard *(the "record of everything")* — ✅ SHIPPED 2026-08-25
**Goal:** one screen answering "how many schools, how many students, who's active" — cheaply and
unambiguously.

> ✅ **Shipped 2026-08-25.** `platform_stats` snapshot table + nightly `platform-stats-snapshot`
> worker job + `GET /platform/overview` (open read) + the `/admin` fleet-tile row. Metrics as pinned
> below, **minus the "trial" split** — there is no trial state in the schema, so schools split
> **active / suspended** only (inventing a trial bucket that reads 0 would violate the honesty rule).
> Verified: migration applied, `db:check-rls` green (vendor isolation now covers `platform_stats`),
> typecheck clean, 4 platform specs / 34 tests green. Details in [[Progress Tracker]].
- ⚠️ **Metrics are DEFINED, not vibes** (SA-P7). Pin each: **Schools** = rows in `schools`, split
  active / trial / suspended by state; **Students** = `student_enrollments` with status `ACTIVE`
  (not raw `students`, not admitted — the E2E cleanup proved these diverge); **Staff** = `staff_profiles`
  with an employed status. Every tile carries its definition.
- ⚠️ **Computed from a nightly snapshot, not live** (audit finding E). A `platform_stats` snapshot row
  is written by a new nightly maintenance job (the worker already iterates active tenants each night —
  natural home). The dashboard reads the snapshot. Live fleet-wide `COUNT(*)` does not scale to
  50 schools × 10k students. `platform_stats` is a non-tenant table → **allowlist it** (§8).
- **API/UI:** `GET /platform/overview` returns the snapshot + a per-school row (name, plan, students,
  staff, storage, SMS used, last-active). `/admin` becomes the dashboard; the existing tenant table
  sits below.
- **Done when:** the vendor sees defined fleet totals + a per-school breakdown without opening any
  school, and the query cost is O(read one snapshot), not O(all tenants).

### SA2 — School lifecycle & credential delivery *(no hard-delete here — see SA7)* — ⚙️ CREDENTIAL HANDOFF SHIPPED 2026-08-25
**Goal:** create a school end-to-end and hand over its admin login *safely*; soft lifecycle only.

> ⚙️ **Shipped 2026-08-25 (the credential-handoff core — SA-P3):** the plaintext `ownerPassword` is
> **gone** from the console. `ProvisionTenantDto` no longer accepts a password (a sent one → 400,
> `forbidNonWhitelisted` — server-enforced, SA-P6), provisioning mints a one-time onboarding token
> (reusing `password_reset_tokens`, 7-day TTL — longer than the 30-min reset TTL because onboarding
> is delivered-then-acted, not urgent self-service), and the console shows the owner a **set-password
> link** on their own tenant host, once, with copy. A new public `/set-password` page consumes it via
> `/auth/reset-password` (which already flips INVITED → ACTIVE). Verified: 4 platform specs / 35 tests
> green incl. the full flow (provision → link → set password → owner login) and the typed-password 400.
> **Still TODO in SA2:** create-with-plan (needs SA3's plan model), custom-domain, edit-profile, and
> the trial/expired soft states (no such states in the schema yet — same honesty note as SA1's "trial").
- **API/UI:** create-with-plan (name, subdomain, custom domain, plan, region/calendar template); edit
  profile; **soft** state machine **active → trial → suspended → expired** (suspend already exists;
  hard termination/purge is SA7).
- **Credential handoff (SA-P3):** **reuse `password_reset_tokens`** — provisioning mints a one-time,
  30-min, hashed onboarding token for the new Owner Admin; the console shows a link/sends it, the owner
  sets their own password (forced reset) and enrols MFA per the existing owner rule. ⚠️ Cross-boundary
  wrinkle: the token is tenant-scoped but minted by a platform action — the provisioning path (already
  on the BYPASSRLS conn) writes it for the just-created tenant.
- **Remove** the plaintext `ownerPassword` field from `NewTenant`.
- **Done when:** a new school + owner exist from one flow with **no password ever typed into the
  console**; suspend/expire are reversible; new platform routes are registered in the route-coverage
  gate (§8).

### SA3 — Plans, limits & tenant entitlement — ⚙️ SA3a (catalog + assignment) SHIPPED 2026-08-27
**Goal:** turn `PlanTier` from a stored label into enforced control — **without** misusing
`module_access`.

> ⚙️ **SA3a shipped 2026-08-27** (the platform-side, non-enforcing half): a server-side `PLAN_LIMITS`
> catalog (kept in code, keyed by tier, monthlySmsCredits referencing the existing SMS-credit map —
> the precedent this phase copies, `module_access` untouched); `GET /platform/plans` (open read) +
> `PATCH /platform/tenants/:id/plan` (SUPER_ADMIN, audited `TENANT_PLAN_CHANGE` from→to); console plan
> selector + per-school usage-vs-cap. Verified: tsc (backend + web), lint, 5 platform specs / 40 tests.
> **SA3b (surfacing) shipped 2026-08-27**, with the over-limit decision made: **soft-cap, not
> hard-block** — never stop a school enrolling a child at the counter; the cap is a visible overage
> signal (the vendor's upsell lever), aligning with the "surface vs police" principle. `listTenants`
> returns `activeStudents` (Law 4), the console flags at/over-cap schools, and a Plans reference
> renders the catalog. **Still deferred (opt-in, if ever wanted):** an actual tenant-path hard block,
> and staff / campus / storage overage surfacing. Details in [[Progress Tracker]].
- **DB/API:** a plan catalog with **limits** (max students, max staff, SMS credits, storage) and a
  **tenant-entitlement** representation (school + plan → enabled modules), modelled **like the existing
  SMS-credit mechanism** (`smsCreditLedger` + `PLAN_MONTHLY_SMS_CREDITS[planTier]`), *not* by writing to
  the per-user `module_access` table. Assign / upgrade / downgrade a school.
- **Enforcement (SA-P6):** the server blocks actions past a limit (e.g. admission #501 on a 500 plan)
  with a clear "upgrade" error. ⚠️ The enforcement leg lives on the **tenant** request path and touches
  several modules (admissions, staff, SMS, storage) — this is a broader change than a platform-only
  phase; the count-vs-cap check must be **atomic** (a concurrent-admission race near the cap must not
  slip past). Scope SA3 accordingly.
- **Done when:** changing a school's plan changes what its users can do; an over-limit action is refused
  server-side and atomically; entitlement lives in its own model, `module_access` untouched.

### SA4 — Operator management *(the rest, beyond SA0's MFA + read/full split)*
**Goal:** run the vendor's own team at least-privilege.
- **DB/API:** the full platform-role set — **SuperAdmin** (all), **Support** (read fleet + SA5 login-as),
  **Billing** (subscriptions only), **Analyst** (read-only); operator create / disable / list; optional
  IP allowlist.
- **Done when:** a Support operator cannot change a plan or bill; a Billing operator cannot open a
  school; disabling an operator revokes access immediately (guard already re-checks status).

### SA5 — Break-glass support ("login-as")
**Goal:** let the vendor enter a specific school to help — accountably and safely.
- **Security (SA-P8, load-bearing):** impersonation issues a **real RLS-scoped tenant session**
  (`app_user` + the target school's GUC), **never** the BYPASSRLS connection. An **isolation-suite test**
  proves an impersonated session cannot read a second tenant (§8).
- **Audit shape (finding C2):** before this ships, decide how a vendor actor is recorded in the school's
  own `audit_logs` — a **nullable actor + `actingAsVendor`/`actorType`** field, or a dedicated
  impersonation-audit record (decision D5). The session is also written to `platform_audit_logs`.
- **API/UI:** SuperAdmin/Support starts a **time-boxed** impersonation into one school; auto-expires;
  scoped to one tenant; visible as "acting as vendor" in that school's audit.
- **Done when:** a support agent can reproduce a school's issue, every action is attributable to the
  vendor in the school's own audit, the session is RLS-scoped (test-proven), and it ends on its own.

### SA6 — Billing & subscriptions *(a separate epic — size it as one)*
**Goal:** connect plans to money. ⚠️ This is effectively its own product; consider deferring or a
gateway partner (decision D3).
- **DB/API:** per-tenant invoices, payment records, trial→paid transitions, dunning + auto-suspend on
  non-payment (feeds SA2's state machine), revenue/MRR into SA1's snapshot. New non-tenant tables →
  **allowlist them** (§8).
- **Done when:** a non-paying school follows grace → suspend automatically; the dashboard shows real
  revenue, not a placeholder.

### SA7 — Tenant export + hard-delete / crypto-shred *(NEW — the real home of A)*
**Goal:** offboard a school completely and provably. This is the hardest operation in the system; it
gets its own phase, not a footnote.
- **API/worker:** promote the manual E2E-campus delete into a **maintained, FK-ordered, transactional
  worker job** (leaf→root across the ~40 dependent tables), preceded by a **full tenant data export**
  handed to the school, then crypto-shred. Guard with SA-P5 (retention window, reason, reversible until
  the window closes).
- **Testing:** an **isolation/integrity test** proves the purge removes exactly one tenant and leaves
  no orphan (the 11 pre-existing orphaned `audit_logs` found in the E2E delete are the cautionary tale).
- **Done when:** terminating a school exports its data, then deletes it in one transaction with zero
  orphans, provably, and only after the retention window.

---

## 4. Role hierarchy this plan assumes

**Platform (vendor) — above all schools:** SuperAdmin · Platform Support · Platform Billing ·
Platform Analyst. *(Today: one flat `platform_users` tier; SA0 starts the split, SA4 completes it.)*

**School (tenant) — created/entitled by SA2–SA3:** Owner Admin → Campus Admin → {Principal/Director
views, Admission Controller, Accountant/Finance, HR Manager, Examination Controller, Teacher
(Class/Subject), Front Desk/Staff, Transport/Hostel/Librarian} → Parent → Student. *(Already modelled
in the `Role` enum — the school side is fine; this plan only builds the platform side above it.)*

---

## 5. Edge cases the build must handle

- School stops paying → grace → auto-suspend → retain N days → export-or-purge (SA6 + SA7).
- School exceeds plan limit → block / prompt upgrade, atomically, never silently break (SA3).
- School leaves → full export handed over, then crypto-shred, provably, zero orphans (SA7, SA-P5).
- Subdomain collision / reserved word / rename (SA2 — the provisioning service already 409s on dup).
- Support agent enters a school → RLS-scoped session, stamped "acting as vendor" in the school's audit
  (SA5, SA-P8).
- Operator fired → disabled instantly, all sessions dead (SA0/SA4; guard already re-checks status).
- One school's load spikes → per-tenant metering so it can't starve the others (SA1 usage, SA3 limits).
- Multi-branch owner → decide multi-campus-in-one-tenant vs. separate tenants (SA2 — decision D2).

---

## 6. What this deliberately does NOT change

- **No tenant (school-side) data model changes** beyond the SA5 audit-actor field. Purely the platform
  layer above.
- **No new isolation mechanism.** It rides the existing RLS FORCE + BYPASSRLS split unchanged
  (SA-P4, SA-P8).
- **Reuses** `PlanTier`, the SMS-credit entitlement pattern, `password_reset_tokens`, the worker
  harness, and the platform auth stack — the phases give them a console and enforcement, they don't
  reinvent them.

---

## 7. How to tell it worked (acceptance — countable)

| Measure | Today | Target |
|---|---|---|
| Platform writes with an audit row | 0 | 100% (SA0) |
| Factors on the platform login | 1 (password) | 2 (SA0) |
| Fleet totals available without opening a school | ✗ | ✓, defined + snapshot-cheap (SA1) |
| Passwords typed into the console to onboard | 1 (`ownerPassword`) | 0 (SA2) |
| Plan limits enforced server-side | 0 | all (SA3) |
| Break-glass sessions that are RLS-scoped + audited | n/a | 100% (SA5) |
| Tenant hard-delete leaving orphans | n/a (manual) | 0, test-proven (SA7) |

---

## 8. Build gates every phase must clear *(added in the audit)*

- **RLS enrolment gate** — every new **platform** table (`platform_audit_logs`, `platform_stats`,
  plan/limit tables, billing tables) has **no `school_id`** and therefore **must be added to
  `NON_TENANT_TABLES` in `scripts/check-rls-coverage.mjs`**, or the tenant-enrolment check fails the
  build. The gate treats each addition as an explicit "this holds no tenant data" claim — correct here.
- **Route-coverage gate (IA3)** — every new `/platform/*` route must be reachable from `apps/web` or
  listed, or the gate fails.
- **Isolation suite** — SA5 break-glass gets a test proving an impersonated session is confined to the
  target tenant (SA-P8); SA7 gets a test proving a purge removes exactly one tenant with zero orphans.
- Standard gates unchanged: tenant-isolation suite, lint, strict typecheck, api+worker build.

---

## 9. Corrections folded in from the audit (2026-08-20)

| # | Severity | Correction | Where it landed |
|---|---|---|---|
| A | 🔴 Critical | Tenant hard-delete/crypto-shred **doesn't exist** — not a "reuse" | Lifted out of SA2 into **SA7** |
| B | 🟠 Major | `module_access` is per-user, not per-tenant | **SA3** now models entitlement separately (SMS-credit pattern) |
| C | 🟠 Major | Break-glass security model + audit-actor conflict | **SA-P8** + SA5 (RLS-scoped, `actingAsVendor` actor, decision D5) |
| D | 🟠 Major | MFA/roles sequenced behind the danger | Pulled forward into **SA0** |
| E | 🟡 Moderate | Fleet metrics undefined & un-costed | **SA1** metrics defined + nightly snapshot |
| F | 🟡 Moderate | CI gates unmentioned | New **§8**, referenced per phase |

---

## 10. Decisions to lock before the phases they gate (D2 · D4 locked 2026-08-25)

- **D1 — Vestigial `Role.PLATFORM_ADMIN`:** remove entirely, or keep as a deliberate alias? *(SA0.)*
- **D2 — Multi-branch schools: 🔒 LOCKED (2026-08-25, operator) → one tenant, many campuses** (the
  current model). Provision **separate tenants only when branches have different owners** (a franchise);
  a multi-branch chain under one owner is **ONE tenant, ONE bill**. This is a *provisioning-time
  judgement*, not new architecture. The fleet count counts **tenants** (the honest, billable number).
  Do **not** build a group/chain super-entity now — if chain-level reporting is ever wanted, add a
  lightweight optional `chain` **label** on `schools`, never a hierarchy. *(SA2.)*
- **D3 — Billing scope:** in-house invoicing vs. integrate a gateway (Stripe/local PK rails). *(SA6.)*
- **D4 — Break-glass default: 🔒 LOCKED (2026-08-25, operator) → ON, with notification + full
  guardrails, per-school opt-out.** Rationale: support in this market is hands-on and the customers are
  not technical, so opt-in-off would block support at the worst moment. Break-glass is available to the
  vendor but (1) **time-boxed / auto-expiring**, (2) **reason required**, (3) **RLS-scoped to one
  school** (SA-P8 — never BYPASSRLS), (4) written to the **school's own** `audit_logs` as acting-as-
  vendor, (5) the **owner is notified** when it happens. A privacy-sensitive school may switch **its**
  setting to require explicit per-incident approval (per-school `SchoolSettings`). *(SA5.)*
- **D5 — Vendor audit-actor shape:** nullable actor + `actingAsVendor` flag on `audit_logs`, vs a
  dedicated impersonation-audit record. *(SA5.)*

---

*This is a plan only. Nothing here is built yet; the Progress Tracker is not advanced until a phase
ships.*
