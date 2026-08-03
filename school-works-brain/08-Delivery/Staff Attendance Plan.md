---
title: Staff Attendance — self-marking, history and oversight
type: plan
status: proposed — awaiting decisions (§8)
created: 2026-08-03
scope: apps/api attendance + hr(payroll) · apps/worker maintenance · apps/web my-attendance, staff, dashboard · libs/common settings
---

# Staff attendance — plan

> Operator: *"a teacher attendance system on each teacher portal where the teacher can mark
> his/her attendance and see history with a date filter (1/2/3 months, year). The owner sees
> teacher attendance on the dashboard — total teachers and how many are absent — clicks the
> absent card for the list, clicks a teacher for their lifetime absences with the same filters."*

## 1. What already exists (verified in code, not assumed)

| Piece | State |
|---|---|
| `StaffAttendance` model | **Exists** — `staffId · date · session · status · checkIn · checkOut`, unique `[staffId, date, session]`, indexed `[schoolId, date]` + `[staffId, schoolId]` |
| `POST /staff-attendance/bulk` | **Exists**, `OWNER_ADMIN`/`CAMPUS_ADMIN` — **and has no UI caller** |
| `GET /staff-attendance/mine` | **Exists**, self-scoped via `StaffProfile.userId` — hard `take: 60`, **no date filter** |
| `/my-attendance` screen | **Exists** — % + a 60-row table. **Nav is `STAFF`-only, so a TEACHER cannot reach it** |
| Payroll coupling | **Exists** — `payroll.absentDays()` counts `ABSENT` rows; deduction = `(unpaidLeaveDays + absentDays) × basic / workingDays` |
| Shared % helper | **Exists** — `libs/common/util/attendance.ts`; `/my-attendance` carries a duplicated inline copy |
| Owner-side view | **Does not exist** — no dashboard card, no register, no per-staff history |

### 1.1 ⚠️ The feature is currently inert

Neither write path has a caller: `POST /staff-attendance/bulk` is reachable only by hand-crafted
API call, and no self-marking exists at all. So in production `staff_attendance` is empty, which
means `/my-attendance` shows every staff member an empty table, and **payroll silently computes a
zero attendance deduction for everyone**. This is not a missing screen on a working feature — the
feature has never been able to record anything.

That reframes the work: this is not "add a teacher view", it is "make staff attendance real,
end to end, without letting it corrupt payroll".

## 2. The decision that shapes everything: self-marking meets payroll

`absentDays` feeds the salary deduction directly. If a teacher can mark their own attendance,
**a teacher controls their own pay** — the same class of exposure the project already rejects for
staff creation vs. salary ("whoever creates an employee must never set their pay", [[Key Decisions]]).

**Rule: a teacher may assert their own PRESENCE, never their own ABSENCE, and only for today.**

- Self check-in writes `PRESENT`/`LATE` with `checkIn = now`, for **today only** — no backdating,
  no editing, no self-recorded `ABSENT`, `HALF_DAY` or `ON_LEAVE`.
- **`LATE` is derived from the clock, not chosen.** The teacher presses one button; the server
  compares `now` against the campus day-start plus a grace period. Letting someone self-declare
  "on time" is the whole exploit in miniature.
- Absence is never self-asserted. It is **admin-recorded** or **derived at day close** (§4).
- Every row records **provenance** — who wrote it and how. Oversight without provenance is theatre.

**Honest limitation, to be stated to the operator rather than designed around:** self check-in
proves *someone with the teacher's login pressed a button at 07:58*, not that they were on
site. Without biometrics or geofencing that is the ceiling. What the design buys is a timestamped,
attributed, admin-overridable record — the same assurance a paper register gives, no more. If the
school needs more, the escalation path is IP/geofence on check-in, which is why `source` and
`checkIn` are modelled now (§8 D3).

## 3. What "absent" means — three states, not two

