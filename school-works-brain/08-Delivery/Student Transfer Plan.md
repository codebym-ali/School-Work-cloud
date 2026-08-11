---
title: Student Transfer Plan (moving a child between sections, classes and campuses)
type: plan
status: X0 + X1 SHIPPED 2026-08-11 · X2–X3 planned
updated: 2026-08-11
---

# 🔀 Moving a student

> Related: [[Students & Admissions]] · [[Multi-Tenancy & Isolation]] · [[Key Decisions]] · [[Progress Tracker]]

## 1. What exists, checked in the code

**The backend can already do it, and has been able to since M2.** `POST /enrollments/transfer`
takes `{ studentId, toSectionId }` and:

- closes the current ACTIVE enrolment as `TRANSFERRED_OUT` with an `endedAt`;
- creates a **new** ACTIVE enrolment on the target section, taking `classId` **and `campusId` from
  that section** — so it moves a child between sections, classes *and* campuses;
- audits both sides (`ENROLLMENT_TRANSFERRED`, old and new enrolment ids).

**Moves are new rows, never a field update**, which is the right design: last term's attendance and
marks stay attached to the enrolment they happened under. It is covered by the admit-journey
integration spec and gated `OWNER_ADMIN` / `CAMPUS_ADMIN`.

### ⚠️ 1.1 Nobody can reach it

`apps/web` has no client method, no action on the Students page, nothing on the class workbench.
Grepping `transfer` across the web app returns only *bank* transfers on the fee screens.

**So a school cannot move a student today.** This is the fourth instance of the same shape in this
project — CSV import, `/my-attendance`, `/my-leaves` were the others — where the API permits
something and the UI silently does not, so the capability exists and nobody has it.

### ⚠️ 1.2 No campus check

`EnrollmentService` does not import `assertCampusAccess` at all. Every comparable write is
campus-scoped in the service (§22.8) — `StudentsService.create` does exactly this on admission —
so a `CAMPUS_ADMIN` can move a student **into or out of another campus**. That is a scoping hole in
a write that relocates a child between campuses, and it is the most serious of the three.

### ⚠️ 1.3 No capacity check

Admission honours `sectionCapacityMode` (`HARD` refuses, `ADVISORY` allows and the UI warns).
Transfer ignores it, so a 41st child can be moved into a 40-seat section that the admissions flow
would have refused. **The rule currently lives as a private method on `StudentsService`**, which is
why transfer never got it.

### ⚠️ 1.4 No permission-matrix rows

Neither `/enrollments/transfer` nor `/promotions` has a row, so the merge-blocking conformance check
has never asserted who may call them. A route with no row is not "assumed safe", it is unmeasured —
the same gap that let two shipped roles go missing from the blueprint.

## 2. Design thesis

**A transfer is an administrative act with consequences, not an edit.** It ends one enrolment and
begins another; it can move money (fee plans are per class), it changes whose register the child
appears on tomorrow, and it is visible to a parent. So the UI's job is not to make it fast — it is
to make the consequences legible **before** the click, and to leave a trail after.

Three things follow:

- **Show what is changing, both ends.** From 9-A to 9-B is a different act from Grade 9 to Grade 10,
  and moving campus is different again. The screen should name all three when they change.
- **Show the room.** A section's seats are the one fact that decides whether this is even possible,
  and the office should see it before choosing, not after being refused.
- **Say what does not move.** Attendance and marks stay with the closed enrolment. A user who
  expects the whole year to follow the child will otherwise report it as data loss.

## 3. Phases

- **X0 — close the three gaps. ✅ SHIPPED 2026-08-11.** Campus scoping on both ends, the shared capacity rule, matrix rows
  for transfer *and* promotions. Backend only, no UI. **Fixes 1.2, 1.3, 1.4.**
- **X1 — the move dialog on the Students page. ✅ SHIPPED 2026-08-11.** The general home for "find a child, act on them",
  and it works when the user does not know which class they are in today. **Fixes 1.1.**
