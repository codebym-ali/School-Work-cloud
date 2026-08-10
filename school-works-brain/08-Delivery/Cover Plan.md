---
title: Cover Plan (teacher absent → who takes the class)
type: plan
status: C0 SHIPPED 2026-08-10 · C1–C4 planned
updated: 2026-08-10
---

# 🔁 Cover — when a teacher is away

> Related: [[Attendance & Leaves]] · [[Teacher Mobile Home Plan]] · [[Notifications Plan]] · [[Key Decisions]]

## 1. What happens today, checked in the code

The **teacher** is handled correctly. The **class they left behind is not.**

| | Today |
|---|---|
| Their own attendance | Office marks ABSENT, or the day-close job does. Feeds pay at `basic ÷ workingDays`. |
| Approved leave for that day | The ABSENT row is corrected to **ON_LEAVE** automatically (L4), so it stops costing them. |
| Their periods | **Nothing.** The timetable still says their name. No substitute, cover or relief exists anywhere in the schema or the API — searched. |
| The student register | **Blocked.** `assertCanMark` requires a `TeacherAssignment` for that section, so the teacher actually standing in the room gets *"You are not assigned to this section"* — 403. |
| Who can close it | **Admins only** (`isAdmin` returns early). Someone has to walk to the office. |
| What the school sees | The register appears in `unmarkedToday()` after the school's mark-by time, and on the head's dashboard. |

**Nothing is fabricated** — an unmarked register stays unmarked. That is right and must survive this
work: absence SMS goes to real parents, and attendance feeds defaulter reporting and pay.

**So the gap is exactly one sentence:** the person who actually has the class cannot record who
turned up.

## 2. The design thesis

> **Recording cover must work with nothing else filled in. Everything the school does maintain
> makes it faster.**

An earlier draft of this plan led with the opposite: *"nobody should have to type who is away and
what they were teaching — it is all derived."* That is a better sentence than it is a design,
because the derivation needs **two** datasets:

- **staff attendance**, marked daily — many small schools will not;
- **a timetable**, which today has **zero rows in every school**.

Build on both and the flagship screen is blank for most schools on day one, and the feature looks
broken rather than unused. That is exactly the trap the timetable's "now" card had to be rescued
from, and this would have repeated it with *two* dependencies instead of one.

So the order is:

| | |
|---|---|
| **Always works** | The office records: *section, date, who is covering.* Three fields, no prerequisites. |
| **Better with staff attendance** | "Away today: Nadia, Imran" — so the office starts from a list instead of memory. |
| **Better with a timetable** | Per-period rather than per-day, plus *which* periods need someone, plus who is free to take them. |

Derivation is an accelerant, never the premise. A school with neither dataset still gets the thing
they asked for: the person in the room can mark the register.

## 3. Architecture

### 3.1 The entity

```prisma
model CoverAssignment {
  id             String   @id @default(uuid())
  schoolId       String
  date           DateTime @db.Date        // one day; cover is not a contract
  sectionId      String                   // the class that needs someone
  /// NULL when the school has no timetable — then it is "cover 9-A today", which is how a school
  /// without a published grid actually works. Set when a timetable exists, so cover is per period.
  periodNo       Int?
  coveringStaffId String                  // who is taking it
  /// Who is away. Nullable on purpose: a class can need cover for reasons the register does not
  /// know (a teacher pulled into a meeting), and refusing to record cover without an absence
  /// would make the office lie to the system to use it.
  absentStaffId  String?
  reason         String?  @db.VarChar(200)
  arrangedById   String                   // the admin who decided — this is a permission grant
  createdAt      DateTime @default(now())

  @@index([schoolId, coveringStaffId, date])
  @@index([schoolId, sectionId, date])
}
```

⚠️ **The obvious constraint is wrong.** A first draft wrote `@@unique([sectionId, date, periodNo])`
to mean "one owner per class per period". **Postgres treats NULLs as distinct in a unique index**,
so two whole-day covers for the same section on the same date would both be accepted — precisely
what the constraint exists to stop. This repo already relies on that behaviour deliberately
elsewhere (`fee_invoices.psid`, nullable and unique per school, so un-issued invoices coexist), so
the mistake was the opposite of a subtlety.

It needs **two partial unique indexes**, added to `prisma/sql/02_partial_uniques.sql` beside the
existing ones — which also means `db:check-migrations` protects them from a future `migrate diff`:

