---
title: Fees — known gaps & flaws
type: register
status: open — running list, added to as flaws surface
created: 2026-08-03
scope: fee heads, fee structures, invoice generation
---

# Fees — known gaps & flaws

> Sibling of [[Attendance Gaps Register]]. Raised by the operator's question *"how is the fee of
> a class set, and what is the ideal choice?"* — answering it meant reading the fee-setup path
> end to end, which surfaced these. **Anything that changes what a family is billed is High.**

## How it works today (so the gaps below make sense)

`FeeHead` = *what* is charged (Tuition, Transport, Lab), school-wide.
`FeeStructure` = *the price of one head, for one class, in one year, at one frequency* — unique
on `[classId, feeHeadId, academicYearId, frequency]`.
`Discount` = per-student adjustment, the escape hatch for individual cases.

**A class's fee is therefore a SET of rows, not a number.** 9th's monthly bill is the sum of its
`MONTHLY` structures. `createBatch` writes one invoice per active student with one line per
applicable structure.

---

## F1 — A fee amount can never be corrected 🔴 **High**

`/fee-structures` exposes only `POST` and `GET`. There is **no `PATCH` and no `DELETE`**, the
unique key blocks inserting a corrected duplicate, and `isActive` exists on the model but
**nothing can toggle it** (`listStructures` merely filters on it).

So a mis-keyed amount — 30000 instead of 3000 — leaves that class **permanently mispriced with
no route out through any API**. Every subsequent invoice batch bills the wrong figure.

Same defect pattern as the subject rename on the Classes screen (create-and-read only), except
this one is money. **Fix:** `PATCH` + deactivate, guarded — if invoices already exist for that
class-month, changing the amount must not silently rewrite what was billed; either refuse and
require a new effective-dated row (see F4), or version it.

---

## F2 — Setup is O(classes × heads) by hand, with no rollover 🟠 **Med-High**

Ten classes and four heads is forty separate form submissions, one at a time. There is no bulk
apply ("Tuition 3,000 for 1st–5th"), and — more importantly — **no way to copy last year's plan
into this year**, which is an annual and unavoidable job for every school.

**Fix:** copy-a-year (with an optional across-the-board % rise) and a range/multi-class apply.
The Classes screen already proved the shape with copy-subjects-from-another-class.

---

## F3 — `ONE_TIME` and `ADMISSION` frequencies do nothing 🟠 **Med**

`FeeFrequency` has four values; `createBatch` computes
`applies = MONTHLY || (ANNUAL && month === annualMonth)`. **`ONE_TIME` and `ADMISSION` are never
applied.** A school that creates an admission-fee structure sees it accepted, stored, listed —
and silently ignored on every invoice run.

Same family as `HALF_DAY` in attendance (G6): an enum value nothing acts on. Worse here, because
it looks configured and bills nothing. **Fix:** implement them (admission fee charged on the
first invoice after enrolment; one-time charged once per student per structure) or remove them
from the enum.

---

## F4 — No effective dating on a fee 🟠 **Med**

`SalaryStructure` carries `effectiveFrom`; `FeeStructure` does not. Mid-year fee revisions are
normal, and with no dating there is no way to answer *"what did 9th cost in April?"* once a
price changes — and no way to change a price without implicitly restating history.

**Fix:** `effectiveFrom`, and pick the structure in force on the invoice's month. That also gives
F1 its safe correction path.

---

## F5 — `campusId` on a structure is unvalidated 🟡 **Low-Med**

`createStructure` stores the client-supplied `campusId` without checking it against the class's
own campus, so a structure can point at a campus its class does not belong to. The class already
implies the campus, making the column a denormalisation that can drift.

**Fix:** derive it from the class rather than accepting it, or assert they match.

---

## F6 — A duplicate structure returns 500, not 409 🟡 **Low-Med**

The unique index is the only thing stopping a second identical structure, and **`P2002` is not
mapped anywhere** (`all-exceptions.filter` has no Prisma-error handling). The operator sees
"Internal server error" for what is an ordinary "you already priced that".

Same shape as the guardian-email collision fixed on 2026-07-25 — that one was solved with a
pre-check. **Worth considering a general P2002 → 409 mapping** rather than a third pre-check.

---

## F7 — Nothing shows what a class costs 🟡 **Low-Med**

The fee total per class exists nowhere — not on Fees (a flat list of structure rows across the
school), not on the Classes screen. An operator adds the rows up by eye.

**Fix:** a per-class fee plan view — *"9th: Tuition 3,000 · Transport 1,000 · Lab 500 =
**Rs 4,500/month**"* — and surface the monthly total on the class workbench, which already
answers "who teaches this?" but says nothing about what it costs.

---

## Recommended shape (the answer to "what is the ideal choice?")

**Keep the head × class × year model** — it is correct, and it matches how these schools bill: a
per-class tuition plus optional heads that apply to some students and not others. Collapsing it
to a single "class fee" field cannot express Transport or Lab.

Add, in order of value:
1. **Copy-a-year + bulk apply** (F2) — the annual job, and the biggest time sink.
2. **Edit / deactivate with an invoice-aware guard** (F1) — the correctness hole.
3. **Effective dating** (F4) — makes 2 safe and answers historical questions.
4. **Per-class plan view with a monthly total** (F7).
5. **Make the dead frequencies work, or delete them** (F3).
6. Small correctness: F5, F6.
