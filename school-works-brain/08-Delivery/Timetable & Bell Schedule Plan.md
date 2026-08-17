---
title: Timetable & Bell Schedule Plan (period times, day shape, subject load)
type: plan
status: PLANNED — v2 after audit, 2026-08-17. Decisions taken, nothing built yet.
updated: 2026-08-17
---

# 🔔 The timetable needs a clock

> Related: [[Cover Plan]] · [[Attendance & Leaves]] · [[Teacher Mobile Home Plan]] · [[Key Decisions]]

> [!warning] This is v2. The first draft was audited before building and **four serious defects were
> found in the plan itself**, one of which would have punched the first hole in tenant isolation with
> all three layers blind to it. §13 records what changed and why — that appendix is the most useful
> part of this document for the next plan anyone writes here.

## 1. What happens today, checked in the code

The **placement** half is built and correct. The **shape** half does not exist.

| | Today |
|---|---|
| Put a subject + teacher in a cell | ✅ `POST /timetable/slots`, idempotent per (section, year, day, period). |
| A section in two places at once | ✅ Refused by `@@unique([sectionId, academicYearId, dayOfWeek, periodNo])`. |
| A teacher double-booked | ✅ Refused in-service, and the error **names the clashing class**. |
| Subject belongs to the class | ✅ Checked — otherwise Chemistry schedules cleanly for Grade 2. |
| Teacher who has left / wrong campus | ✅ Both refused. |
| **When does period 3 start?** | ❌ **Nothing anywhere.** `periodNo` is a bare ordinal. |
| **How long is a period?** | ❌ Not in the schema, not in `SchoolSettings`, not in the DTO. |
| **How many periods does Grade 9 have?** | ⚠️ **Never declared.** `gridShape()` takes `max(periodNo)` over rows that happen to exist, floored at 6. |
| Breaks, lunch, assembly | ❌ Cannot be represented. A 40-minute lunch is a hole in the numbering or a fake subject. |
| Maths should get 6 periods a week | ❌ Not modelled. Nothing can say a grid is two Maths periods short. |
| Building 15 sections × 8 × 6 | ⚠️ **720 individual saves.** No copy tools, no template. |

**The period count is worse than absent — it is guessed.** An 8-period school is shown 6 rows until
somebody types into period 7. A school that has built nothing is shown 6 rows for no reason beyond a
default. There is no answer to *"how many periods does Grade 9 have?"*, only *"how many have been
typed in so far"*.

⚠️ **And the grid is rectangular, which this market is not.** Every day gets the same period rows, so
**Friday** — a short day in virtually every Pakistani school — renders identically to Tuesday, and its
empty cells cannot distinguish *"not filled yet"* from *"Friday has no period 6"*. That is the exact
distinction `coverage()` was written to preserve one level up.

## 2. The design thesis

> **The day's shape is declared by the school, not inferred from what somebody has typed so far.**

Once the day is declared, the grid is a rendering of it rather than a guess: Friday is genuinely
shorter, a break is a real band with real times, period 7 cannot be filled in a school that has six,
and a teacher's week can finally say *when* as well as *what*.

The corollary is the operator's decision (§10 D3), load-bearing throughout: **the admin composes each
day themselves** — how many periods, how long, where the breaks fall, same across the week or
different every day. The system supplies no opinion about what a school day looks like, only the
structure to describe one.

**And one hard constraint the audit produced (§13 A2):** exactly one schedule resolves for any
section in any academic year. That is what keeps `periodNo` meaning one thing, and it is why §7 has
no seasonal variant.

## 3. Architecture

### 3.1 Two entities and one explicit join