- **X2 — the same action from the class workbench** (`/classes/[id]`), where somebody *notices* the
  problem while looking at a roster. Same component, second entry point.
- **X3 — tests, browser pass, brain.**

## 4. X1 — what the dialog says

```
Move Ayesha Malik

  Currently   Grade 9 — A · Falcon Campus

  Move to     Campus ▾   Class ▾   Section ▾
              Grade 9 — B  ·  38 of 40 seats

  ⚠ Attendance and marks already recorded stay with Grade 9 — A.
    Only tomorrow onwards moves.

                                   [ Cancel ]  [ Move student ]
```

- **Seats are shown on the target**, live, from the section list — `38 of 40` reads better than a
  refusal after the fact. In `HARD` mode a full section is disabled with the reason; in `ADVISORY`
  it is selectable and warns, matching what admission already does.
- **Campus appears only when the school has more than one.** A single-campus school should never be
  asked a question with one answer.
- **The sentence about what stays** is not a nicety: it is the difference between a correct mental
  model and a support ticket about missing attendance.

## 5. Decision TAKEN for X1 (2026-08-11) — option 1

**A row action beside "Change status", not inside it.** ⚠️ **Correction to how this was framed:**
the row has no *menu* — it carries inline buttons (View · Change status · Delete) — and there IS a
student detail view (`StudentProfile`, rendered in place), which the options below said there was
not. That was inferred from the file listing rather than from reading the file. Option 1 was chosen
and still holds on its merits: a move is a **correction, not a sanction**, so it sits beside the
status dialog rather than inside it with the four destructive changes. The profile view remains the
natural second home for it — see X2. The options as considered:

1. **In that existing menu**, as "Move to another class…". One place for everything you do *to* a
   student; no new affordance to learn. Risk: it sits beside destructive status changes, and a
   transfer is not a status change.
2. **A separate button on the row.** More discoverable and clearly distinct from status. Risk: row
   width — the students table is already dense, and this is the screen that must stay usable on a
   phone.
3. **On the student's detail view**, if one exists, with the row menu linking to it. Most room to
   explain consequences; most clicks for a routine correction.

## 6. What this deliberately does not change

- **Promotions.** `POST /promotions` is a separate bulk act (whole class → next year) and has its
  own service. X0 gives it a matrix row because it has none; nothing else here touches it.
- **The "new rows, never an update" design.** It is correct and the reason history survives.
- **Fee consequences.** A class change can change a child's fee plan. X1 states the fact; deciding
  what should *happen* to already-issued invoices is a fees question, not a transfer one, and it
  needs its own decision rather than being smuggled in here.

## 7. Risks

- **A transfer mid-month interacts with fee invoices already issued for the old class.** Out of
  scope above, but it will be asked about the first time a school uses this in anger.
- **Campus scoping newly refuses something that used to work.** A campus admin who has been moving
  students across campuses (possible today, if anybody found the endpoint) will start getting 403s.
  Correct, and worth stating in the change rather than discovering.

---

## 8. X0 as built — 2026-08-11

**Shipped:** campus scoping on both ends of a transfer, the section-capacity rule made shared,
three permission-matrix rows — and a **fourth gap the matrix rows themselves uncovered**.

### The capacity rule moved rather than being copied

`assertSectionCapacity` was **private on `StudentsService`**, which is exactly why transfer never
had it. It is now `SetupService.assertSectionHasRoom`, with admission delegating to it. One rule,
one place — the same discipline as `whoIsAway()` (Cover C3) and `myUnmarkedToday()` (Shell T2).
Copying it into `EnrollmentService` would have created the two-implementations pattern this codebase
has paid for more than any other.

`ADVISORY` still lets the write through: a school that has not opted into a hard cap is saying its
class sizes are guidance, and refusing them would be the product overruling the school about its own
rooms. The test asserts **both** modes, because a capacity test that only ever sees a refusal cannot
tell a working rule from a broken endpoint.

### ⚠️ Adding a matrix row found a fourth hole