```sql
-- One cover per section per period, when the school runs periods.
CREATE UNIQUE INDEX IF NOT EXISTS cover_one_per_section_period
  ON cover_assignments (school_id, section_id, date, period_no) WHERE period_no IS NOT NULL;

-- One whole-day cover per section, when it does not.
CREATE UNIQUE INDEX IF NOT EXISTS cover_one_per_section_day
  ON cover_assignments (school_id, section_id, date) WHERE period_no IS NULL;
```

**It must work with no timetable.** `timetable_slots` shipped with zero rows in every school, and
most will not fill it in for a term. If cover *required* a timetable slot, the feature would be
unusable exactly where it is needed most. Hence `periodNo` nullable, and "cover this section today"
as the degraded — and perfectly usable — mode.

### 3.2 What it grants, and how narrowly

Cover extends `assertCanMark` with a second way to qualify: **a `CoverAssignment` for that section
on that date.** Nothing else.

- **Attendance only.** Not exam marks. Marks are subject-scoped and belong to whoever teaches the
  subject over a term; a day's cover is not a claim on someone's gradebook.
- **That date only.** Not "until further notice".
- **That section only.**

### 3.3 ⚠️ Creating cover is a permission grant, so it is audited

This is the part that would be easy to get wrong. A `CoverAssignment` **gives one person write
access to another class's register**, and it can be created for a past date — which makes it a way
to hand out retroactive access to a register that feeds pay and defaulter reports.

So: `COVER_ASSIGNED` / `COVER_REMOVED` in the audit catalog, naming both teachers, and the same
month-freeze rule the leave work uses — **no cover into a month whose payroll is APPROVED**.

### 3.4 Where the check lives

In the service, not a guard (§22.8). Guards run before the `withTenant` transaction, so a guard
reading `cover_assignments` sees zero rows under RLS and would wave everything through — the same
trap already documented for the guardian check.

### 3.5 What cover is NOT

- **Not pay.** No cover allowance, no overtime. If a school pays for cover it is a payroll change
  with its own decision, not a side effect of this.
- **Not a swap.** Two teachers exchanging periods permanently is a timetable edit.
- **Not multi-day.** A fortnight of absence is *n* daily rows, generated in one action (§6, C1), so
  the model stays one-day and the UI does the repetition.

## 4. The office's screen — the morning ritual

A head teacher does this at 07:45 with a mug in one hand.

### 4.1 What it looks like on day one — no timetable, no staff register

This is the version most schools will actually meet, so it is the one that has to be good.

```
Cover — Monday 10 August

  [ + Record cover ]

  Class      9-A  ▾        Covering   Fatima Noor ▾        Because  (optional)
                                                            [ Save ]

  COVERED TODAY  1
  9-A   all day   Fatima Noor        arranged by you, 07:42      [ undo ]
```

Three fields, nothing to set up first, and the covering teacher can mark the register the moment
it saves. **If the plan shipped only this, the reported problem is solved.**

### 4.2 What it grows into, once the school keeps the other two registers

⚠️ Everything below is an **accelerant on top of §4.1**, not the design — the `✓ free` marker in
particular is **C3** and needs a timetable. An earlier draft used this picture as the headline,
which promised something the first three phases cannot deliver.

```
Cover — Monday 10 August

  AWAY TODAY  2
  Nadia Iqbal      absent          4 periods need cover
  Imran Shah       on leave        2 periods need cover

  NEEDS COVER  6                              [ Fill all with… ▾ ]
  P1  9-A   Mathematics   was Nadia    → [ pick a teacher ▾ ]
  P3  9-B   Mathematics   was Nadia    → [ Fatima Noor  ✓ free ]
  P5  10-A  Physics       was Imran    → [ pick a teacher ▾ ]
  …

  COVERED  2
  P2  8-C   English   Fatima Noor covering for Imran        [ undo ]
```

**Every row above is derived** — who is away comes from staff attendance, what they were teaching
from the timetable. The only thing the office types is a name in a dropdown.

**The dropdown is the design.** It lists teachers who are **present today and free that period**
first, marked *free*, then everyone else. Both facts are already in the database; making the
administrator hold them in their head is the difference between a tool and a form.

**Between the two**, with staff attendance but no timetable: *"Nadia Iqbal is away — which of her
classes needs someone?"*, her sections listed from `TeacherAssignment`. Each step says why it
cannot be more precise rather than showing an empty list.

## 5. The covering teacher's experience

**Nothing new to learn.** Cover appears where their day already lives:

- The **"now" card** on `/home` shows the covered class, badged **Covering** — and its one button,
  *Mark this register*, now works, because the grant makes it work.