```prisma
model BellSchedule {
  id             String   @id @default(uuid()) @db.Uuid
  schoolId       String   @map("school_id") @db.Uuid
  school         School   @relation(fields: [schoolId], references: [id])
  campusId       String   @map("campus_id") @db.Uuid
  campus         Campus   @relation(fields: [campusId, schoolId], references: [id, schoolId])
  academicYearId String   @map("academic_year_id") @db.Uuid          // ← A5
  academicYear   AcademicYear @relation(fields: [academicYearId, schoolId], references: [id, schoolId])
  name           String   @db.VarChar(60)   // "Regular", "Primary Wing"
  /// Empty class list ⇒ this is the campus DEFAULT. At most one per (campus, year).
  classes        BellScheduleClass[]
  periods        BellPeriod[]
  deletedAt      DateTime? @map("deleted_at")                        // ← A10
  createdAt, updatedAt
  @@unique([id, schoolId])
}

/// ⚠️ EXPLICIT join, never `classes Class[]`. See §13 A1 — an implicit Prisma m2m creates a table
/// with no `school_id`, therefore no RLS policy, and the coverage gate cannot even see it.
model BellScheduleClass {
  id         String @id @default(uuid()) @db.Uuid
  schoolId   String @map("school_id") @db.Uuid
  school     School @relation(fields: [schoolId], references: [id])
  scheduleId String @map("schedule_id") @db.Uuid
  schedule   BellSchedule @relation(fields: [scheduleId, schoolId], references: [id, schoolId], onDelete: Cascade)
  classId    String @map("class_id") @db.Uuid
  class      Class  @relation(fields: [classId, schoolId], references: [id, schoolId])
  /// A class may sit in AT MOST ONE schedule per year — resolution is decided at write time,
  /// never resolved by precedence at read time.
  @@unique([classId, scheduleId])
  @@index([schoolId, scheduleId])
}

model BellPeriod {
  id         String  @id @default(uuid()) @db.Uuid
  schoolId   String  @map("school_id") @db.Uuid
  scheduleId String  @map("schedule_id") @db.Uuid
  schedule   BellSchedule @relation(fields: [scheduleId, schoolId], references: [id, schoolId], onDelete: Cascade)
  dayOfWeek  Int     @map("day_of_week")   // 1..7 — every day composed independently
  sequence   Int                            // order down the day, breaks included; server-assigned
  isTeaching Boolean @map("is_teaching")    // ← A8: the only distinction with behaviour
  periodNo   Int?    @map("period_no")      // teaching only; server-assigned 1..n
  label      String? @db.VarChar(30)        // "Break", "Lunch", "Assembly", "Jumma"
  startTime  String  @map("start_time") @db.VarChar(5)   // "08:00" — school-local wall clock
  endTime    String  @map("end_time")   @db.VarChar(5)
  @@unique([scheduleId, dayOfWeek, sequence])
  @@index([schoolId, scheduleId, dayOfWeek])
}
```

`dayOfWeek` sits on `BellPeriod` rather than on a day parent, so Friday is not a flag or a special
case — it is simply a day composed with fewer rows (§10 D3).

**Two SQL companions**, both required, both feeding the migration-safety guard:

- `02_partial_uniques.sql` — `bell_periods_one_period_no` on `(schedule_id, day_of_week, period_no)`
  **`WHERE period_no IS NOT NULL`**, and `bell_schedules_one_default` on `(campus_id, academic_year_id)`
  **`WHERE`** the schedule has no classes attached.
- `03_checks.sql` — `start_time`/`end_time` match `^([01][0-9]|2[0-3]):[0-5][0-9]$`.

### 3.2 ⚠️ The NULL-distinct trap, wanted in one place and fatal in the other

`periodNo` is nullable — breaks have none — and **Postgres treats NULLs as distinct**. For breaks that
is exactly right: a day may hold several. For teaching rows it means a plain unique key would **not**
stop two period-3s. Hence the partial index above.

Third appearance of one behaviour in this repo: relied on deliberately for `fee_invoices.psid`, a hole
in `cover_assignments` closed by two partial indexes, and now both at once in one column. The comment
must say so, or somebody simplifies it back.

### 3.3 The client sends durations; the server computes and stores times

This is the fix for the audit's contiguity contradiction (§13 A4), and it turns a validation rule into
a structural impossibility.

```
PUT /bell-schedules/:id/days/:dayOfWeek
{ startsAt: "08:00",
  rows: [ { isTeaching: false, label: "Assembly", minutes: 15 },
          { isTeaching: true,                     minutes: 40 },
          { isTeaching: true,                     minutes: 40 },
          { isTeaching: false, label: "Break",    minutes: 15 },
          { isTeaching: true,                     minutes: 40 } ] }
```

**The client never sends a time.** The server walks the list from `startsAt`, computes each
`startTime`/`endTime`, assigns `sequence` and numbers the teaching rows `1..n`. So:

- **Gaps and overlaps cannot exist** — not "are validated", *cannot exist*. There is no input that
  expresses one.
- `periodNo` is never typed, so nobody creates a period 7 that no bell rings for.
- Reordering is free: send the list in the new order.
- **The whole day is written atomically**, which is the only granularity at which a day-level invariant
  can be checked.

⚠️ **Find-then-write, never `upsert`.** CLAUDE.md is explicit: the tenant extension merges `schoolId`
into the where clause and breaks a compound unique selector. The day write loads the existing rows,
deletes what is gone and writes the rest, inside the request's `withTenant` transaction, passing
`schoolId` explicitly on every create.

