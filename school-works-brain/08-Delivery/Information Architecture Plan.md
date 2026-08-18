---
title: Information Architecture Plan (categorisation — campus → class → section → subject)
type: plan
status: PLANNED — 2026-08-18, decisions open, nothing built
updated: 2026-08-18
---

# 🗂️ Where things live, and why nobody can find them

> Related: [[Timetable & Bell Schedule Plan]] · [[UI Retheme Plan]] · [[Key Decisions]]

## 1. What happens today, checked in the code

Raised by the operator from two screenshots: the Classes page and the Staff page **both report 24
subjects with no teacher**, and neither is where you fix it.

| | Today |
|---|---|
| Classes grouped by campus | ⚠️ Yes, but as a **flat heading in one long scroll** (`groups` in `classes/page.tsx`), not a level you navigate. |
| Add a class | ⚠️ A permanent form **above** the classes, occupying the top of the page whether or not you are adding one. |
| Which subjects have no teacher | ⚠️ **Answered on two screens, by two different mechanisms.** See §2.1. |
| Subjects | ❌ **No home.** They live inside one class's page. "13 Subjects taught" is a stat with nowhere to click. |
| Campus | ⚠️ A **filter**, not a level — yet it is the top of the real hierarchy, and `Campus Hub` sits in a different nav group from the classes it contains. |
| Academics nav group | ⚠️ **9 of 22 items** — as many as the next three groups combined. |
| Fixing a gap | ⚠️ The chip links to `/classes/:id`. You land on the class and then hunt for the row. |

### 1.1 The hierarchy the domain actually has

```
School
└── Campus                          ← the real top level
    ├── Bell schedule               ← campus default, or a wing over named classes
    └── Class  (Grade 9)
        ├── Subject  (Grade 9 · Chemistry)          — periodsPerWeek lives here
        └── Section  (A, B)
            ├── studies      → SectionSubject       — which subjects THIS section takes
            ├── taught by    → TeacherAssignment    — the gap is a missing row here
            └── scheduled    → TimetableSlot        — day + period + room
```

**Every edge is containment.** Nothing in that tree is a cross-reference or a lookup — a section
cannot exist outside a class, a class cannot exist outside a campus. The UI is the only place this
is not obvious.

## 2. The problems, named

### 2.1 ⚠️ One fact, two owners, two implementations — this is a correctness bug, not a layout one

Both screens say **24**. They are not reading the same number:

- **`/classes`** computes it **in the browser**: `sections.reduce(...)` joining sections × subjects ×
  assignments client-side.
- **`/staff`** reads **`coverageGaps` from a server-computed summary**.

They agree today. Nothing makes them agree tomorrow. This repo has been bitten by exactly this shape
before and wrote it down: *three copies of the attendance percentage once gave a parent, a teacher
and a director three different figures for one child.* A second implementation of a derived fact is
a defect the day it is written, not the day it drifts.

**So the first phase of this plan is not a redesign at all — it is deleting one of these two.**

### 2.2 `/classes` is three screens stacked in one scroll

A create form, a campus-grouped list, and a school-wide gap report share one page with no separation.
The create form is permanently open at the top; the thing you came for is below it.

### 2.3 Campus is a filter where it should be a level

`groups` already partitions by campus and renders a heading per campus — the code knows the
hierarchy. But two campuses × 17 classes is one long scroll, and a campus admin (who only ever has
one campus) still pays for the grouping UI. Meanwhile **Campus Hub sits in Administration**, three
groups away from the classes it contains.

### 2.4 Subjects have no home

`GET /subjects/catalogue` exists and returns every subject with the classes teaching it. **No screen
calls it.** Subjects are only reachable by opening a class, so "which classes teach Chemistry, and
who teaches it where" cannot be asked at all — and `periodsPerWeek`, added by the timetable work,
has one editing surface buried two levels deep.

### 2.5 Academics carries nine items covering three unrelated jobs

`Classes · Attendance · Leave requests · Timetable · School Timings · Cover · Exams & Results ·
Reports · Performance` mixes **what the school IS** (changes a few times a year), **what happens
today** (changes hourly), and **what it produced** (read-only). They are not the same kind of thing
and they are not used by the same person on the same day.

### 2.6 The gap report links to the class, not to the fix

`/classes/:id` is the right destination; landing at the top of it is not. With 13 subjects on a
class, the chip that told you *"9th A · Chemistry"* drops you somewhere you have to search.

## 3. The proposed shape

> **Group by the question being asked, not by the department that owns it.**

### 3.1 Navigation: seven groups, none over five

| Group | Items | The question it answers |
|---|---|---|
| **Overview** | Dashboard · Reports · Performance | How are we doing? |
| **Enrollment** | Admissions · Admission Portal · Students | Who is joining, and who is here? |
| **School structure** | **Campuses · Classes · Subjects · School Timings · Timetable** | What IS the school? |
| **Teaching** | Attendance · Leave requests · Cover · Exams & Results | What is happening today? |
| **Finance** | Fees · Payment submissions | Where is the money? |
| **People** | Staff · Staff Attendance | Who works here? |
| **Administration** | School configuration · School settings · School calendar | The rules everything runs under |

