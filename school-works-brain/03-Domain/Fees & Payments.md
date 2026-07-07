---
title: Fees & Payments
type: domain
updated: 2026-07-06
status: next (M4)
---

# Fees & Payments

> [!warning] Not built yet — **M4 (next)**. The largest, most correctness-critical module. This note is the spec map.

## Structures & invoices (§12)
- `FeeStructure` per (school, campus, class, feeHead, year): amount + `frequency (MONTHLY|ANNUAL|ONE_TIME|ADMISSION)`. Editing never mutates already-generated invoices.
- **Invoice batch** `POST /fees/invoice-batches {classId, month, year}` — **idempotent** on `[schoolId, classId, month, year]` (duplicate → existing batch, 200, `alreadyExists`). Queued job creates one invoice per ACTIVE enrollment; per-student partial unique prevents doubles. Mid-month admissions pro-rated (`midMonthProration`, default FULL).

## Discounts, fines, advances
- **Discount** (PERCENT|FIXED, per head or ALL, validity, approver). Sibling discount auto-applied to 2nd+ sibling. Applied **at generation** as negative line items (transparent on the bill). FIXED after PERCENT; capped at 100% of the head.
- **Fines:** `LateFeePolicy` (grace, FLAT|PER_DAY, max). Nightly `mark-overdue` sets OVERDUE and appends a single FINE line.
- **Advances (`GuardianCredit`):** parent prepaid ledger, auto-applied oldest-first.

## Payments (the crown jewel of correctness)
`POST /fees/invoices/:id/payments` requires **`Idempotency-Key`**. Inside **one serializable tx**: lock the invoice (`SELECT … FOR UPDATE`), validate `amountPaid ≤ remaining` (over → `OVERPAYMENT_USE_ADVANCE`), insert `FeePayment` with **gap-free per-school `receiptNo`**, recompute `paidAmount`/status, enqueue receipt SMS. `transactionRef` mandatory for non-CASH.
- **Payments are immutable.** Corrections via `PaymentReversal` (receipt `RV-`), **OWNER_ADMIN only**.
- **Waivers:** `WAIVED` by OWNER_ADMIN + reason, via a WAIVER line item (never editing totals).

## Invariants (DB + nightly `fee-integrity-check`)
`totalAmount = Σ items.amount`; `paidAmount = Σ payments − Σ reversals`; status derives strictly from amounts + due date. Mismatch pages on-call.

**Status machine:** `PENDING → PARTIAL → PAID`; `→ OVERDUE` (job) `→` back on payment; `→ WAIVED` (terminal); `PAID` terminal except reversal reopening.

**Source:** [[03-database-schema-erd]], blueprint §12. Idempotency & concurrency: [[API Contract]].
**Implementation status:** ⏳ **M4 next** → [[Progress Tracker]]. Gate: collect-fee E2E + `fee-integrity-check` clean.