`VarChar(5)` rather than `@db.Time` deliberately (§13 A6): zero-padded `HH:MM` **sorts
lexicographically in chronological order**, it is the representation every other clock value in this
product already uses, and the existing helpers `isPastLocalTime()` / `localHhMm()` take it unchanged.
`@db.Time` would hand TypeScript a `Date` on 1970-01-01 that every call site has to strip.

### 3.4 Resolution — exactly one schedule per section per year

For a section, in the year being read (**not "today"** — §13 A5):

1. the schedule whose `classes` include the section's class;
2. else the campus default (the schedule with no classes attached);
3. else **none** — and the editor says *"No timings set for this campus yet"* rather than inventing six
   periods. "Not built" is a different problem from "empty", which is why `coverage()` exists.

`@@unique([classId, scheduleId])` plus the one-default partial index make this **deterministic by
construction**. There is no precedence rule to get wrong at read time, because two candidates cannot
be created in the first place — this repo's standing preference for failing at the point of the
decision.

### 3.5 What changes in `TimetableSlot` — nothing structural

No column, no backfill, no reference to a schedule (§7 explains why none is needed). `setSlot` gains
one conditional check:

> **If** a schedule resolves for this section, the `(dayOfWeek, periodNo)` must exist as a teaching row
> in it — refused with the reason, *"Friday has 5 periods."* **If none resolves, nothing changes.**

⚠️ **The conditional is the whole point** (§13 A3). Unconditional validation would mean that a school
with a timetable and no bell schedule loses the ability to write to its own grid — turning an additive
feature into a breaking one on deploy.

`timetable_slots` carries no production data in any school today, so the constraint lands on an empty
table. **That is the argument for building this now rather than after schools fill their grids.**

**Removing a teaching period that has lessons on it warns; it does not refuse, and it does not
delete.** The lessons are retained and simply not rendered while the period does not exist, and they
reappear if it is added back. The screen says so: *"3 sections have lessons in periods 7–8, which this
day no longer has. They are kept."* Non-destructive, reversible, and it is what makes §7 work.

### 3.6 Subject load — advisory (§10 D2)

`Subject.periodsPerWeek Int?` — on `Subject`, which is already keyed `(classId, name)`, because the
load is a class-level academic decision and every section of Grade 9 gets the same six Maths periods.

⚠️ **The meter iterates `SectionSubject`, not `Subject`** (§13 A12). `SectionSubject` exists precisely
because two sections of one class may take different subjects; iterating `Subject` would report a
Computer shortfall against a section that does not take Computer.

Advisory throughout: the editor reads *"Maths — 4 of 6 placed"*, coverage lists shortfalls, and
**nothing is ever refused**. Mirrors `sectionCapacityMode: ADVISORY`, and matches how a coordinator
works — they overshoot deliberately mid-build and rebalance afterwards.

### 3.7 Audited (§13 A7)

Changing a school's timings reshapes every register and every teacher's day. `BELL_SCHEDULE_UPDATED`
carries the campus, the day and a before/after summary — the same reasoning Cover used for *"creating
cover is a permission grant, so it is audited"*.

## 4. The admin's screen — *School timings*

One screen per campus. A day picker across the top, the composed day beneath it:

```
Monday                       [ copy timings to → Tue Wed Thu Fri Sat ]
Day starts  08:00
  Assembly            15 min   ⋮
  Period 1            40 min   ⋮
  Period 2            40 min   ⋮
  Break               15 min   ⋮
  Period 3            40 min   ⋮
  + Add period   + Add break            Day ends 10:30 · 3 teaching periods
```

Add, remove, reorder, retype. Times recompute down the day as durations change, so lengthening period 1
moves the whole day rather than requiring nine retypes. The footer states what the day *is* — end time
and teaching count — because that is the number the coordinator is actually trying to hit.

## 5. What the timetable grid becomes

`gridShape()` is deleted. The editor renders the **declared** day:

- Friday shows five rows because Friday has five, not because five have been filled.
- Breaks render as full-width non-clickable bands with their label and times — a teacher looking at
  their week can see where lunch is, which is most of what they want from it.
- Every row carries its clock time, on all three screens (admin, `/my-timetable`, `/me/timetable`),
  from the one shared module.
- The empty state stops being six mystery rows and becomes *"Set this campus's timings first"*.

## 6. Phases

