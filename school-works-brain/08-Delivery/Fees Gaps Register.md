---
title: Fees — known gaps & flaws
type: register
status: F1–F9 CLOSED · F8 closed 2026-08-04 (and reclassified Low-Med → High on inspection)
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

## F1 — A fee amount can never be corrected ✅ **FIXED 2026-08-03** *(was High)*

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

## F2 — Setup is O(classes × heads) by hand, with no rollover ✅ **FIXED 2026-08-03**

Ten classes and four heads is forty separate form submissions, one at a time. There is no bulk
apply ("Tuition 3,000 for 1st–5th"), and — more importantly — **no way to copy last year's plan
into this year**, which is an annual and unavoidable job for every school.

**Fix:** copy-a-year (with an optional across-the-board % rise) and a range/multi-class apply.
The Classes screen already proved the shape with copy-subjects-from-another-class.

---

## F3 — `ONE_TIME` and `ADMISSION` frequencies do nothing ✅ **CLOSED 2026-08-03 (refused, not implemented)**

`FeeFrequency` has four values; `createBatch` computes
`applies = MONTHLY || (ANNUAL && month === annualMonth)`. **`ONE_TIME` and `ADMISSION` are never
applied.** A school that creates an admission-fee structure sees it accepted, stored, listed —
and silently ignored on every invoice run.

Same family as `HALF_DAY` in attendance (G6): an enum value nothing acts on. Worse here, because
it looks configured and bills nothing. **Fix:** implement them (admission fee charged on the
first invoice after enrolment; one-time charged once per student per structure) or remove them
from the enum.

---

## F4 — No effective dating on a fee ✅ **FIXED 2026-08-03**

`SalaryStructure` carries `effectiveFrom`; `FeeStructure` does not. Mid-year fee revisions are
normal, and with no dating there is no way to answer *"what did 9th cost in April?"* once a
price changes — and no way to change a price without implicitly restating history.

**Fix:** `effectiveFrom`, and pick the structure in force on the invoice's month. That also gives
F1 its safe correction path.

---

## F5 — `campusId` on a structure is unvalidated ✅ **FIXED 2026-08-03**

`createStructure` stores the client-supplied `campusId` without checking it against the class's
own campus, so a structure can point at a campus its class does not belong to. The class already
implies the campus, making the column a denormalisation that can drift.

**Fix:** derive it from the class rather than accepting it, or assert they match.

---

## F6 — A duplicate structure returns 500, not 409 ✅ **FIXED 2026-08-03**

The unique index is the only thing stopping a second identical structure, and **`P2002` is not
mapped anywhere** (`all-exceptions.filter` has no Prisma-error handling). The operator sees
"Internal server error" for what is an ordinary "you already priced that".

Same shape as the guardian-email collision fixed on 2026-07-25 — that one was solved with a
pre-check. **Worth considering a general P2002 → 409 mapping** rather than a third pre-check.

---

## F7 — Nothing shows what a class costs ✅ **FIXED 2026-08-03**

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

---

## What shipped (2026-08-03)

`FeeStructure.effectiveFrom` + a unique key that includes it, so one class/head/frequency holds
a price **history**. Invoicing picks the row in force for the month it bills, through a pure
`inForceStructures` helper the fee-plan screen mirrors — the two cannot disagree about what a
class costs.

- **Editing** is allowed while nothing has been billed from the row (fix a typo), refused with
  the alternative named once it has. **Deactivating is always allowed** (future runs only);
  deleting a billed price is refused, because the invoices it produced must stay explicable.
- **Copy** moves a plan across classes or into the next year with a percentage rise. Only the
  price in force is copied, it **skips rather than overwrites**, and rises round to whole rupees.
- **F3 was closed by refusing, not implementing.** `ONE_TIME`/`ADMISSION` now 422 at creation
  with the reason, and the UI offers only the two frequencies invoicing charges. The enum is
  untouched. Implementing them properly (admission fee on first invoice after enrolment, one-time
  charged once per student) remains open if the operator wants it.
- Per-class plan cards with a monthly total on `/fees`, and the same figure read-only on the
  class workbench.

