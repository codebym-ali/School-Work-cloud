# Fees Billing Plan (B0–B3)

**Raised by the operator, 2026-08-12**, from working the fee screens: *"I have to visit every class
separately… when the fee controller collects, he should just select the student and hit generate…
until that student has a sibling, then the discount applies."*

**Status:** ✅ **COMPLETE — B0–B3 shipped 2026-08-12/13.** The three open decisions were taken as
recommended and are flagged in the code where they bite (§Decisions taken).
⚠️ The first version of this plan had **four defects of its own**; they are folded in below as
invariants. See §What the audit changed.

## What already works, and must not be disturbed

The hard parts of fee modelling are done and correct:

- **Effective-dated prices.** A change creates a new row; the old one survives, so an issued invoice
  keeps the figure it was computed from.
- **Line items are frozen at billing time** — the invoice is a snapshot, not a live join.
- **Discounts render as negative line items**, so a family sees *why* the bill is lower.
- **Immutability where money is involved**: no delete for invoices or batches, and a structure
  cannot be edited once anything has been billed from it.
- **`Discount` is richer than it looks**: `validFrom`/`validTo`, `feeHeadId` (null = all heads),
  `reason`, `approvedById`, `status`. Any discount work should reuse it rather than invent a parallel.

Nothing in B0–B3 changes any of that.

---

## Design invariants

**J1 · The DATABASE enforces one invoice per student per period, not application code.**
A read-then-write check is not a constraint under concurrency — the accountant seat proved that
this week, where removing the service check still failed because the index held. For money the
constraint is not optional.

**J2 · Every new write path carries the authz the old one had.** `createBatch` does
`access.assert('fees.invoicing')` **and** `assertCampusAccess(user, klass.campusId)`. A new route
that quietly omits either is the single most repeated defect in this project.

**J3 · Generation is idempotent against a double-click.** `pay` and `deposit` already require an
`Idempotency-Key`; `createBatch` does not, because it leaned on the index. A cashier pressing
"Generate" twice on one child is exactly the double-submit case.

**J4 · The invoice carries WHY, and that is what removes the need to historise policy.** A frozen
line item reading *"Sibling discount — 2nd child — 20%"* answers the question a school actually
asks ("why is this family's bill lower?") without effective-dating the setting itself.

**J5 · "Charge once" is scoped per ENROLMENT, not per year.** Admission fee must not be re-charged
when a child is promoted.

**J6 · A tightened constraint is checked against live data before it ships.** `CREATE UNIQUE INDEX`
fails outright on existing duplicates — and taking `db:setup` down is the *good* outcome versus a
migration silently picking a winner.

---

## B0 — Make the invoice key real *(must be first)* — **SHIPPED**

⚠️ **This phase exists because the first draft of this plan would have shipped a double-billing
hole.** The current index is:

```sql
CREATE UNIQUE INDEX fee_invoices_one_batch_per_student_month
  ON fee_invoices (school_id, student_id, month, year)
  WHERE batch_id IS NOT NULL;          -- ← partial
```

Per-student invoices (B1) carry **no batch**, so they land in the uncovered half: a child could be
billed once by the batch and once ad-hoc, and the database would not object. This is the same
NULL/partial-index trap the codebase already documents for cover assignments — the comment eleven
lines below this very index cites `fee_invoices.psid` relying on distinct NULLs.

**Work**
1. Decide what `month IS NULL` means (see Decisions). Everything else follows from it.
2. Replace the partial index with one that covers **both** origins — batch and ad-hoc — for
   periodic invoices.
3. Keep the `psid` unique as is; it is unrelated.

**Acceptance**
- Two invoices for the same (student, month, year) are refused **by the database**, whichever path
  created them — proven by inserting directly, not through the service.
- The existing batch path still generates exactly as before (regression).

**⚠️ Before shipping:** count duplicates on every live tenant. Today all 36 invoices carry both a
batch and a month, so the tightening would succeed — **that is luck, not safety** (J6).

---

## B1 — Invoice one student — **SHIPPED**

