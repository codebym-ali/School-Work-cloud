---
title: Cover Plan (teacher absent → who takes the class)
type: plan
status: draft — awaiting operator decisions in §8
updated: 2026-08-09
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

> **The school already told the system everything it needs. Nobody should have to type "who is away
> and what were they teaching".**

Staff attendance knows who is absent. The timetable knows what they were teaching, and when. So
**"what needs cover today" is derived, not entered** — the office is handed a list and only makes
the decision a human has to make: *who takes it*.

That is the whole product. A cover feature that asks an administrator to re-enter facts the
database already holds is a form, not a tool.

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

  @@unique([sectionId, date, periodNo])   // one owner per class per period
  @@index([schoolId, coveringStaffId, date])
}
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

A head teacher does this at 07:45 with a mug in one hand. It should be one screen and mostly
reading.

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

**Without a timetable** the screen degrades honestly: no period rows, and instead *"Nadia Iqbal is
away — which of her classes needs someone?"* with her sections listed from `TeacherAssignment`.
It says why it cannot be more precise rather than showing an empty list.

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

- **C0 — the grant.** Model, migration, `assertCanMark` extended, audit actions. **No UI.** This
  alone fixes the reported problem: the office can create cover and the right person can mark. A
  thin admin endpoint is enough to use it.
- **C1 — "what needs cover today".** The derived endpoint + the office screen in §4, including
  "fill a date range" for a known multi-day absence.
- **C2 — the covering teacher's surfaces.** Now card, My Timetable badge, both notifications.
- **C3 — free-teacher suggestions.** Only meaningful once a school has a timetable; ships behind
  the same endpoint so the dropdown simply gets better rather than the screen changing.
- **C4 — tests, gates, brain.** Cases that must be able to fail: a covering teacher can mark **only**
  the covered section, **only** on that date; cover into an APPROVED payroll month is refused; the
  grant does not leak into exam marks; removing cover removes the ability.

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

- **The suggestion is only as good as the timetable**, and today every school has zero slots. C1
  must be useful without it (§4), or the feature launches looking broken.
- **Scope creep toward timetabling.** Cover is a day's patch. Swaps, room changes and permanent
  reassignment are timetable edits and stay out.
- **Cover as a back door.** Mitigated by §3.3: audited, narrow, date-bound, payroll-frozen-aware —
  and by C4 proving each of those can fail.
