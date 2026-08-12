# Finance Roles Plan (F0 — **COMPLETE**; F1 **DROPPED**)

**Raised by the operator, 2026-08-12**, from two questions: *"does an owner have time to do everything
he currently performs?"* and *"is there an accountant role — and is one accountant per campus the
best option?"*

## Where things stand today (measured, not assumed)

- `ACCOUNTANT` exists and is the fees workhorse: **21 fee endpoints** plus `/reports`, `/insights`.
  Academic performance is deliberately excluded — *"this is academic performance, not money"*.
- **An accountant is already necessarily per-campus, and cannot be school-wide.** `UsersService`
  refuses to create one without a campus (*"A campus is required for this role"*), and
  `restrictedCampusId()` returns `null` — unrestricted — **only** for `OWNER_ADMIN`; everyone else
  gets their own `campusId`, and a null one becomes `NO_CAMPUS` (the nil UUID), which matches
  nothing. Fail-closed.
- ⚠️ That fail-closed rule is scar tissue: `ADMISSION_CONTROLLER` used to be special-cased so a
  campus-less grant meant *school-wide*, which **silently handed over the whole school**. It was
  removed, and the role became a per-campus seat. **Any new school-wide role must not reintroduce
  that shape** — see F1.
- What does **not** exist: a one-per-campus rule for accountants (F0), and any school-wide finance
  seat that is not `OWNER_ADMIN` (F1).

## The problem F1 answers

**36 endpoints are `OWNER_ADMIN`-exclusive** (fees 14, users 8, setup 5, hr 4, exams 3, students 1,
comms 1). Most are annual setup and belong there. The recurring ones are the money exceptions —
`POST /discounts`, `/discounts/:id/revoke`, `/invoices/:id/waive`, `/payments/:id/reversals` — plus
every user create/edit/delete and access change.

Gating those on the owner is **a control, not an oversight**: someone who can waive an invoice and
reverse a payment can steal, which is the same reasoning that makes admitting a student
`ADMISSION_CONTROLLER`-only. The defect is not *that* they are gated, it is that **delegation is
all-or-nothing**. A head-office finance person or an auditor who must see every campus has exactly
one option today: `OWNER_ADMIN` — which also hands over user management and fee structures.

⚠️ **The failure mode to design against is not clicks, it is the owner sharing their password.**
At that point every audit row says "owner" for actions the owner did not take, and the segregation
of duties is gone *while still looking intact on the permission matrix*.

---

## F0 — One accountant per campus — **SHIPPED 2026-08-12**

**What the operator asked for**, and the mechanism already exists: `SOLE_CAMPUS_SEAT_ROLES`
currently holds `CAMPUS_ADMIN` and `ADMISSION_CONTROLLER`, enforced by `assertSoleCampusSeat()` on
both create and role-update, with a 409 naming the incumbent's email.

**Work**
1. Add `Role.ACCOUNTANT` to `SOLE_CAMPUS_SEAT_ROLES` (`users.service.ts`).
2. Add a `SEAT_LABEL` entry for it, and **replace the message ternary with a `SEAT_LABEL` lookup** —
   it currently hard-codes two roles and a third would silently get the campus-admin wording.
3. Message must name the remedy, matching the admission-officer precedent: *"This campus already has
   an accountant (email). Remove or reassign them before adding another."*

**Tests**
- Integration: second `ACCOUNTANT` on the same campus → **409**, on create *and* on role-update;
  an accountant on a *different* campus still succeeds (otherwise the rule could be "one per school"
  and pass).
- Probe by removing the role from the list — both new cases must fail.

**⚠️ The plan under-scoped this, and the code said so.** The comment above
`SOLE_CAMPUS_SEAT_ROLES` records that the rule is enforced *"in the service on every write path AND
by a partial unique index per role in 02_partial_uniques.sql"*. A one-line list change would have
left the seat half-enforced. Shipped with **both**: the service check and
`users_one_accountant_per_campus`, partial on `deleted_at IS NULL` so a departed accountant frees the
seat immediately.

**⚠️ The probe proved the two layers do different jobs.** Removing `ACCOUNTANT` from
`SOLE_CAMPUS_SEAT_ROLES` did not let the second accountant through — the case failed with **500**
instead of 201, because the index refuses the row on its own. **The index is the safety (a check is
read-then-write, so two owners assigning simultaneously both pass it); the service check is what
turns that into a 409 naming the incumbent rather than a stack trace.** Recorded in the test.