The flow the operator described: the cashier opens a child, presses generate, collects. Today the
only path is `POST /fees/invoice-batches` (class + month + year), and **a (class, month, year) can
be billed once ever** — so a child admitted after the batch ran cannot be invoiced at all. That is
not a convenience gap; mid-session admissions are normal.

**Work**
- `POST /fees/invoices` — one student, one period. Reuses the same resolution as `createBatch`
  (structures in force → line items → discounts → total) rather than a second copy of the pricing
  logic, which would drift.
- `access.assert('fees.invoicing')` + `assertCampusAccess` off the **student's** class (J2).
- Requires an `Idempotency-Key` (J3).
- Audited: who billed whom, for what period.
- UI: a **Generate invoice** action on the student's fee view when the current period has none.

**Acceptance**
- A student admitted *after* their class's batch ran can be billed.
- The same request twice produces **one** invoice — proven both by the idempotency key and, with
  the key removed, by the B0 index (two independent guarantees, as with the accountant seat).
- A campus-bound accountant cannot invoice a student of another campus.
- Batch generation is unchanged.

---

### What shipped, and what it caught

- **B0** replaced the partial index with `fee_invoices_one_per_student_month`
  (`WHERE month IS NOT NULL`). Probed by restoring the old `WHERE batch_id IS NOT NULL` form: the
  batch-less duplicate case fails, and only it. Pre-flight found zero duplicates on live data,
  which made the tightening safe **today** — checked, not assumed.
- **B1** extracted `buildInvoice()` so the batch and the per-student route share **one pricing
  path**. A second copy would drift across three rules that must agree — the effective-dated price
  lookup, the ANNUAL anchor month, and discount application — and the only thing worse than billing
  wrongly is billing two different ways depending on which button was pressed.
- ⚠️ **The authz was widened, and caught on review.** The first draft gave `POST /fees/invoices`
  `OWNER_ADMIN / CAMPUS_ADMIN / ACCOUNTANT` — wider than the batch route it parallels, where a
  campus admin can read fees but has never created them. Invariant J2 failing on its own author
  within the hour of being written down.
- ⚠️ **A test failed for a fixture reason that looked like a product bug.** The new student was
  admitted with a guardian phone another case already used, so `admit` returned no `studentId` and
  the route 400'd on *"studentId must be a UUID"*. The test now asserts the admission succeeded
  first, so a broken fixture can never again masquerade as broken billing.

---

## B2 — Sibling discount that actually applies — **SHIPPED**

`siblingDiscountPercent` exists in the settings schema, the DTO, the API types **and the settings
screen** — and is read by **nothing**. An owner can set 20%, get a success toast, and no invoice is
ever a rupee cheaper. It silently overcharges families, and the school learns from a parent rather
than an error.

**Siblings are derivable from data already held**: `StudentGuardian` has exactly one `isPrimary`
per student, and the CSV import deliberately links siblings to one parent account by phone. So
*siblings = students sharing a primary parent*.

**Work**
- At invoice resolution, rank the student among their **currently enrolled** siblings; rank ≥ 2
  gets `siblingDiscountPercent` off (scope per Decisions).
- Emit it as a negative line item reading *"Sibling discount — 2nd child — 20%"* (J4).
- ⚠️ Computed at issue time and **never retroactive**: a sibling enrolling in March does not
  change February's invoice. Say so in the UI next to the setting, or it becomes a support call.

**Acceptance**
- Two children of one primary parent: the first pays full, the second is discounted.
- Unrelated students are unaffected.
- The discount is **visible with its reason** on the invoice, not folded into the total.
- Setting it to 0 disables it (and is the current default, so existing tenants see no change).
- Probe: set the percentage to 0 and the discount line must disappear — a test that passes at both
  0% and 20% is testing nothing.

---

## B3 — Charge-once heads (admission, one-time) — **SHIPPED**

`FeeFrequency` has `ADMISSION` and `ONE_TIME`, but billing asks only *"is it this month?"*:

```ts
const applies = s.frequency === 'MONTHLY' || (s.frequency === 'ANNUAL' && dto.month === annualMonth);
```

Anything else is silently skipped, and the UI does not even offer them. **So the admission fee —
one of the largest charges in a Pakistani private school — cannot be billed through the system**,
and gets collected off-book, which is where a fee system loses its integrity.