| | | |
|---|---|---|
| **P0** | Schedule model, whole-day API, *School timings* screen | Both SQL companions · audit · **plus the RLS-gate hardening in §12** |
| **P1** | The grid reads the schedule | `gridShape()` deleted · breaks as bands · times on all three screens · conditional `setSlot` check · the retain-and-warn rule |
| **P2** | `Subject.periodsPerWeek` + advisory meter | Iterating `SectionSubject`; shortfalls in `coverage()` |
| **P3** | **Copy lessons** across days | `{ created, skipped }` per §25.3, each skip naming its clash |
| **P4** | Wing override UI | Model ships in P0; this exposes it |
| **P5** | Matrix rows, e2e, live verification | Including the first Playwright spec the timetable has ever had |

**P4 is UI-only on purpose.** `BellScheduleClass` ships in P0's migration even though nothing writes it
until P4, because adding it later is a second migration against a table that will by then hold every
school's timings.

## 7. Ramadan — and why v1 has no seasonal variant

**This is the audit's biggest design change, and the honest version is that I introduced the problem.**
The operator's four decisions never mentioned seasonal schedules; my first draft added
`effectiveFrom`/`effectiveTo` on its own initiative, and that single field created the one genuine
ambiguity in the model: the same section resolving to two different schedules on different dates, with
`TimetableSlot.periodNo` unable to say which one it was authored against.

**The wing override never had that problem** — a section belongs to one class, which sits in one
schedule, so `periodNo` is unambiguous. Only the dated variant broke it.

So the dated variant is cut, and Ramadan is handled by the mechanism already in the design: the admin
**edits the timings** — shorter durations, fewer periods — and edits them back a month later. Two
whole-day writes per day changed, audited, and §3.5's retain-and-warn rule means **the lessons in the
dropped periods are kept and reappear** when the periods return. Nothing is lost and nothing is
renumbered.

What that costs: no historical record of what the bell was during Ramadan (the audit log has the
change, not a queryable schedule), and no scheduling a variant in advance. Both are acceptable for a
one-month-a-year concern that every school currently handles by announcement.

**When it is worth building**, the design is a `BellVariant` that re-times an existing schedule's rows
for a date range and may suspend a trailing range of periods — but may never add, renumber or reorder
them. That constraint is what preserves `periodNo`, and it should be written into the model rather than
left to a reviewer.

## 8. Copy timings vs copy lessons — two features, two names (§13 A9)

The first draft called both "copy day".

- **Copy timings** (P0, on the timings screen) — Monday's *bell rows* onto other days. Cannot clash;
  it is a pure overwrite of one day's shape.
- **Copy lessons** (P3, on the grid) — Monday's *subject+teacher assignments* onto other days. Clashes
  wherever that teacher already has that period elsewhere, so it returns `{ created, skipped }` with
  each skip naming the clash.

⚠️ **Copy lessons to a sibling SECTION is deferred, with its reason recorded.** Two sections of one
class running the same grid clash on the same teacher at **every row** — that is the normal outcome,
not an edge case — and `TimetableSlot.staffId` is `NOT NULL`, so there is no "copy the subjects, leave
the teachers blank" escape without a schema change reaching attendance and cover. It needs its own
decision: copy with an explicit teacher-substitution map, or not at all.

## 9. Permissions

Writes **OWNER_ADMIN** and **CAMPUS_ADMIN own-campus**, narrowed **in the service** (§22.8 — a guard
runs before the `withTenant` transaction and reads zero rows under RLS). Reads reach TEACHER and
STUDENT for their own week.

**Matrix rows are not optional.** This repo has learned twice that a route with no row is where the
leak hides — `GET /enrollments` had no `@Roles` at all, and the four fee reads returned a named child's
concessions to any session. Every new route gets a row, both directions.

## 10. Decisions taken (operator, 2026-08-17)

- **D1 — Bell schedule per campus, with a wing override.** A class group may carry its own shorter day.
  Primary out at 12:30, secondary at 14:00, one campus.
- **D2 — Subject load is advisory.** Declared and shown, never enforced.
- **D3 — The admin controls the day completely.** *"Where he wants to add break and for how much time,
  and how many periods for each — it can be different or same, completely managed by admin."*
- **D4 — Cell-by-cell plus copy tools**, keeping the existing editor's five rules intact.

**Taken by me during the audit, and flagged as mine:** no seasonal variant in v1 (§7).

## 11. What this deliberately does not change

- **The five placement rules.** They are correct and stay exactly as they are.
- **Attendance, cover and pay.** None read `periodNo` for a time today and none will start. Cover's
  `periodNo` stays nullable for whole-day cover.
- **Nothing becomes mandatory.** A school with no bell schedule keeps a fully working timetable editor
  (§3.5) — it just gets an honest empty state instead of a guessed one.