The dashboard must count absences. Today a row exists only if someone wrote it, so "absent" and
"nobody marked anything" are indistinguishable — and a card reading *"0 teachers absent"* because
nothing was recorded is worse than no card, the same trap as the DIRECT-mode inquiry tiles.

Four distinct facts, rendered distinctly everywhere:

| State | Meaning | Counts against attendance % | Payroll deduction |
|---|---|---|---|
| `PRESENT` / `LATE` | Turned up | No (full credit) | No |
| `HALF_DAY` | Half | Half credit | No |
| `ON_LEAVE` | Approved leave | **Excluded from denominator** | Only if the leave is unpaid (already handled) |
| `ABSENT` | Did not turn up | Yes | **Yes** |
| *unmarked* | Nobody said | Not counted at all | No |

`unmarked` is a first-class number on every screen. It is the register's own completeness signal —
the staff equivalent of the class-attendance coverage strip.

## 4. Day close — how `ABSENT` comes into being

A nightly per-tenant job, in the existing `MaintenanceService` (the established cross-tenant
pattern: own CLS + `withTenant`, one failing tenant never aborts the rest).

```
staff-attendance-close   20:00 school TZ, daily
  skip if not a working day for the campus (weeklyOffDays / Holiday)
  for each ACTIVE staff member in the campus:
    skip if joinedAt > today or leftAt < today      ← never invent a record for someone not employed
    skip if a row already exists for (staff, today, session)
    if an APPROVED leave covers today  → ON_LEAVE   (source SYSTEM)
    else                               → ABSENT     (source SYSTEM)
```

- **Opt-in per school** (`staffAttendance.autoMarkAbsent`, default **false**). This job writes rows
  that reduce salaries; no existing tenant may acquire that behaviour by upgrade.
- **Idempotent** — find-then-write, and the `[staffId, date, session]` unique backs it.
- **Never runs for a non-working day**, so a holiday cannot manufacture an absence.
- **Validates against the date it claims** (`joinedAt`/`leftAt`), the lesson from the student
  backfill work — a guard must ask "was this true *then*", not "is it true now".
- Admin can override any `SYSTEM` row; the override is audited and keeps the original in
  `oldValue`.

## 5. Architecture

### 5.1 Schema — one migration

```prisma
model StaffAttendance {
  // ... existing fields unchanged ...
  source       AttendanceSource @default(ADMIN)   // SELF | ADMIN | SYSTEM
  markedById   String?  @map("marked_by_id") @db.Uuid
  markedBy     User?    @relation(fields: [markedById, schoolId], references: [id, schoolId])
  note         String?  @db.VarChar(200)          // why an admin overrode
  @@index([staffId, date])                        // the drill-down's query shape
}
enum AttendanceSource { SELF ADMIN SYSTEM }
```

- Composite `(markedById, schoolId)` FK carries the tenant chain, matching DB audit fix #8.
- `@@index([staffId, date])` — the lifetime-history query is `staffId` + date range; the existing
  `[staffId, schoolId]` does not order by date.
- Defaults make the migration backfill-free: every existing row is `ADMIN` with no marker, which
  is exactly what it was.
- **RLS is not automatic on migrate** — run `pnpm db:sql` then `db:check-rls` (no new table here,
  but the enum + column still need the companion pass on the index).

### 5.2 Settings (`school-settings.schema.ts`, Zod, unknown keys rejected)

```ts
staffAttendance: {
  selfMarking:     z.boolean().default(false),        // teachers may check themselves in
  autoMarkAbsent:  z.boolean().default(false),        // the day-close job (§4)
  dayStartTime:    z.string().regex(HH_MM).default('08:00'),
  graceMinutes:    z.number().int().min(0).max(120).default(15),
  closeAtTime:     z.string().regex(HH_MM).default('20:00'),
}
```
Everything defaults **off**, so no existing tenant changes behaviour on deploy. Opt-in follows the
`admissionsMode` precedent: a school-level setting, deliberately **not** per-user `module_access`
(that would need toggling per account and a new hire would silently get the old behaviour).

### 5.3 API

