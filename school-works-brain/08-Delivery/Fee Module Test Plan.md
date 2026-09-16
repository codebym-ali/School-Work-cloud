---
title: Fee Module Test Plan
type: test-plan
updated: 2026-09-15
status: written; browser cases automated in test/e2e/fee-lifecycle.spec.ts
---

# Fee Module Test Plan

Voucher to receipt, every payment method, and the corrections. Written as cases a person could run
by hand, with the automation that covers each one named beside it — so a gap is visible rather than
assumed.

## Scope

`fee-heads → fee-structures → invoice batch → collection (6 methods + advance) → claims →
reconciliation → reversal / waiver → defaulters → integrity`.

⚠️ **Out of scope, deliberately:** the aggregator webhook (Kuickpay/1Bill/1LINK). It is a *seam*, not
an integration — with no `AGGREGATOR_WEBHOOK_HMAC_SECRET` configured it fails closed by design, and
testing it end-to-end would mean testing a stub against itself.

## Where each layer is tested, and why

| Layer | Home | Why there |
|---|---|---|
| Money arithmetic, idempotency, locking, RLS | `test/integration/fees.e2e-spec.ts` | Needs a real Postgres and concurrent requests; a browser cannot express a race |
| Matching rules | `apps/api/.../reconciliation.service.spec.ts` | Pure functions — cheapest and most precise as units |
| What a cashier can actually reach and do | `test/e2e/*.spec.ts` | Only a browser proves the dropdown offers what the server accepts |

⚠️ **The browser layer exists to catch a specific class of bug this project keeps finding: a UI that
is stricter, or laxer, than the API behind it.** CSV import, `/my-attendance` and `/my-leaves` were
each unreachable by the only role allowed to use them. A green API test proves nothing about that.

---

## FEE-1 · Setup

| ID | Case | Expected | Covered by |
|---|---|---|---|
| FEE-1.1 | Create a fee head | Appears in the head list | `fees.e2e-spec` |
| FEE-1.2 | Price a class for a year (structure) | Monthly total shows on Fees and on the class workbench | `fee-plan.spec` (browser) |
| FEE-1.3 | Edit a structure after invoices exist | Existing invoices unchanged — editing prices the *future* | `fees.e2e-spec` |
| FEE-1.4 | Delete a head still referenced | Refused, naming what references it | `fees.e2e-spec` |
| FEE-1.5 | A class with no structure | Generate is disabled; no empty batch is possible | **FEE-LC-1** (browser) |

## FEE-2 · Billing

| ID | Case | Expected | Covered by |
|---|---|---|---|
| FEE-2.1 | Generate a monthly batch | One invoice per ACTIVE enrolment, status PENDING | `fees.e2e-spec`, **FEE-LC-1** |
| FEE-2.2 | Generate the same batch twice | Idempotent — returns the existing batch, no duplicates | `fees.e2e-spec` |
| FEE-2.3 | Discount applied | Appears as a **negative line item**, not a quietly reduced total | `fees.e2e-spec` |
| FEE-2.4 | Student admitted after the class was billed | Single-student invoice still possible | `fees.e2e-spec` |

## FEE-3 · Collection — every method

The core of this plan. ⚠️ **The dropdown must offer exactly what the server accepts**: a method shown
but rejected is a trap, and a method accepted but hidden is a capability deleted.

| ID | Method | Case | Expected | Covered by |
|---|---|---|---|---|
| FEE-3.1 | CASH | Collect full amount | PAID · receipt number issued · no reference required | `fees.e2e-spec`, **FEE-LC-2** |
| FEE-3.2 | CASH | Partial, then the rest | PARTIAL → PAID; `paidAmount` accumulates | `fees.e2e-spec` |
| FEE-3.3 | BANK_TRANSFER | Collect with reference | PAID; reference stored | **FEE-LC-3** |
| FEE-3.4 | BANK_TRANSFER | Collect **without** reference | Refused — `transactionRef required for non-cash` | **FEE-LC-4** |
| FEE-3.5 | EASYPAISA | Collect with reference | PAID | **FEE-LC-3** |
| FEE-3.6 | JAZZCASH | Collect with reference | PAID | **FEE-LC-3** |
| FEE-3.7 | CARD | Collect with reference | PAID | **FEE-LC-3** |
| FEE-3.8 | CHEQUE | Record at the counter | ✅ **A submission, not a receipt** — clears first | **FEE-LC-12** + `fees.e2e-spec` |
| FEE-3.9 | any | Method the school does **not** accept | 422, naming what it does accept | `fees.e2e-spec` |
| FEE-3.10 | any | Amount above remaining | 422 `OVERPAYMENT_USE_ADVANCE` | `fees.e2e-spec` |
| FEE-3.11 | any | Same `Idempotency-Key` replayed | One receipt, not two | `fees.e2e-spec` |
| FEE-3.12 | ADVANCE | Guardian credit auto-applied at generation | `FeePayment` with method ADVANCE + negative credit | `fees.e2e-spec` |
| FEE-3.13 | any | Proof REQUIRED, non-cash without proof | Refused — but cash is not | `fees.e2e-spec` |

✅ **FEE-3.8 was a gap and is now fixed (2026-09-15).** A cheque is recorded as a *submission* that
clears after the school's own holding period; verifying it then mints the receipt. This implements
**D3**, which the Fee Submission Plan recorded as a decision to confirm and which was never built —
`chequeClearingDays` sat in settings, read by nothing. ⚠️ `pay()` refuses CHEQUE at the API, not just
in the UI: a display gate over an open endpoint is not a rule.