**⚠️ Existing tenants are not retro-checked — but the index is stricter than the check.**
`assertSoleCampusSeat` only runs on a write, so a school that already has two accountants on one
campus keeps them until somebody edits one. `CREATE UNIQUE INDEX`, however, **fails outright** while
both rows exist, taking `db:setup` down with it. That is the intended order of events: a duplicate
seat gets resolved deliberately by a human, not silently by a migration picking a winner. The demo
tenant has zero accountants, so nothing to migrate here.

**✅ The UI follow-up shipped straight after, on operator instruction — F0b below.**

**Superseded note — existing tenants:** `assertSoleCampusSeat` runs on write, so a tenant that
already has two accountants on one campus keeps them until somebody edits one. The demo tenant has
**zero** accountants, so nothing to migrate here; a real tenant is an open question — see Decisions.

**⚠️ State the operational cost plainly, because it is real.** `POST /fees/invoices/:id/payments` —
taking money at the counter — admits only `OWNER_ADMIN` and `ACCOUNTANT`. One accountant per campus
therefore means **exactly one non-owner person per campus can accept a payment**. On the first days
of a fee month that is a single queue. The owner can collect too, which is the escape valve; if that
proves insufficient the answer is a separate `CASHIER` seat (collect-only, many per campus), not
loosening this rule. **Operator's decision, recorded 2026-08-12: one per campus.**

---

## F0b — The campuses screen names the holder instead of offering the seat — **SHIPPED 2026-08-12**

The screen did not know seats existed: it listed **"Campus Admins"** (plural), always offered every
role in the add form — defaulting to `CAMPUS_ADMIN`, the one choice guaranteed to 409 on a
configured campus — and let the server deliver the bad news. **Offering an action the API will
refuse is the defect this project keeps correcting**; it had simply never been fixed for the two
seats that predate the accountant.

**What it does now**
- Seat groups are **singular** (`Campus admin`, `Admission officer`, `Accountant`) and render
  **whether or not they are filled**. A filled seat shows its holder; an empty one is not hidden
  the way empty non-seat groups are — it is a gap worth naming, so it says what the campus cannot
  currently do: *"Not assigned. Nobody but an owner can take a fee payment here."*
- The add form **disables a taken seat and names who holds it** (`Accountant — held by x@y.pk`)
  rather than hiding the option, which would just look like a bug. It defaults to the first role
  that can actually be created, and the submit button is disabled with the reason spelled out.

**⚠️ It immediately surfaced a real fact about the operator's own tenant:** *neither* campus has
an accountant, so today nobody but the owner can take a fee payment at either one. The old screen
rendered nothing at all for an empty seat, so that was invisible — **the absence of a row was
carrying information nobody could see.**

**⚠️ F0 had already broken a Playwright spec and nobody noticed, because only jest was re-run.**
`campuses.spec` chose `ACCOUNTANT` for its inline-add case with the comment *"deliberately not
CAMPUS_ADMIN: that is a seat role"* — true when written, false the moment F0 shipped. It kept
passing only because the E2E campus happened to have no accountant and the spec cleaned up after
itself; one failed cleanup and every later run would have failed. Now uses `TEACHER`, the only role
a campus can hold many of. **A comment that justifies a choice by a rule elsewhere goes stale
silently when that rule moves — and a backend change that alters an invariant needs the browser
suite run, not just the API one.**

**Tests** — one new Playwright case, probed in **both** halves independently: stop disabling the
taken option → fails; hide empty seats again → fails. Verified in a browser as well, which is where
the default-role behaviour was confirmed.

---

## F1 — `FINANCE_VIEWER` — **DROPPED 2026-08-12, operator's call**

> *"no need of F1 — the data is already being seen by owner admin on his dashboard."*

The seat was proposed for a head-office finance person or auditor who needs every campus without
owner rights. **The need it addressed is already met**: the owner's dashboard carries the
school-wide financial view, and the owner is the person who wants it. Building a new role, a
migration, matrix rows and a read-only UI to serve nobody would have been the exact mistake this
project keeps naming — *an endpoint nobody calls is not a shipped feature*.