`GET /enrollments` had **no `@Roles` at all** — every authenticated session, including a student or
a parent, could enumerate which child is in which class across the whole school. It was also
**not campus-scoped**, so a campus admin could read every campus's roster.

Both are now closed: `OWNER_ADMIN` / `CAMPUS_ADMIN` / `ADMISSION_CONTROLLER` / `TEACHER` (the
attendance roster and marks entry both load from here), with `campusId` filtering in the service.

**This is the argument for the permission matrix in one incident.** The write beside it was
correctly gated the whole time — *a guarded write does not imply a guarded read*, which was already
a recorded lesson here, and the row is what made it visible rather than assumed.

### ⚠️ The campus test could only fail in one direction

The first version created a campus admin of the **student's own** campus and had them move the child
away. Deleting the source-end check broke nothing — the destination check catches that move on its
own. So "both ends" was a claim in a comment, not a tested rule.

It now tests the asymmetric case too: an admin of the **far** campus pulling the child in, where the
destination is legitimately theirs and only the source can refuse. Probed separately, each end now
fails its own case.

*A guard with two halves needs a case per half; one case will find whichever half runs first and
tell you nothing about the other.*

### Proven non-vacuous

| Probe | Result |
|---|---|
| Capacity ignored on transfer | **1 failed** |
| Source-end campus check removed | **1 failed** (0 before the pull-in case was added) |

### Behaviour changes worth stating

- A campus admin who was moving students **across** campuses will now get 403. Correct, and
  previously possible for anyone who found the endpoint.
- A campus admin's `GET /enrollments` now returns **their campus only**.
- A move into a full section is refused in `HARD` schools — as admission already was.

---

## 9. X1 as built — 2026-08-11

**Shipped:** `api.enrollments.{list,transfer}`, a **Move** action on each Students row, the
`MoveStudentDialog`, and `test/e2e/student-move.spec.ts`.

### What the dialog does, and why each part is there

| | |
|---|---|
| *Currently 8th-B* | resolved from the student's **active enrolment** — `Student` on the row carries no placement, and without this a user cannot tell a correction from a mistake |
| `A — 4 of 40 seats` | seats on the option itself, read **while choosing** rather than after a refusal |
| Full section | refused before the click in `HARD` schools, warned about in `ADVISORY` — the same distinction admission draws |
| Same section | button disabled, with *"That is the section they are already in"* |
| *Only today onwards moves* | the sentence that stops the history staying behind being reported as data loss |

The API stays the authority on all of it — campus scoping both ends, capacity. The dialog shows the
same facts early so a refusal is **rare**, never *instead of* the check.

### Verified live (demo, owner session)

Opened on *Abdullah Mohsin* → **"Currently 8th-B"**; picking 9th listed *A — 4 of 40 seats* and
*B — 1 of 40 seats*; moving produced **"Abdullah Mohsin moved to 9th-A"**, closed the dialog and
reloaded the list. Reopening showed **"Currently 9th-A"** and selecting 9-A again disabled the
button with the same-section notice. Moved back to 8th-B; demo left as found.

### Proven non-vacuous

Dropping the *"Only today onwards moves"* clause fails the spec. The e2e also asserts the **old
section is empty afterwards** — checking only the destination would pass on an endpoint that
*copied* an enrolment instead of moving it.

### ⚠️ Two things worth carrying forward

- **My first probe was malformed JSX** and broke the page compile, so the run failed in the login
  *setup* projects and proved nothing. A probe has to break the **behaviour** under test, not the
  build — otherwise the red tells you about your edit, not about the test.
- **The spec makes no login of its own** and reuses the shared owner session, because the suite sits
  exactly at the §29 ceiling of 5 per IP per 15 minutes. `seedClassSectionStudent` does log in as
  the admission officer, which is why the durable fix (a shared `storageState` per actor) matters
  more with every teacher- or student-facing spec added.

### Still open (X2–X3)

X2 — the same dialog from the class workbench and from `StudentProfile`, where somebody actually
*notices* a child is in the wrong room. X3 — the wider browser pass.
