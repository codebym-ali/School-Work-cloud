---
title: Notifications Plan
type: plan
status: N0 shipped — N1 awaiting the §7 decisions
updated: 2026-08-08
---

# 🔔 Notifications Plan

> Related: [[Fee Submission Plan]] · [[Attendance & Leaves]] · [[Key Decisions]] · [[Progress Tracker]]

## 1. What exists today (checked, not remembered)

There is **no notification feature**. No `Notification` model, no bell, no unread state, nothing
addressed to a person and kept until they have seen it. Four unrelated things each do a slice:

| Surface | Who sees it | What it is |
|---|---|---|
| **Closure banner** (H2) | every role, every page | Lives in the app shell. Today/tomorrow only. |
| **SMS** | guardians' phones | 5 events: `ABSENCE`, `LEAVE_STATUS`, `RESULT_READY`, `FEE_RECEIPT`, `MANUAL`. Leaves the app entirely. |
| **"Needs attention" strip** | **admins only** | Derived chips on `/dashboard` — defaulters, pending leaves, failed SMS, ready-to-admit. |
| **Toasts** | whoever did the action | Transient. Gone on reload. |

## 2. The actual gap

Everything above is either **computed live** or **sent out over SMS**. Nothing tells a person
something happened *to them*.

> A teacher files leave. An admin approves it. **Nobody tells the teacher.** They find out by
> opening My Leaves and noticing a badge changed colour. If it was *rejected*, the reason — which
> the office was required to type — sits on a row they have to go and look for.

And the one existing "what needs you" surface is on `/dashboard`, which **teachers, staff and
students cannot open**. `/dashboard` is OWNER_ADMIN / CAMPUS_ADMIN / ACCOUNTANT; a teacher lands on
`/attendance`, staff on `/my-attendance`, a student on `/me`. This is the same trap the closure
banner was deliberately built to avoid — see the comment in `app/(app)/layout.tsx`.

**So the gap is not "we have no notifications". It is: the people without a dashboard have nowhere
at all that says what changed for them.**

## 3. The central decision: derived, not stored

Two ways to build this.

**Stored** — a `notifications` table, one row per user per event, with read state. It is what most
apps do, and it is the wrong first move here:

- A stored notification is **a copy of state**, and this codebase has been bitten by second copies
  more than by anything else: three copies of the attendance percentage gave a parent, a teacher
  and a director three different figures; payroll kept its own month-calendar and charged a leave
  day the quota never counted. A row saying *"your leave was approved"* after the leave is
  cancelled is the same failure, except it is lying to a person rather than to a report.
- It needs fan-out on every write, a growth policy, and a backfill for anything that happened
  before it shipped.

**Derived** — compute "what is true and relevant for you, right now" on request, exactly as the
dashboard attention strip already does. Nothing is stored, so nothing can go stale, and an item
disappears by itself when it stops being true.

> **Rule: a notification must be derived from the thing it describes.** If the underlying record
> changes, the notice changes with it. No copies.

### The one thing derived cannot do, and the cheap fix

Derived has no concept of *unread*. The fix is **not** a table — it is one column:

```prisma
// on User
notificationsSeenAt DateTime? @map("notifications_seen_at")
```

Anything whose underlying record changed after that timestamp renders as **new**; opening the
panel sets it to `now()`. That buys the entire unread experience — a count on the bell, bold rows —
without duplicating a single fact.

### ⚠️ A trap worth naming: `AuditLog` cannot answer this

`AuditLog.userId` is **the actor** — who *did* the thing — not who it happened to. So audit rows
can never be filtered into "what happened to me" without already knowing which entity ids are
mine. Deriving from the domain tables is right; deriving from audit is a dead end that looks
promising for about an hour.

## 4. What each role would actually be told

Only items the person **can act on or genuinely needs to know**. A feed that lists everything
becomes a feed nobody reads — the same reasoning that keeps the closure banner to today/tomorrow.

| Role | Items (all derivable from existing tables) |
|---|---|
| **TEACHER** | leave approved / rejected **with the reason**; register not marked today (after `attendanceMarkByTime`); marked ABSENT by the office (the dispute path); payslip ready; closure tomorrow |
| **STAFF** | same, minus the register |
| **STUDENT** | result published; fee due soon / overdue; marked absent today |
| **ACCOUNTANT** | payment claims waiting; new defaulters |
| **ADMISSION_CONTROLLER** | students ready to admit; entry tests today |
| **HR_MANAGER** | staff joining / leaving this week |
| **OWNER / CAMPUS_ADMIN** | the existing attention strip — **the same source**, not a second one |