⚠️ **The underlying gap is real but unfelt, and that is the whole point.** Delegation of the 36
owner-only endpoints remains all-or-nothing: anyone who needs a school-wide financial view without
owner rights still has to be made an `OWNER_ADMIN`. Revisit **only** when a real school asks — the
signal is an operator wanting to grant `OWNER_ADMIN` purely so somebody can *see* both campuses.

<details><summary>Original F1 design, kept for whoever revisits it</summary>

### `FINANCE_VIEWER`: a school-wide, read-only finance seat

A person who can see collections, defaulters and reconciliation **across every campus** and change
**nothing**. This is the seat that today forces an owner grant.

**Shape — deliberately mirroring `OWNER_ADMIN`, not `ADMISSION_CONTROLLER`**
- New `Role.FINANCE_VIEWER` in the Prisma enum (migration).
- `restrictedCampusId()` returns `null` for it. ⚠️ **The campus-less state must be the role's
  definition, enforced at creation like `OWNER_ADMIN` (*"is school-wide — do not set a campus"*),
  never a fallback for a missing value.** The `ADMISSION_CONTROLLER` incident was caused by a
  *misconfiguration* widening into school-wide access; here school-wide is the declared intent and a
  campus on the row is rejected outright.
- Added to the **read** `@Roles` lists only: fee heads/structures/late-fee reads, invoice + payment
  lists and detail, `/reports`, `/insights`. Never to a write route.

**⚠️ Read-only has to be enforced, not intended.** A future write endpoint that lists the role would
silently grant school-wide write. Guard: a test that enumerates **every non-GET route from the live
Nest router** and asserts a `FINANCE_VIEWER` session gets 403 on all of them. That is the same
"drive the real router" technique `matrix-conformance` already uses, and it fails the moment someone
adds the role to a write route.

**Privacy — decide before building.** Defaulter reports name children and what their families owe.
School-wide, read-only, no campus boundary. That is exactly the report the seat exists for, and also
the most sensitive list in the product. It should be **MFA-required** (join `MFA_REQUIRED_ROLES`,
which already holds `OWNER_ADMIN` and `ACCOUNTANT`) and fully audited on read if we decide read
auditing is warranted.

**Frontend**
- `apps/web/lib/roles.ts`: role union, `ROLE_INFO` entry, landing path, nav entries (Dashboard,
  Reports, Fees, Payment submissions).
- ⚠️ **The Fees screen must hide every write control for this role** — Generate, Collect, Waive.
  Rendering a button the API will 403 is *the* recurring defect in this project (the system
  instructing somebody to do a thing it would then block). Nav-level gating is not enough; the
  controls live inside a page the role can legitimately open.
- The user-creation form must not ask for a campus when this role is chosen, and must reject one.

---

</details>

## F2 — Matrix, gates, brain

- **Both roles get matrix rows.** `FINANCE_VIEWER` joins the `MatrixRole` union **and
  `MATRIX_ROLES`**, with a seeded session. ⚠️ Adding it to the union alone is the `HR_MANAGER` drift
  the matrix file explicitly warns about — *"Listing it without seeding it would be the drift §23 was
  softened for"*. Every existing row's deny side must then hold for it, which is the real work and
  the whole point: **a route with no row is unmeasured, not safe.**
- Full gates: unit · integration · isolation · Playwright · lint · typechecks · builds.
- Brain: Key Decisions (why school-wide is a declared role property and not a fallback; why one
  accountant per campus and what it costs at the counter), Progress Tracker, and the §23 role table.

---

## Decisions needed before F1 starts

1. **Role name.** `FINANCE_VIEWER` (says read-only), vs `AUDITOR` (says why), vs `FINANCE_MANAGER`
   (⚠️ implies write — would mislead). Recommend `FINANCE_VIEWER`.
2. **Existing tenants with two accountants on one campus.** Leave them until edited (simplest,
   silent), or ship a one-off report listing violations so they can be resolved deliberately?
   Recommend the report — the pilot has not started, so the cost is near zero and the alternative is
   discovering it during a support call.
3. **Should `FINANCE_VIEWER` see the payment-submissions queue?** It is a read screen, but it is also
   where verification happens; showing it read-only may invite "why can't I approve this?".
4. **Is F1 wanted at all yet?** F0 is small and was explicitly requested. F1 is a new role touching
   authz, the matrix and the UI — worth doing only if a real school actually has a head-office
   finance person or auditor. **If every pilot school is single-campus, F1 has no user.**
