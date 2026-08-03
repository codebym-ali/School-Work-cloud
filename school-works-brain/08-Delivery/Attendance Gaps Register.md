---
title: Attendance — known gaps & flaws
type: register
status: open — running list, added to as flaws surface
created: 2026-08-03
scope: staff + student attendance, the day-close job, and the timing rules around both
---

# Attendance — known gaps & flaws

> Running record of defects and unanswered design questions in the attendance work, so none of
> them survives only in a chat log. **Severity is about consequence, not effort.** Anything that
> can move somebody's pay is High by default, because `payroll.absentDays()` counts `ABSENT`
> rows straight into a salary deduction.

---

## G1 — Payroll lock ignores the campus 🔴 **High · defect shipped 2026-08-03**

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

**Fix:** resolve the staff member's campus and scope both queries to it. The day-close job must
skip **per campus**, not per school. Add a two-campus regression case.

---

## G2 — Day-close time is hardcoded fleet-wide 🟠 **Med-High · specified, then dropped**

The plan (§5.2) specified **`closeAtTime`** as a per-school setting. Building S5 I dropped it and
did not flag the omission: the job runs `0 20 * * *` for **every tenant, in the server's
timezone**.

Consequences:
- A morning school whose day ends at 13:00 has its absences settled at 20:00 — a seven-hour
  window where the register looks open but is about to be written.
- **A teacher arriving after close cannot check in at all.** Their `ABSENT` row already exists,
  so `POST /check-in` 409s. With one fleet-wide time, some school always has this backwards.
- A two-shift school cannot express its day at all.

**Fix:** `closeAtTime` per school beside `dayStartTime` on the settings screen; the cron becomes an
hourly tick that closes only schools whose local close time has passed and which have not closed
today. Idempotence already holds (existing rows are never touched), so an hourly tick is safe by
construction.

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