| Method | Route | Who | Purpose |
|---|---|---|---|
| `POST` | `/staff-attendance/check-in` | any staff (self, in-service) | Today only. Server sets status from the clock. 409 if already marked. |
| `GET` | `/staff-attendance/mine?from&to` | any staff (self) | Replaces the hard `take: 60`. Range-filtered. |
| `GET` | `/staff-attendance/mine/summary?from&to` | any staff (self) | `{present, late, halfDay, onLeave, absent, unmarked, workingDays, percent}` |
| `GET` | `/staff-attendance/summary?date&campusId` | OWNER, CAMPUS_ADMIN | Dashboard card: `{totalStaff, byStatus, unmarked, workingDay}` |
| `GET` | `/staff-attendance?date&status&campusId&page` | OWNER, CAMPUS_ADMIN | The day register / absent list |
| `GET` | `/staff-attendance/staff/:id?from&to&status&page` | OWNER, CAMPUS_ADMIN | One person's history + summary |
| `POST` | `/staff-attendance/bulk` | OWNER, CAMPUS_ADMIN | **Existing — to be hardened, see 5.5** |

All list endpoints return `Paginated<T>` via the existing `paginate()`/`toSkipTake()`.

### 5.4 Authorization

- **Self routes take no `staffId`** — the caller's `StaffProfile` is resolved from `userId`, so
  cross-staff access is structurally impossible. This is the established pattern (`payslips/mine`,
  `/portal/*`) and the one that has never produced a leak.
- **Admin routes campus-scope via `staff.user.campusId`** using `restrictedCampusId` — for staff the
  campus dimension is the *user's* campus (unlike sections, whose campus is the class's). This is
  the same rule `getStaff` already enforces, so there is one answer per entity.
- **In-service, never a guard** (§22.8) — these read tenant rows under RLS.
- Permission-matrix row for **every** new endpoint, asserting the deny side too.

### 5.5 Hardening `POST /staff-attendance/bulk` (pre-existing gaps)

The student `markBulk` validates future dates, weekly-off/holidays, the edit window and the
enrolment date; the staff one validates **nothing**. Before it gets a UI it needs:

- **campus scope on each `staffId`** — today a campus-A admin can mark campus-B staff (§22.8 / P1.7);
- **no future dates**, and non-working days refused unless `allowHolidayOverride`;
- the **partial-failure contract** (§25.3) it already returns the shape for but never populates —
  one bad row must not reject a register the admin just typed;
- **audit** on override of a `SELF` or `SYSTEM` row, recording the previous status;
- **§5.6 payroll lock**.

### 5.6 Payroll integrity lock

`PayrollRun` is unique on `[schoolId, campusId, month, year]` and goes `DRAFT → APPROVED`.

**Once a run is APPROVED for a campus-month, staff attendance for that month is frozen** — no
create, update or day-close write. Otherwise a paid payslip silently disagrees with the register
it was computed from, and neither number can be trusted afterwards. The refusal names the run,
like every other guard in this codebase. An admin who genuinely must correct history reverses the
payroll run first — an explicit, audited act.

## 6. UX

### 6.1 Teacher — `/my-attendance` (nav opened to `TEACHER`, today `STAFF`-only)

```
My Attendance                                    [ ✓ Check in ]   ← only when selfMarking is on
                                                   08:02 · you're on time
 ┌─────────────┬─────────────┬─────────────┬─────────────┐
 │ 94%         │ 47          │ 3           │ 2           │
 │ Attendance  │ Present     │ Absent      │ On leave    │
 └─────────────┴─────────────┴─────────────┴─────────────┘
 Last month · Last 3 months · Last 6 months · Last year · Custom      ← one shared control
 [ table: Date · Session · Status · Check-in · Marked by ]
```

- The button is the whole self-service story: **one press, no form, no status picker.** Once
  pressed it becomes a receipt — *"Checked in at 08:02"* — not a toggle, because there is nothing
  to undo.
