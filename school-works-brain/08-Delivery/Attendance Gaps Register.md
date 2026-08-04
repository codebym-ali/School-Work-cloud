---
title: Attendance — known gaps & flaws
type: register
status: open — G1, G2 fixed · G3–G8 open · running list, added to as flaws surface
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

## G3 — No deadline for the class register at all 🟡 **Med · missing feature, not a bug**

There is **no rule that today's student attendance must be marked by any time.**
`attendanceBackfillDays` bounds how far *back* a teacher may fill in — never by *when* today's
must be done. The coverage strip shows which days are missing; nothing has an opinion about
lateness, and nobody is told.

**Open product question:** does the school want to police this (a per-school or per-section
"mark by" time, plus something that notices and tells the head), or is the coverage strip
enough? Worth deciding before building — an unenforced deadline is just another number.

---

## G4 — Timezone is an unwritten assumption 🟡 **Med · latent**

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

## G10 — The e2e suite accumulates classes in its own campus 🟢 **Low · accepted, watch it**

`seedClassSection` creates a class per run and never removes it. They land in the suite's own
`E2E Automation` campus (2026-08-04), so the school's real campuses stay clean and the operator
can ignore or delete the whole campus — but it was already 21 classes after a day. Deliberate
trade for now: cleanup would have to unpick sections, subjects, enrolments and the admitted
student. **Revisit if that campus ever needs to be looked at**, or add a teardown that drops
classes older than a day.