That last row matters: `/dashboard` must end up reading the *same* endpoint, or the school has two
places that answer "what needs me" and they will eventually disagree.

## 5. Phases

- **N0 — the endpoint. ✅ DONE 2026-08-08.** `GET /notifications`, derived per request, no `@Roles`
  (ownership-gated like `/payslips/mine`) and **never throws** — an account with no staff profile
  gets `{ items: [] }`, because the shell will call this on every page for every user. Four kinds:
  `LEAVE_DECIDED` (carrying the rejection reason, which is the point of requiring one),
  `MARKED_ABSENT` (the dispute path — staff attendance feeds the payroll deduction),
  `SALARY_PAID`, and `REGISTER_UNMARKED` (teachers only, one line a day, silent until
  `attendanceMarkByTime`). Each item carries `at`, unused until N1. No UI, no schema change.
  - **Proved derived, not merely present.** `notifications.e2e` (9 cases) asserts a notice
    *disappears* when its cause does — the leave is deleted, and the item goes with it; an absence
    corrected to ON_LEAVE stops being mentioned. A suite that only checked appearance would pass
    against the stored design this rejects. Non-vacuity probed: removing the `staffId` filter and
    unbounding the recency window each fail a case.
  - **Recency limits are part of the design, not tuning:** leave 14 days, absence 7, salary 30. An
    absence older than a week cannot still be disputed before payday, and a feed that never forgets
    is a feed nobody opens.
  - ⚠️ **"Your payslip is ready" was left out and this is why:** `PayrollRun` records `approvedById`
    but **no `approvedAt`**, so the event cannot be dated honestly — only the DRAFT's `createdAt`
    exists, which is a different moment. `SALARY_PAID` uses `paidAt`, which is real. Adding
    `approvedAt` is the fix if that notice is wanted.
- **N1 — the bell.** In the **topbar** of the app shell, beside 🔒 Security — the shell is the only
  surface every role sees, which is exactly why the closure banner lives there. Adds
  `User.notificationsSeenAt` and the new/seen count. This is the phase that closes the gap in §2.
- **N2 — one source of truth.** Repoint the dashboard attention strip at `/notifications` and
  delete the duplicated derivation in `dashboard/page.tsx`.
- **N3 — stored rows, only if something demands it.** Deferred on purpose. Revisit only when a
  real item **cannot** be derived — the honest candidate is "the office changed your attendance
  and the old value is gone". Do not build the table speculatively.

## 6. Out of scope, deliberately

- **Push notifications / service workers** — needs HTTPS, a permission prompt and a delivery
  service; large, and worth nothing until the app is deployed and in daily use.
- **Email** — no provider is configured, and Pakistani school staff do not run on email.
- **More SMS** — settled already: [[Key Decisions]] records that there is no SMS budget, which is
  why H3 (closure SMS) is deferred and the guardian route is a copyable WhatsApp message. Anything
  here must be free.
- **Notifying people about things they cannot act on.** A teacher does not need to know a fee was
  collected.

## 7. Decisions needed before N1

1. **Bell, or a banner strip under the topbar?** A bell is compact and familiar but hides its
   contents behind a click; the closure banner works precisely *because* it is unmissable.
   Recommendation: **bell**, with anything genuinely urgent staying a banner as it is now.
2. **Does a teacher's unmarked register belong here?** It is already surfaced to the head on the
   dashboard (G3). Putting it in the teacher's own bell is arguably the better place — but G3 was
   deliberately built to *surface, not police*, and a daily notice aimed at one person edges
   toward nagging. Recommendation: **include it, once per day, worded as a reminder**.
3. **Students at all in N1, or staff-side first?** The gap in §2 is about teachers and staff.
   Recommendation: **staff-side first**; students in N2.

## 8. Risks

- **Feed inflation.** Every future feature will want a line in here. Mitigation: the §4 table is a
  closed list, and adding to it is a decision recorded in [[Key Decisions]], not a reflex.
- **The count that is a lie.** A bell showing "3" that opens onto two items is worse than no bell.
  The count and the list must come from one call, not two.
- **Two answers to "what needs me".** Only avoided by doing N2 — until then, the dashboard strip
  and the bell are separate derivations and *will* drift.