**Tests:** 8 new cases in `fees.e2e-spec` (revision billing, history untouched, edit refused when
billed, delete refused/deactivate allowed, unbilled typo corrected, duplicate 409, frequency
refused, copy with rise + skip-on-rerun), 3 matrix rows, 1 Playwright display test.

---

## F8 — Fee reads were open to any signed-in user ✅ **FIXED 2026-08-04**

Filed as two unguarded reads (`GET /fee-structures`, `GET /fee-heads`). On opening the
controller it was **four** — and the fourth reclassified the whole gap:

| Endpoint | Was | Now |
|---|---|---|
| `GET /fee-heads` | *(none)* | `OWNER_ADMIN, ACCOUNTANT` |
| `GET /fee-structures` | *(none)* | `OWNER_ADMIN, CAMPUS_ADMIN, ACCOUNTANT` |
| `GET /late-fee-policy` | *(none)* | `OWNER_ADMIN, ACCOUNTANT` |
| `GET /discounts?studentId=` | *(none)* | `OWNER_ADMIN, ACCOUNTANT` |

`GET /discounts?studentId=` returns a **named child's fee concessions** — hardship, staff-child,
sibling. Any authenticated session could read it, including that child's own classmates. That is
not "fee prices are not secret" (the Low-Med this was filed as); it is a family's financial
circumstances, and it moves the gap to **High**. Filed severity reflected the two endpoints
someone happened to notice, not the shape of the hole.

`CAMPUS_ADMIN` is on `/fee-structures` alone, because the class workbench (`/classes/[id]`)
shows a class's fee plan and that screen is theirs — read the plan, never change it. The other
three are money, so owner + cashier.

**Why nothing caught it:** the matrix had rows for the *writes* only. Every write beside these
reads was correctly `OWNER_ADMIN`, which is exactly what made the gap invisible — the module
looked guarded. *A guarded write does not imply a guarded read, and only a matrix row proves
either.* Four rows added; 24 new assertions (4 × 6 roles), both directions.

`GET /discounts` also has **no UI caller at all** — the fifth instance of the endpoint-nobody-calls
pattern in this codebase (after `PUT /sections/:id/subjects`, `PATCH /subjects/:id`,
`POST /staff-attendance/bulk`, and the fee-structure/fee-head writes).

**Verified:** integration 666/666, isolation 7, lint + build clean; owner reads still 200 on all
four against the live API; 13 Playwright specs green including `fee-plan`, which exercises both
calling screens.


---

## F9 — Fee heads were create-and-read only ✅ **FIXED 2026-08-03**

Reported by the operator, who opened the fee dropdown and found **24 entries, 23 of them test
debris**: `LoadTuition<ts>` from the fee-season load driver, `Tuition <ts>` from older runs, and
`Tuition-<ts>` / `Transport-<ts>` from **this session's own Playwright spec**, which tidied the
class, sections, subjects and prices it created — but not the heads, which are the part actually
on screen. *A test that cleans everything except the thing the operator looks at has not cleaned
up.*

The debris was only half the story. `/fee-heads` was **POST + GET only** — the same
create-and-read-only pattern as F1 and the subject rename before it — so the list could only ever
grow and the school had no way to tidy it themselves.

**Fixed:** `PATCH` (rename — the name appears on every invoice line) and `DELETE`, refused while
any class price, invoice line or discount references the head, with the message naming which.
Duplicate names now 409 instead of surfacing a raw P2002. The Playwright spec deletes its own
heads. Demo's 23 junk heads were removed after confirming zero references from structures,
discounts and invoice items.

### ⚠️ And the fix immediately caused a data loss, which is the lesson worth keeping

The first version of the chip shipped a bare **`✕` flush against Rename, with no confirmation**.
Within minutes the operator's one real fee head — `Tuition (Term)` — was gone. **The audit row
is what made it recoverable**: `FEE_HEAD_DELETED` preserved the name (`audit_logs` has no FK to
the entity precisely so the row outlives it), so it could be identified and restored rather than
guessed at.

The Classes screen had already learned this exact rule on 2026-07-30 — *"a destructive control
must never sit one stray pixel from a harmless one"*, worded buttons, confirm first — and I did
not apply it here. The delete is now a worded button, spaced, behind `ConfirmDialog` stating the
blast radius. **A rule recorded in [[Key Decisions]] is worth nothing if it is not applied to the
next screen.**