- **My Timetable** shows the covered period inline for that day, badged, so their week is honest.
- The **bell** tells them it happened: *"You are covering 9-A period 3 today."* Derived from the
  same `CoverAssignment`, so it disappears when the cover is removed — [[Notifications Plan]]'s rule.

The absent teacher is told too: *"Fatima Noor is covering your Grade 9-A today."* Being covered
without being told is how staff learn to distrust a system.

## 6. Phases

- **C0 — the grant, and the three-field screen (§4.1). ✅ SHIPPED 2026-08-10.** Model, the two
  partial unique indexes, `assertCanMark` extended, audit actions, plus the record-cover form.
  **C0 ships a complete feature**: no timetable, no staff register, no prerequisites — the office
  records cover and the right person can mark. Everything after this is speed. *(An earlier draft
  made C0 backend-only and put the screen in C1, which would have left the first shippable
  increment unusable by the person who needs it.)* See §10 for what shipped and what it cost.
- **C1 — start from who is away.** Reads staff attendance to list absent/on-leave teachers and
  their sections, so the office picks from a list rather than memory. Plus "repeat for a date
  range" for a known multi-day absence.
- **C2 — the covering teacher's surfaces.** Now card, My Timetable badge, both notifications.
- **C3 — free-teacher suggestions.** Only meaningful once a school has a timetable; ships behind
  the same endpoint so the dropdown simply gets better rather than the screen changing.
- **C4 — tests, gates, brain.** Cases that must be able to fail: a covering teacher can mark **only**
  the covered section, **only** on that date; cover into an APPROVED payroll month is refused; the
  grant does not leak into exam marks; removing cover removes the ability.

## 6a. Two consequences the first draft left out

Cover changes who *owns* a register for a day, so two existing surfaces have to move with it or
they will contradict it:

- **The absent teacher stops being chased.** `REGISTER_UNMARKED` in the bell is scoped to a
  teacher's own sections; once 9-A is covered it is no longer Nadia's problem that day, and
  nagging someone about a class they were away from is how a notification feed loses its
  credibility. It should move to **Fatima**.
- **The head's count re-attributes.** `unmarkedToday()` drives *"3 registers not marked today"*.
  A covered-but-unmarked register is still worth chasing — but the person to chase is the cover,
  so the row should name Fatima, not Nadia.

Both are one filter each, and both are the kind of thing that looks obvious afterwards and is
invisible beforehand.

## 6b. The cheaper option, and why it is not the recommendation

**Let any teacher at the same campus mark any register, and record who did it.** No table, no
screen, no admin step — the substitute simply marks it, and `markedById` says who.

It genuinely solves the reported problem, and it is perhaps two hours of work against several
days. It is rejected because:

- it removes a real boundary for everyone, permanently, to solve one Tuesday — a teacher can
  currently only touch sections they teach, and that is deliberate;
- nothing records that Nadia was covered, so the school cannot answer "who took my class" later;
- the head's unmarked list still cannot attribute anything, because nobody was ever made
  responsible.

Worth revisiting **only** if the office step proves to be the friction that stops schools using it
— in which case the honest fix is making §4.1 faster, not widening access.

## 7. What this deliberately does not change

- An unmarked register still stays unmarked. Cover makes it *markable by the right person*; it
  never marks anything itself.
- The existing boundary stands: a teacher still cannot touch a section they neither teach nor cover.
  This work **narrows** the problem rather than widening access for everyone to solve a Tuesday.

## 8. Decisions needed

**8.1 — Who may arrange cover?**
Recommendation: **OWNER_ADMIN and CAMPUS_ADMIN (own campus)**. It is a permission grant, and the
same people who approve leave should decide who takes the class. There is no "head of section"
role today, and inventing one for this would be a bigger change than the feature.

**8.2 — Should a covering teacher also be able to enter exam marks for that class?**
Recommendation: **no.** Attendance only. Marks are subject-scoped and belong to whoever teaches the
subject across a term.

**8.3 — Is cover allowed on a past date?**
Recommendation: **yes, but audited and blocked in a frozen payroll month.** Schools genuinely write
cover down after the fact, and refusing it would push them to leave registers unmarked instead —
which is worse than a recorded, audited backdate.

## 9. Risks

- ~~**Does a Pakistani school actually substitute, or merge classes?**~~ **Asked and answered by
  the operator, 2026-08-09: someone actually takes the class.** Recorded because it was the single
  assumption the whole model rests on, and the first draft asserted it without asking. Had the
  answer been "the students get put in with another class", the primitive would have been
  *"9-A is with 9-B today"* — one teacher, one room, **two** registers to mark — and this model
  would have been a form the office had to lie to.