- After the grace period it reads **"Check in (you're late)"** *before* the click. The consequence
  is stated in advance, never sprung afterwards.
- On a non-working day, no button and a plain line: *"Today is a holiday — Eid."*
- **`Marked by` column** — "You", "Office", or "Auto (not marked)". A teacher must be able to see
  that a day was recorded against them by the system and dispute it.
- Absent days are a **count and a list**, never a percentage alone: "3 absent" is actionable,
  "94%" is not.

### 6.2 Owner — dashboard card

Into the existing **Needs attention** strip and the People section:

```
Staff today            42 total · 36 present · 3 absent · 3 not marked
                       ↳ "3 teachers absent today →"   (amber chip, only when > 0)
```

- `unmarked` is shown beside `absent`, never folded into it.
- On a non-working day the card reads *"Holiday — no register today"* rather than 42 absences.
- Both the chip and the tile route through the existing `canReach()` helper, so a role that cannot
  open the destination is never offered the link — the bug class this codebase has now hit three
  times.

### 6.3 Owner — `/staff-attendance` (the register / absent list)

Clicking the card lands here **pre-filtered to today + ABSENT**, in the URL (`?date=&status=`) so
it is shareable and back-navigable. Filters: date, campus, status, search. Each row: name,
employee code, campus, status pill, check-in, marked-by. Admin can correct a row inline (audited).
The `Unmarked` filter is what turns the register into a worklist.

### 6.4 Owner — `/staff/[id]/attendance` (one person, lifetime)

Reached by clicking a name anywhere above, and from the staff directory.

```
Ayesha Khan · Teacher · Main Campus
 Last month · 3 months · 6 months · Last year · All time · Custom
 ┌──────────┬──────────┬──────────┬──────────┐
 │ 91%      │ 5        │ 2        │ 1        │
 │ Attend.  │ Absent   │ On leave │ Late     │
 └──────────┴──────────┴──────────┴──────────┘
 [ paginated table: Date · Status · Check-in · Marked by · Note ]
```

- **"All time" is a real option** — the operator asked for lifetime, and a range picker that
  cannot express it would force them to guess a start date.
- Same range control component as the teacher view (`lib/date-ranges.ts`), so the two screens
  cannot drift into different definitions of "last 3 months".
- Absences are listed **worst-first by recency**, and a month with several is grouped so a pattern
  is visible — a director's question is "is this getting worse?", not "what happened on the 4th?".

## 7. Phases

| # | Deliverable | Gate |
|---|---|---|
| **S0** | Migration (`source`, `markedById`, `note`, index) + settings + `attendancePercentFromStatuses` consolidated (delete the inline copy in `/my-attendance`) | api tsc · RLS ✅ · migration-safety ✅ |
| **S1** | Harden `POST /staff-attendance/bulk` (campus scope, working-day, partial-failure, audit, payroll lock) + tests. **Ships alone, fixes a live §22.8 gap.** | integration · matrix |
| **S2** | Self check-in + range-filtered `mine`/`mine/summary`; `/my-attendance` gains the button, tiles and range filter; nav opened to TEACHER | integration · web tsc/lint |
| **S3** | Owner read side: `summary`, register list, per-staff history + the two screens + dashboard card | integration · matrix · browser |
| **S4** | QA: Playwright `staff-attendance.spec.ts`, full suite, brain update | `pnpm test` · both lints · build |
| ~~S5~~ | **Deferred by D2** — day-close job in `MaintenanceService`. Built later against the §9 rules, which are written now so the behaviour is specified before it is automated. | — |

S1 is independently valuable and independently revertable (it closes a live §22.8 gap and needs
no UI). The day-close job is deliberately last **and** deferred: it is the only part that writes
payroll-affecting rows with nobody pressing anything.

**Revised v1 scope after D2:** the office marks absences on the register; teachers mark their own
presence; `unmarked` is the completeness signal on every surface. Nothing writes an `ABSENT` row
without a human.

