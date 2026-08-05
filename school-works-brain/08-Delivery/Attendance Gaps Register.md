---
title: Attendance — known gaps & flaws
type: register
status: open — G1–G4 (clock rules), G9, G10, G11 fixed · G4b, G5–G8 open
created: 2026-08-03
scope: staff + student attendance, the day-close job, and the timing rules around both
---

# Attendance — known gaps & flaws

> Running record of defects and unanswered design questions in the attendance work, so none of
> them survives only in a chat log. **Severity is about consequence, not effort.** Anything that
> can move somebody's pay is High by default, because `payroll.absentDays()` counts `ABSENT`
> rows straight into a salary deduction.

---

## G1 — Payroll lock ignores the campus ✅ **FIXED 2026-08-03** *(was High)*

`PayrollRun` is unique on `[schoolId, campusId, month, year]` — **one run per campus per month**.
Both locks I added query without `campusId`:

- `attendance.service.assertPayrollOpen` — approving **campus A's** payroll makes staff attendance
  for campuses B and C **unwritable for that whole month** (409).
- `maintenance.closeOneSchool` — the same approval **skips the day-close for the entire school**,
  every campus.

So a three-campus school that approves payroll for one campus on the 25th silently freezes the
other two campuses' registers for the rest of the month, and the day-close job stops writing
anything anywhere.

**Why the tests missed it:** the spec's fixture puts the payroll run and the marked staff member
in the *same* campus, so a campus-blind query and a campus-scoped one behave identically. **A
guard tested only in the single-campus case is untested.**

**Fixed.** Both sides now resolve the set of campuses whose payroll is approved for that month
(one query) and apply it **per staff member**:
- `markStaffBulk` refuses only the affected rows, through the existing partial-failure contract,
  so a bulk register spanning two campuses saves the campus that is still open. It is no longer a
  whole-request 409 — a mixed list must not be rejected because one campus is settled.
- `checkIn` keeps its 409, scoped to the caller's own campus.
- The day-close job skips **per campus** instead of returning from the whole school.
- A staff member with no campus belongs to no payroll run and is never frozen.

**Regression tests are deliberately two-campus**, in one request, because that is the shape the
original defect hid behind. **Proven non-vacuous:** neutering the scope back to "any approved run
freezes everything" fails exactly the new case.

---

## G2 — Day-close time was hardcoded fleet-wide ✅ **FIXED 2026-08-04** *(was Med-High)*

The plan (§5.2) specified **`closeAtTime`** as a per-school setting. Building S5 I dropped it and
did not flag the omission: the job ran `0 20 * * *` for **every tenant, in the server's timezone**.

Fixed as specified:
- `staffAttendance.closeAtTime` (HH:MM, default **20:00** so no school's behaviour changed on
  upgrade), validated in the Zod schema and the DTO, editable on the settings screen — but only
  when `autoMarkAbsent` is on, because a time that governs nothing is a decision asked for no
  reason (the same rule that kept `autoMarkAbsent` itself off the screen while the job was unbuilt).
- The cron became an **hourly tick** (`0 * * * *`) that settles only schools whose own local close
  time has passed. Safe by construction: the job never touches an existing row, so every pass
  after the first writes nothing.

**Two defects surfaced while fixing it, both fixed here:**
1. **A machine-written row accused the person it was about.** Check-in after the close returned
   *"You are already marked ABSENT today."* — phrased as though they had done it, with no hint
   that the remedy is the office rather than another press. It now names the author and the hour:
   *"The register was closed for today at 20:00 and you were recorded ABSENT. Ask the office to
   correct it."* The same row rendered on `/my-attendance` as a **green `badge ok`** — a success
   colour on an absence. Now red, and only "ok" when the status actually is.