- **The suggestion is only as good as the timetable**, and today every school has zero slots. §4.1
  is the answer: the always-works screen needs neither timetable nor staff register.
- **Scope creep toward timetabling.** Cover is a day's patch. Swaps, room changes and permanent
  reassignment are timetable edits and stay out.
- **Cover as a back door.** Mitigated by §3.3: audited, narrow, date-bound, payroll-frozen-aware —
  and by C4 proving each of those can fail.

---

## 10. C0 as built — 2026-08-10

**Shipped:** `cover_assignments` + two partial unique indexes, `CoverService`/`CoverController`
(`POST` / `DELETE` / `GET ?date=`), `assertCanMark` extended with the cover branch, two audit
actions, `/cover` (the §4.1 three-field screen), three permission-matrix rows,
`cover.e2e-spec.ts` (**18 cases**). No timetable and no staff register are involved anywhere.

### What the design decided, and why

- **`assertCanMark` gained a `date` parameter.** It never had one — an assignment is not dated, so
  the question "may this person mark 9-A?" used to have a date-free answer. Cover is dated by its
  whole nature, so the authorization question changed shape: *may this person mark 9-A **on the 10th***.
  Two tests exist purely because of this (a cover on Monday may not mark Tuesday).
- **No `@@unique` on the model — two partial indexes instead.** The obvious
  `@@unique([sectionId, date, periodNo])` **cannot work**: `period_no` is NULL for whole-day cover
  and **Postgres treats NULLs as distinct**, so two whole-day covers on the same class would both
  insert. So: `cover_one_per_section_period` (`WHERE period_no IS NOT NULL`) and
  `cover_one_per_section_day` (`WHERE period_no IS NULL`). This is the same NULL-distinctness the
  fee module *relies on* for `fee_invoices.psid` — the same behaviour is a feature there and a bug
  here, which is why it is written down in both places. The duplicate test says so in a comment,
  because a later reader "simplifying" it back to one unique key would reopen the hole silently.
- **`GET /cover` is campus-scoped in the service, not a guard** (§22.8). A guard runs before
  `withTenant`, so it would read zero rows and refuse everyone.
- **The error names the person.** *"Ayesha Khan is already covering 9th-A that day"*, not
  "conflict" — the office's next move is to find out who, and a status code doesn't tell them.
- **Refused into an APPROVED payroll month.** Cover grants the right to *change* attendance, and
  attendance drives the deduction; granting it into a settled month is the same hole as editing the
  register directly. A paid payslip must keep agreeing with its register.
- **The `/cover` nav entry is OWNER_ADMIN + CAMPUS_ADMIN, deliberately excluding TEACHER.**
  Arranging cover is a permission grant; if the person who benefits could issue it, the boundary
  would not exist. A test asserts a teacher arranging their own cover gets 403.

### Proven non-vacuous, twice

The two tests that carry the feature were probed by breaking the code under them:

| Probe | Result |
|---|---|
| Cover grant ignores the date | **1 failed** — "does not let the cover mark a DIFFERENT date" |
| Cover branch removed from `assertCanMark` | **2 failed** — "lets that same teacher mark it once cover is recorded", "takes the right back when cover is removed" |

The list test was added last and is date-probing by construction: it asserts the other day is empty,
so a `list` that ignored its `date` fails.

### Verified live (demo tenant, owner session)

Recorded *9th-A · all day — Ayesha Khan · instead of Haris Ali · Sick leave* → the row rendered as
written and the toast read *"Cover recorded — they can mark that register now."* A second cover for
the same class returned **"Ayesha Khan is already covering 9th-A that day"**. Switching the day to
the 11th emptied the list; switching back and pressing Remove emptied it again and the substitute's
right went with it. Demo left clean.

⚠️ **Found while doing it, out of scope:** the demo tenant's class dropdown carries ~110 leftover
`Cls<epoch-ms>` classes from Playwright runs, which now swamp the five real ones on every screen
with a class picker. Same leak as the `admin-<timestamp>` tenants fixed on 2026-08-07, one level
down — the teardown removes leaked *tenants* but not fixtures created inside the shared `demo`
tenant. Filed separately.

### Deliberately still open (C1–C4)

`REGISTER_UNMARKED` still chases the absent teacher, and the head's unmarked count still names
them, rather than the cover (§6a). Both are one filter each and both belong with C2's surfaces;
until then the office knows about the cover and the notification feed does not.