## FEE-4 · Claims — money someone *says* arrived

| ID | Case | Expected | Covered by |
|---|---|---|---|
| FEE-4.1 | Queue is reachable and filters by state | PENDING / VERIFIED / REJECTED | `fee-claims.spec` |
| FEE-4.2 | A claim changes nothing financial | Invoice untouched, no receipt, not in collections | `fee-claims.spec` |
| FEE-4.3 | Verify a claim | Runs the **ordinary payment path** → receipt number, invoice recomputed | **FEE-LC-5** |
| FEE-4.4 | Verify twice (double-click) | One receipt — key is `claim:<id>`, not random | `fees.e2e-spec` shape |
| FEE-4.5 | Reject with a reason | REJECTED, reason stored, nothing financial moves | **FEE-LC-6** |
| FEE-4.6 | Duplicate transaction reference | 409, naming the existing claim's state | **FEE-LC-7** |
| FEE-4.7 | Guardian submits via signed link | Claim created; page shows first name only, never "paid" | `fee-guardian-link.spec` |
| FEE-4.8 | Proof upload from the browser | Stored, served back via a short-lived link | `fee-proof.spec` |
| FEE-4.9 | Pending count matches the queue | Dashboard chip agrees with the list | `fee-claims.spec` |

## FEE-5 · Reconciliation *(new)*

| ID | Case | Expected | Covered by |
|---|---|---|---|
| FEE-5.1 | Upload a statement, preview | Parsed rows shown; **nothing stored** | **FEE-LC-8** |
| FEE-5.2 | Exact reference | Matched, labelled "Reference matches" | unit + **FEE-LC-8** |
| FEE-5.3 | Reference inside narration | Matched, "Reference in narration" | unit |
| FEE-5.4 | Amount + date only | ⚠️ **Not matched** — two families, same fee, same morning | unit |
| FEE-5.5 | Re-upload the same statement | Stored count 0; no duplicate lines | **FEE-LC-9** |
| FEE-5.6 | Credits nothing claims | Listed under "money we can't explain" | **FEE-LC-9** |
| FEE-5.7 | Import cannot verify | No receipt number appears from importing | **FEE-LC-8** |

## FEE-6 · Corrections

| ID | Case | Expected | Covered by |
|---|---|---|---|
| FEE-6.1 | Reverse a payment (owner) | `RV-` receipt; invoice recomputed; original row still there — and shown struck through on the profile | `fees.e2e-spec` · UI on the student fee card (2026-09-16) |
| FEE-6.2 | Accountant attempts a reversal | Refused — owner only (403); the owner still can | ✅ `fees.e2e-spec` |
| FEE-6.3 | Waive an invoice with a reason | WAIVED via a WAIVER **line item**, totals never edited; no reason → refused; a waived invoice refuses payment | ✅ `fees.e2e-spec` |
| FEE-6.4 | Pay a WAIVED or PAID invoice | 409 | `fees.e2e-spec` |
| FEE-6.5 | Receipt for a reversed payment | Refused | `fees.e2e-spec` |
| FEE-6.6 | Reversal double-clicked | One reversal; the second is a clean 409, never a 500 | ✅ `fees.e2e-spec` |
| FEE-6.7 | A student's payments | Only that student's, however many the school has; campus scope still applies | ✅ `fees.e2e-spec` + `campus-scope` |

## FEE-7 · Downstream

| ID | Case | Expected | Covered by |
|---|---|---|---|
| FEE-7.1 | Defaulters list | Unpaid past due; a paid child leaves it | ✅ `fees.e2e-spec` |
| FEE-7.2 | Nightly mark-overdue | OVERDUE + **one** FINE line, per policy | `maintenance.e2e-spec` |
| FEE-7.3 | Integrity check | `total = Σ items`, `paid = Σ payments − Σ reversals` | `fees.e2e-spec` |
| FEE-7.4 | Receipt SMS | Queued on payment | `fees.e2e-spec` |

## FEE-8 · Access

| ID | Case | Expected | Covered by |
|---|---|---|---|
| FEE-8.1 | Accountant collects | Allowed | **FEE-LC-2** |
| FEE-8.2 | Campus-bound cashier, other campus | Refused | `fees.e2e-spec` |
| FEE-8.3 | Teacher opens Fees | Not authorised; no nav entry | `home-roles.spec` shape |
| FEE-8.4 | Campus admin sees claims but cannot verify | Read yes, decide no | **FEE-LC-10** |

---

## Known gaps this plan surfaces

1. ~~Cheque clears instantly~~ — **fixed 2026-09-15** (D3). See FEE-3.8.
2. ~~Waiver has no test~~ — **closed 2026-09-15**: three cases, including that a waiver without a
   reason is refused and that a waived invoice refuses payment.
3. ~~Defaulters list untested~~ — **closed 2026-09-15**. ⚠️ Two fixture traps found writing it, both
   of which present as "the endpoint is broken": a future-dated invoice can never be a defaulter
   (`dueDate < now`), and a month outside the academic year generates no invoice at all.
4. ~~Reversal role boundary untested~~ — **closed 2026-09-15**: an accountant collects (201) and is
   refused a reversal (403), while the owner still can.

⚠️ **Remaining:** the reconciliation matcher's thresholds are uncalibrated — it shipped without
any real bank export. Structurally sound and unit-tested, but the ±2-day window and the 4-character
minimum reference are reasoning, not observation. One real HBL or Meezan CSV would settle it.