2. **The deadline was invisible until it was missed.** `myCheckInState` returns `closeAtTime`
   (null when the school doesn't run the close), so the screen says *"Check in before 20:00"*
   while that is still actionable — rather than letting someone discover the rule by hitting it.

**Test that keeps it true:** `maintenance.e2e` — a school whose close time is still ahead is left
alone though it has opted in, is on a working day, and has unmarked staff. The existing block had
to pin `closeAtTime: '00:00'`, which is the point: without it those tests would pass or fail
depending on what time of day the suite ran.

⚠️ **Still fleet-wide: the timezone.** The comparison uses the *server's* wall clock, not the
school's — see [[#G4]]. Correct while every tenant is a Pakistani school on one server, and the
code now says so at the comparison rather than leaving it implied.

---

## G3 — No deadline for the class register ✅ **FIXED 2026-08-04** *(was Med)*

**Decided: surface it, don't police it.** A school's enforcement here is social — the head chases
the teacher — so the system's job is to make the gap visible to the head, not to block, punish or
invent attendance. Decision taken with the operator 2026-08-04, alongside: **an unmarked day stays
an unmarked day, for ever.** Nothing auto-marks present (that manufactures records nobody
witnessed, and they feed report cards) and nothing auto-marks absent (absence SMS goes to real
parents, so a forgetful teacher would text a wave of families whose children were in class).

Built:
- **`attendanceMarkByTime`** (HH:MM, default 10:00) — after a normal first period, well before the
  day ends. It decides only *when the head is shown the gap*: before it, a blank register is a
  lesson that hasn't happened yet, and complaining then trains people to ignore the complaint.
- **`GET /attendance/unmarked-today`** — admin-only, campus-scoped. **Starts from the SECTIONS**,
  which is the whole point: a query over `attendance_records` can only return registers somebody
  already filled in, so it returns the opposite of what is wanted. Same lesson the staff register
  learned. Non-working days are excluded (crying wolf every Sunday is how a warning becomes
  wallpaper) and `partial` distinguishes a half-done register from one never started.
- A dashboard chip that appears **only after the deadline**, click-through to `/attendance?unmarked=1`,
  where the sections are named and each is one click from being marked. A chip that points at a
  page where you still have to go looking is barely better than no chip.
- Deliberately **not** open to TEACHER: this is a list of colleagues who are behind, which is
  oversight. A teacher gets their own coverage strip.

### The adjacent defect it surfaced — `todayAttendancePercent` was a reassuring lie

The dashboard computed `present / records-that-exist`. **Live on the operator's tenant it read
100% while 9 of 17 students were marked** — one marked section, everyone present, and the school
is told it is perfect. This is exactly the rule the staff register established ("a percentage over
a half-kept register is not a fact about the school"); the student side had never been given it.

Fixed the same way: coverage travels **with** the percentage and is displayed **beside** it, never
folded in. Folding would produce a different lie — a school that has marked half its registers is
not "50% attendance" — and hiding it leaves the reassuring one. The tile now reads
*100% · from 9 of 17 marked · 8 not yet*.

---

## G4 — Timezone was the server's, not the school's ✅ **FIXED (clock rules) 2026-08-05**

**Fixed for every rule that asks "what time is it".** `timezone` is now a school setting (IANA
name, validated by asking the runtime to resolve it, default `Asia/Karachi` so nothing changed on
upgrade), and all four comparisons that read `Date#getHours()` now read the school's clock:

| Where | Rule |
|---|---|
| `checkInStatus` | is a staff check-in LATE |
| `myCheckInState` | what the button *would* record |
| `unmarkedToday` | is the class register overdue (G3) |
| `closeStaffAttendance` | is the staff day close due (G2) |

The shared helpers (`localHhMm`, `isPastLocalTime`, `minutesOfDayIn`) **format** through `Intl`
rather than doing arithmetic on an offset, so DST is the runtime's problem — a hand-rolled `+05:00`
would be wrong half the year in any zone that observes it, and there is a unit test pinning
exactly that with Europe/London in January and August. `hourCycle: 'h23'` because `hour12: false`
yields `"24"` at midnight in some locales, which sorts *above* every deadline and would make a
just-past-midnight tick look like the end of the day.

**Verified live**: the same instant, one setting, two answers — `Asia/Karachi` → due,
`Pacific/Midway` → not due; `Mars/Olympus` → 422.

### ⚠️ Still open: the DAY BOUNDARY

Date columns are `@db.Date` and every service builds them as **UTC midnight**
(`new Date(iso.slice(0,10))`). So *which day* a record belongs to is still UTC's answer, not the
school's. For UTC+5 that is invisible in practice — a Karachi school's working hours never cross
the UTC date line — but a school at UTC−5 would find early-morning attendance filed against the
previous day.

Deliberately **not** changed here: it touches every date column, every `startOfDay`, and every
report that groups by day, so it is a migration-shaped project rather than a helper swap, and
doing it badly would silently re-date existing records. Split out rather than half-done.

## G11 — A child's name became a UUID past 100 students ✅ **FIXED 2026-08-05** *(High)*

Found because the test debris pushed the demo tenant past 100 students — the debris exposed it,
it did not cause it.

**Marks entry, the results table and the Fees invoice list all resolved a student's name from a
map built out of `GET /students?pageSize=100`**, with `studentId.slice(0, 8)` as the fallback. So
for every student outside the *first page* — i.e. most of a real school — a teacher entering marks
and a clerk taking money saw a truncated UUID where a child's name belongs. Silent, and it scales
with the school: invisible in a 40-pupil demo, wrong in every school worth having as a customer.

Fixed at the source rather than by raising the page size, which would only move the cliff: the
`/enrollments`, exam-results and invoice projections now **carry the student's name**, and the
screens read it off the row. `/enrollments` had been returning it all along and the page ignored
it. Same rule the teaching-assignment rework landed on — *a list must carry the names it displays*.

## G4b — The day boundary is still UTC 🟡 **Med · latent, split from G4 on 2026-08-05**

Three different notions of "when" coexist and none is per-tenant:
- `checkInStatus` reads the **server's local hours** (`dayStartTime` is wall-clock).
- `date` columns are **UTC midnight** (`new Date(iso.slice(0,10))`).
- Cron patterns fire in the **server's timezone** (prod sets `TZ=Asia/Karachi`).

Correct today because every tenant is a Pakistani school on one server. **It breaks silently the
moment a tenant sits in another timezone** — lateness and the day boundary would disagree, and
the day-close would fire mid-afternoon for someone. Nothing in the code says this is an
assumption rather than a design.

**Fix when it matters:** a `timezone` per school, used for both the clock comparison and the
day boundary. Until then, write the assumption down where the reader will hit it.

---

## G5 — Admins have no backfill floor on staff attendance 🟡 **Med**

Student attendance bounds a **teacher** to `attendanceBackfillDays` and leaves admins unlimited
(deliberate, and their post-window edits are audited). Staff attendance has **no floor for
anyone** — an admin may mark staff attendance for any past date, limited only by the payroll lock
on approved months.

An unapproved month therefore remains fully rewritable, and staff attendance feeds payroll.
Not obviously wrong (a school genuinely corrects last month's register), but it is an
*unstated* asymmetry rather than a decision. Decide and record it either way.

---

## G6 — `HALF_DAY` is reachable only by hand 🟢 **Low**

`HALF_DAY` exists in the enum, counts as half a day everywhere, and is offered in the register's
dropdown — but **nothing derives it**: not self check-in (presence only), not the day-close job
(`ABSENT` or `ON_LEAVE`). Fine as an admin-only judgement call; worth saying so, since a status
nothing produces looks like an unfinished path.

---

## G7 — `staff_attendance.check_out` is a dead column 🟢 **Low**

`checkOut` is selected in reads and **never written by anything**. There is no check-out action,
so it is permanently null and any UI showing it shows "—" for ever. Either build check-out (which
implies a working-hours story: what does leaving early mean for pay?) or drop the column. A
column that can never hold a value is a promise the schema does not keep.

---

## G8 — One check-in per day is a decision, not a limitation 🟢 **Low · recorded for clarity**

Operator decision **D5**: staff use the `MORNING` session only, so there is exactly one register
per person per day. `checkIn` writes `settings.attendanceSessions[0]`, so a school that sets
`attendanceSessions: ['EVENING']` gets its evening session — but a school running **both** still
gets one staff register, on the first session.

The settings screen deliberately does not expose `attendanceSessions`: a second session changes
the shape of every register and payroll's day-counting. Two-shift schools are a product
conversation, not a toggle.

---

## Fixed already (kept so the reasoning survives)

- **Tile/filter contradiction** — the register's "Present" tile counted `present + late` while the
  PRESENT filter matched `PRESENT` exactly, so the page reported 1 and then showed nothing.
  Fixed structurally: every tile *is* its own filter, and the cross-predicate roll-up moved into
  prose. Guarded by a Playwright invariant test over **all** tiles, not that one case.
- **Partial-update DTO overwriting untouched settings** — `{...dto}` materialises every declared
  property, so unsent keys arrived as `undefined` and Zod replaced each with its default.
  `undefined` is now stripped at both levels before merging.
- **`afterEach` deleting payroll runs before payslips** (FK RESTRICT) — a throwing cleanup left
  the next test on dirty state, so one broken teardown read as two unrelated failures.

---

## G9 — CSV import was unusable by the only role allowed to do it ✅ **FIXED 2026-08-04**

Not an attendance gap, but found the same way and worth the entry. `POST /students/import` is
`ADMISSION_CONTROLLER`-only (segregation of duties, same as admitting). Its button lives on the
Students screen — and that screen's nav allowed **only** `OWNER_ADMIN` and `CAMPUS_ADMIN`. So the
one role permitted to bulk-import could not open the page that does it, and the feature was
reachable by nobody. Meanwhile the button was rendered for *everyone*, so an owner could open the
form, paste a file and collect a 403 with nothing explaining why.

Fixed both ways round: the officer is added to the `/students` nav entry, and the button is shown
only to the role that can use it.

**The pattern:** a nav stricter than the API silently deletes a capability, and a button looser
than the API manufactures a dead end. This is the third instance — the teacher who could be marked
absent but could not reach `/my-attendance`, the owner who could not find `/admissions-team`, and
now this. *Whenever a route's `@Roles` and its nav entry disagree, one of them is a bug.*

---

## G10 — The e2e suite accumulated students in its own campus ✅ **FIXED 2026-08-05** *(was Low — it stopped being low)*

`seedClassSection` creates a class per run and never removes it. They land in the suite's own
`E2E Automation` campus (2026-08-04), so the school's real campuses stay clean and the operator
can ignore or delete the whole campus — but it was already 21 classes after a day. Deliberate
trade for now: cleanup would have to unpick sections, subjects, enrolments and the admitted
student. **Revisit if that campus ever needs to be looked at**, or add a teardown that drops
classes older than a day.

**It stopped being cosmetic the day G3 shipped.** The unmarked-register count the head is shown
read **71 — 67 of them test classes**, and `enrollmentCount` counted 90-odd test children. Debris
is harmless right up until a real metric counts it, and then it is a lie on a dashboard.

Fixed with a Playwright `globalTeardown` that **withdraws** (never deletes) the enrolments in the
suite's own campus. Withdrawn because the API *correctly refuses* to delete a class that has
students — a test helper must not reach past a rule the product enforces on purpose — and because
every polluted metric counts **ACTIVE** enrolments, so withdrawing is exactly the true statement
"these students left". The classes stay, empty and inert, in a campus nobody looks at.
Self-limiting: the first run cleared 94, the next cleared 8. Verified after: unmarked back to 5
(the school's real sections), enrolled back to 17.

Same shape, found the hard way on 2026-08-04: the guardian-link spec submits a **real claim**, and
three runs left three PENDING rows in *Payment submissions* — a screen the office actually works
through. It now rejects its own claim afterwards (a claim is never deleted; the record of what was
submitted is the point), so the residue is an inert REJECTED row in a tab nobody actions rather
than fake work in the queue. **Debris in a list is tolerable; debris in a queue is a task.**