## 8. Decisions — ✅ ALL DECIDED (operator, 2026-08-03)

- **D1/D3 — Self check-in ships, honour-based, opt-in.** One button; timestamp + `source SELF` +
  `markedById`; status derived from the clock; admin may override. `selfMarking` defaults **false**
  for every school and is switched on for demo. IP/geofence is a later increment — `checkIn` and
  `source` are modelled now so it can be added without a rewrite.
- **D2 — `autoMarkAbsent` is NOT in the first release.** The register and check-in ship first;
  `unmarked` stays visible as the office's worklist. Derivation is enabled only once the data is
  trusted. **A job that silently creates salary deductions in week one is how a school stops
  trusting the system.** → **S4 moves out of scope for v1** (§7), the setting is still defined so
  the behaviour has a name, and the job is built later against the same tested rules.
  - **Consequence to state plainly:** until then, `ABSENT` exists only where the office records it.
    The dashboard therefore leads with **`unmarked`**, not `absent` — an absent count over a
    half-kept register would be a number that looks like fact and is not.
- **D4 — `HR_MANAGER` reads staff attendance; cannot mark or override.** They own the workforce
  record, but marking feeds pay and HR must never influence pay — the same boundary that keeps
  salary structures owner-only.
- **D5 — One check-in per day, `MORNING` only.** The session column stays in the schema (a
  two-shift school is a different product conversation) but v1 fixes it, so there is exactly one
  register per person per day and payroll's day-counting stays unambiguous.

## 9. Test plan

**Integration** — `staff-attendance.e2e-spec.ts`
1. Check-in creates `PRESENT` with `source SELF` and today's date; a second call **409s**.
2. Check-in after `dayStart + grace` yields `LATE` — **the client cannot choose the status**.
3. Check-in is refused on a non-working day, and when `selfMarking` is off.
4. A teacher **cannot** create `ABSENT`, cannot backdate, cannot mark another staff member
   (no `staffId` is accepted at all — asserted at the DTO level).
5. `mine` respects `from`/`to` and never returns another staff member's rows.
6. `bulk`: campus-bound admin marking another campus's staff → **403** (regression for the live gap).
7. `bulk`: future date refused; non-working day refused unless overridden; one bad row fails alone.
8. **Payroll lock**: with an APPROVED run for the month, any write to that month → **409** naming the run.
9. Day close: creates `ABSENT` for the unmarked, `ON_LEAVE` where an approved leave covers, and
   **nothing** for a holiday, for staff who had not joined, or for staff already marked. Idempotent
   on re-run.
10. **Payroll agreement**: a derived `ABSENT` produces exactly the same deduction as an
    admin-typed one — the two sources must not disagree.

**Unit** — the clock rule (on-time / late / boundary at exactly `dayStart + grace`) is pure and
belongs in a unit test, not an e2e.

**Playwright** — teacher checks in and sees the receipt; owner sees the absent count, clicks
through to the list, clicks a name, filters to last 3 months. Needs a staff login, which the
suite can create (unlike the admission-officer seat — staff creation is not a singleton).

## 10. Risks

| Risk | Mitigation |
|---|---|
| Self-marking reduces salary deductions dishonestly | Presence-only, today-only, clock-derived status, provenance recorded, admin override, opt-in per school |
| Day-close job writes wrong absences at scale | Opt-in, working-day + employment-date guards, idempotent, admin-overridable, audited, tested per tenant |
| Attendance edited after payroll is paid | §5.6 lock; reversing the run is the explicit path |
| Two attendance percentages drift apart | One shared helper; the inline duplicate in `/my-attendance` is deleted in S0 |
| "Absent" silently means "unmarked" | `unmarked` is a separate number on every surface, and the day-close job is what makes `absent` real |

## 11. Out of scope

Biometric/RFID devices, geofencing, shift rosters and two-session staff days, overtime,
substitute-teacher assignment when someone is absent, and notifying a parent that a class is
uncovered. Each is a feature in its own right; none is needed to answer the operator's question.