## 12. Risks, edge cases, and one project fix this plan owes

- ⚠️ **The RLS coverage gate has a blind spot, and P0 closes it.** [check-rls-coverage.mjs](../../scripts/check-rls-coverage.mjs)
  starts from `WHERE c.column_name = 'school_id'`, so a tenant table **without** that column is never a
  candidate and passes green. That is exactly how the first draft's implicit m2m would have shipped.
  P0 adds the complementary assertion — no table in `public` outside a known allowlist lacks
  `school_id` — because **the plan that found the hole should close it.**
- ⚠️ **Migration safety.** The two new companions take the protected-object list from **15 to 17**, and
  `migrate diff` will emit the trigram `DROP INDEX` to be curated out for the **fourteenth** time.
- **Timing runs the safe way for once.** Every constraint lands on an empty `timetable_slots`. The same
  work later means reconciling real grids against a schedule invented afterwards.
- **Academic year rollover.** Slots and now schedules are year-scoped, so a new year starts empty and
  every grid is rebuilt by hand. **Copy-year is the highest-value thing not in this plan.**
- **A teacher resigns mid-year.** `leftAt` blocks new slots and Cover handles the day; nothing
  reassigns their existing grid. Unchanged here, filed separately.
- **Exam weeks and half days.** Schools suspend the timetable for exams; `Holiday` exists and does not
  intersect the timetable at all. Out of scope, recorded.
- **Timezone.** All times are school-local wall clock, like `attendanceMarkByTime` and
  `staffAttendance.dayStartTime`. No new clock is introduced.
- **Gates each phase must hold:** unit · integration (36 suites) · isolation 7 · **RLS coverage
  including the new assertion** · migration safety · lint (api + web) · root/e2e/web typechecks ·
  api+worker+web builds · Playwright. Every phase probed by breaking its own rule and recording what
  fails.

## 13. What the audit changed, and why

The v1 draft was audited before any code was written. Twelve findings; **four were serious, and one was
critical.** Recorded in full because the corrections are worth more than the plan.

| | Finding | Fix |
|---|---|---|
| **A1** | ⚠️ **Critical.** `classes Class[]` is an implicit m2m → join table with **no `school_id`** → no RLS policy → and the coverage gate **cannot see it**, because it only inspects tables that have the column. All three isolation layers blind at once. Verified: **0** implicit m2m tables exist across 37 migrations; every m2m here is explicit and tenant-chained. | Explicit `BellScheduleClass` (§3.1) + the gate hardening (§12) |
| **A2** | ⚠️ `periodNo` becomes ambiguous once one section can resolve to two schedules. The **wing override never had this problem**; the dated seasonal variant — which I added unasked — created it. | Seasonal variant cut (§7); resolution proven single (§3.4) |
| **A3** | §3.6 required `setSlot` validation while §9 promised a working editor with no schedule. **Both cannot be true**: no schedule ⇒ no teaching rows ⇒ every write fails. Would have shipped as a breaking change. | Validation made conditional (§3.5) |
| **A4** | Row-level editing cannot uphold a whole-day contiguity invariant. | Whole-day PUT, **client sends durations, server computes times** — gaps become inexpressible rather than validated (§3.3) |
| **A5** | `BellSchedule` had no `academicYearId` while `TimetableSlot` does; resolution keyed on "today" would return this year's bell for last year's grid. | Year-scoped (§3.1, §3.4) |
| **A6** | `String` times with no DB validation, a pattern that exists nowhere else — the schema has **zero** time-of-day columns today. | `VarChar(5)` + CHECK, with the reasoning stated (§3.3) |
| **A7** | No audit trail on a change that reshapes every register. | `BELL_SCHEDULE_UPDATED` (§3.7) |
| **A8** | A 4-value enum where only teaching-vs-not has behaviour. | `isTeaching: Boolean` + `label` |
| **A9** | "copy day" named two different features on two different entities. | *Copy timings* vs *copy lessons* (§8) |
| **A10** | No soft-delete, unlike nearly every model here. | `deletedAt` |
| **A11** | No gates, no migration-safety note — every other plan here states both. | §12 |
| **A12** | The load meter would iterate `Subject` and report shortfalls for subjects a section does not take. | Iterates `SectionSubject` (§3.6) |

**The lesson worth keeping:** the single most valuable finding was not about the timetable at all. A1
was found by asking *"what does this Prisma shorthand actually create?"* — and answering it exposed a
standing blind spot in the CI gate that the whole tenancy story rests on. **Auditing the plan was
cheaper than auditing the product, and it found a product defect.**