**Work**
- Bill a charge-once head when the student has **never been charged it for this enrolment** (J5),
  rather than inferring from the month.
- Offer both frequencies in the fee-plan UI.

**Acceptance**
- Admission fee appears on a new student's first invoice and **never again** — including after
  promotion to the next class, which is the case a per-year rule would get wrong.
- A student who re-enrols after leaving is charged it again (new enrolment) — **or is not**; see
  Decisions.

---

## Decisions taken (assumed as recommended, 2026-08-13)

Each is flagged in the code at the point it decides money, so reversing one is a local edit rather
than an archaeology exercise.

1. **`month IS NULL`** — periodic invoices always carry a month; charge-once items ride on one
   rather than inventing month-less invoices. The B0 index says so in its `WHERE`.
2. **Sibling ordering** — admission order (`Student.createdAt`, tie-broken by GR number) among
   **currently enrolled** siblings. ⚠️ So the rank MOVES: if the eldest leaves, the next child stops
   being discounted on future invoices, while issued ones keep what they were charged. The
   alternative — a rank remembered for ever — cannot be explained from the data a year later.
3. **Scope** — the sibling percentage applies to **all heads**, because the setting is a single
   percentage with no head scope; narrowing it to tuition would invent a rule nobody configured.
   `Discount.feeHeadId` already supports per-head concessions if a school wants one.
4. **Re-enrolment** — admission fee is per **enrolment**, so a child who leaves and returns is
   charged again. A school treating it as once-per-child-for-life needs the scope widened to the
   student, not a special case.

## Original decision list (superseded)

1. **What does `month IS NULL` mean on an invoice?** Nothing creates one today (all 36 have a
   month), so this is a free choice — and it decides B0's index shape. Recommend: *periodic
   invoices always carry a month; charge-once items ride on a periodic invoice rather than
   inventing month-less ones.* Simplest, and keeps one key.
2. **Sibling ordering.** Rank by admission date among currently-enrolled siblings (recommended), or
   by age? ⚠️ And when the eldest withdraws, does the next child lose the discount going forward?
   Recommend yes — the alternative is a rank that is remembered forever and cannot be explained
   from the data.
3. **Does the sibling discount apply to all heads or tuition only?** `Discount.feeHeadId` already
   supports either. Most schools discount tuition only; discounting transport is unusual.
4. **Re-enrolment and admission fee** — charged again, or once per child for life?

## What B2/B3 caught

- ✅ **A guard was doing its job, and retiring it was the last step.** `fee-setup.service` refused
  `ADMISSION`/`ONE_TIME` structures outright: *"Invoicing does not yet charge ADMISSION fees, so
  this would never appear on a bill."* **That refusal is why the gap was discoverable rather than
  silent** — storing a price that looks configured and charges nothing, for ever, is worse than
  saying no. B3 removed the reason, so the guard went with it; the comment stays because the
  *pattern* is worth copying.
- ⚠️ **An existing test asserted the opposite and was rewritten, not deleted.** *"refuses a
  frequency that invoicing would never charge"* encoded the old decision correctly. When the
  decision moved, the case became *"accepts a charge-once frequency now that invoicing bills it"* —
  a test that encodes a decision is evidence.
- ⚠️ **The first sibling fixture built the wrong family.** Two `CREATE` guardians with one phone
  make two parents, not siblings, and the rank is computed from the shared PRIMARY guardian — so
  the discount never appeared and it read as *"the feature does not work"*. The helper now LINKs the
  second child to the first child's parent.
- **Two attendance failures during the final run were pre-existing and proven so**, by stashing
  every change and re-running: the same two fail on a clean tree. They are time-of-day sensitive
  (a closure created for the UTC date is not "today" once Karachi has rolled over). **Not caused by
  this work, and not fixed by it** — worth their own ticket.

## Sequencing and gates

**B0 → B1 → B2 → B3.** B0 first is not stylistic: B1 creates the invoices the current index does
not cover. B2 and B3 are independent of each other and could swap.

Each phase: unit · integration · isolation · Playwright where it has UI · lints · typechecks ·
builds, plus a probe that breaks the rule and proves the test fails. Brain updated with the phase,
not after it.