Two moves do most of the work: **Campuses comes out of Administration** and joins the things it
contains, and **Academics splits** into structure / teaching / insight. Same item count, no group
over five, and each group is a sentence rather than a department.

### 3.2 Classes — campus as a real level

```
Classes                                        [ + Add class ]

┌ Main Campus (11) ─┬─ Falcon Campus (6) ─┐   ← campus is a control, not a heading
│                                          │
│  ⚠ 24 subjects need a teacher   [Show only these]
│
│  ┌────────────────────────────────────────────┐
│  │ Grade 9              2 sections · 13 subjects│
│  │ 34 of 80 seats            ⚠ 6 need a teacher │
│  │                                    Manage →  │
│  └────────────────────────────────────────────┘
│  ┌────────────────────────────────────────────┐
│  │ Grade 10  ⚠ Needs subjects   1 section · 0  │
```

- **The campus control is a segmented control** at two-plus campuses and **disappears entirely at
  one** — most schools have one campus and should never see a chooser for a choice they do not have.
  A campus admin sees no control either: they have exactly one.
- **Add a class becomes a button**, opening an inline row at the top of that campus's list. It stops
  occupying the page when nobody is adding a class.
- **The gap count sits on each class card**, where the fix is, and once at campus level as a filter —
  not as a separate school-wide report living somewhere else.

### 3.3 Subjects — the missing screen

One screen backed by the existing `/subjects/catalogue`, answering what no screen answers today:

| Subject | Taught in | Periods/week | Without a teacher |
|---|---|---|---|
| Chemistry | Grade 9, Grade 10 | 5 | ⚠ 3 sections |
| Urdu | Grades 8–10 | 5 | — |

This is also the natural home for **`periodsPerWeek`**, which currently has one editing surface
inside a single class's subject table. A coordinator allocating the year's load thinks in subjects
across classes, not one class at a time.

### 3.4 One source for a derived fact

The gap set becomes a **single server-computed read** that both the Classes screen and the Staff
summary consume — the same discipline `withTimes()` follows in the timetable service, where three
screens share one resolution so they cannot disagree about when period 3 is.

⚠️ **The client-side `gaps` reduce in `classes/page.tsx` is deleted, not refactored.** Keeping it
"for speed" is how the second implementation survives.

## 4. Phases

| | | |
|---|---|---|
| **S0** | **One source for the gap fact** | Delete the client-side reduce; both screens read one endpoint. **Correctness, not cosmetics — this ships first even if nothing else does.** |
| **S1** | Nav regroup | Seven groups; Campuses moves in beside what it contains |
| **S2** | Classes: campus as a level | Segmented control (hidden at one campus), class cards with their own gap counts, Add-class becomes a button |
| **S3** | Subjects screen | Backed by the existing catalogue endpoint; `periodsPerWeek` gets a cross-class home |
| **S4** | Deep links land on the fix | `/classes/:id#subject-<id>` — the chip takes you to the row, not the page |
| **S5** | The Staff gap block becomes a link | Staff keeps *"24 subjects need a teacher →"*; the list itself lives with the classes |

## 5. Decisions needed

- **D1 — Campus control: segmented tabs, or a route?** Tabs keep it one screen and one load; a route
  (`/campuses/:id/classes`) makes campus bookmarkable and shareable, which matters more the more
  campuses a school has. Recommend **tabs now, route if a school passes ~4 campuses**.
- **D2 — Does Subjects deserve a screen, or a tab on Classes?** A screen is the honest answer to
  §2.4, but it adds a nav item. Recommend **a screen**, because the question it answers is
  cross-class and a tab inside Classes cannot be.
- **D3 — Does `/staff` keep the gap list?** It is genuinely useful there when hiring. Recommend
  **keeping the count and the link, dropping the 40-chip list** — one list, one home.
- **D4 — Is "School structure" the right group name?** Alternatives: *Setup*, *Academics*, *The
  school*. It has to read as a noun a principal would use.

## 6. What this deliberately does not change

- **No API rewrites.** S0 consolidates onto an endpoint that already exists; S3 uses a catalogue
  endpoint that already exists and has never had a caller.
- **No permission changes.** Every screen keeps the roles it has; moving a nav item between groups
  changes where it renders, never who may open it. ⚠️ The `navItemFor` role gate is keyed on `href`,
  so a moved item keeps its gate — but **a renamed href would silently open the route to everyone**,
  which is why S1 moves items between groups and renames none.
- **No data model changes.** The hierarchy already exists in the schema; this is about showing it.

## 7. Risks

- ⚠️ **S1 is the riskiest phase for the least visible gain.** Moving nav items is where a role gate
  gets dropped, and this repo has already shipped `GET /enrollments` with no `@Roles` at all. The
  permission matrix must be re-run, and every moved item checked in both directions.
- **A campus admin must never see a campus chooser.** They have one campus; a control offering a
  choice they cannot make is the same defect as the seat that offered to fill itself again.
- **The one-campus case is the common case.** Every layout here has to look deliberate with a single
  campus and no gaps, not merely degrade politely.
- **S0 can regress a number that is currently correct.** Both screens show 24 today; the consolidated
  read must be proved against the same fixture before either screen switches to it.
