---
title: Information Architecture Plan (categorisation — campus → class → section → subject)
type: plan
status: SUPERSEDED BY ITS OWN AUDIT — v1 planned 2026-08-18, audited the same day. See §8–§9. Nothing built.
updated: 2026-08-18
---

# 🗂️ Where things live, and why nobody can find them

> Related: [[Timetable & Bell Schedule Plan]] · [[UI Retheme Plan]] · [[Key Decisions]]

> [!warning] **v1 of this plan was audited and failed on its central claim: it is not a whole-system
> plan.** It generalised from one screen pair and proposed fixes shaped like that pair. The same
> patterns are on **12 screens, 31 tiles and 18 endpoints**. **§8 is the audit; §9 is the plan it
> should have been.** Read those first — §1–§7 are kept because their findings are correct; only
> their scope is not.

> [!info] **The target shape this plan builds toward is [[System Structure]]** — the containment
> tree, the five laws (one per audit finding), the navigation with all 18 missing capabilities
> placed, and the countable success criteria this plan lacked. **This document is the analysis;
> that one is the design.**

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

## 8. Audit — 2026-08-18, same day

Asked whether this plan was ideal and whether it covered the whole system. **It did not.** Every
figure below is counted from the code, not estimated.

### 8.1 ⚠️ The scope error, which is the whole finding

v1 looked at two screens, found a real defect, and **proposed a fix shaped like those two screens**.
It named each problem after the place it was noticed:

| v1 called it | It actually is |
|---|---|
| "Campus is a filter **on Classes**" | Campus is a filter on **12 screens**, each with its own selector |
| "**Subjects** have no home" | **18 API capabilities** have no screen at all |
| "The gap count is computed twice" | Correct — but one instance of a pattern, not the pattern |
| *(not mentioned at all)* | **31 metric tiles across the product, 0 clickable** |

A plan that names a defect after the screen it was spotted on will fix that screen. That is exactly
what v1 would have done.

### 8.2 The biggest UX defect in the product, and v1 missed it entirely

**31 metric tiles. Zero are links.**

Every headline number the product shows is a dead end. *"24 Without a teacher"* — not clickable.
*"13 Subjects taught"* — nothing to open. *"17 of 720 seats"*, *"6 Joined this year"*, *"1 Setup
unfinished"* — all dead. The product computes the right number, shows it prominently, then makes the
reader go and find the underlying rows by hand.

This is **higher leverage and lower risk than anything in v1's phase list**: it changes no data, no
permissions and no layout, and it turns every existing summary into a working entry point. v1 spent a
whole phase (S4) making *one* set of chips deep-link better and never noticed the other thirty.

⚠️ **Correction to the first statement of this finding, and it strengthens it.** "Zero clickable" is
accurate for the 31 `.metric` tiles, but the product **already has the pattern**: `.metric-link` is
defined in `globals.css` with hover, focus-visible and a documented `.metric.metric-link` variant,
and is already in use on `/dashboard` and `/staff-attendance`. So this is not a design problem at
all — it is an **existing, styled, accessible component that 31 tiles on ten screens do not use.**
The fix is cheaper than first claimed, and the absence is harder to defend.

### 8.3 ⚠️ 18 API capabilities ship with no user interface

Counted by walking all **248** controller routes and checking whether each route's own path segment
appears anywhere in `apps/web`:

| Area | Missing surface | Why it matters |
|---|---|---|
| **Auth** | `POST /auth/change-password`, `POST /auth/forgot-password` | **Nobody can change their own password or recover a lost one.** The owner resets staff passwords by hand. |
| **SMS** | `GET/PUT /sms/templates`, `GET /sms/credits`, `GET /sms/logs` | The product **texts parents** — fee reminders, absences — with no screen for the templates, the credit balance, or what was actually sent. |
| **Fees** | `waive`, `payments/:id/reversals`, `advances`, `integrity-check` | Waiving a fee and reversing a payment are **audited financial actions**, built and reachable only by API. |
| **HR** | `salary-structures` (POST/GET), `mark-paid` | Payroll has no editing surface. |
| **Students** | `guardians/:parentId/verify-phone` | Phone verification gates absence SMS. |
| **Documents** | `GET /documents` | No documents screen exists in `app/(app)/` at all. |

⚠️ **No gate notices this.** A route can ship, pass its tests, carry a permission-matrix row, and
never be reachable by a human — and nothing fails.

### 8.4 Campus is a filter, twelve times over

`admissions · admissions-team · calendar · campuses · classes · classes/[id] · performance · setup ·
staff · staff-attendance · students · timings` each implement their own campus selector. There is no
shared campus context, so:

- a **campus admin sees a chooser for a choice they cannot make, twelve times**;
- "switch campus" is not an action the product has — only "re-pick the campus on this screen";
- there are twelve chances for one selector to scope differently from the API.

v1 proposed fixing this on one screen.

> [!warning] **⚠️ Correction (found building IA2): "12 selectors / a chooser used 12 times" is
> largely false.** Verified per screen: only **4** have a campus **list filter**
> (performance, staff-attendance, students, staff). **performance and staff-attendance already hide
> it** for exactly the case this section describes (`isOwner && campuses.length > 1`), so a campus
> admin never sees them. students and staff show a redundant two-option select ("All" + the admin's
> one campus). The other screens counted here use campus to **create** an entity (admissions,
> calendar, timings — you cannot make a class/closure/schedule without choosing a campus) or to
> **group a display** (classes, setup); neither is a duplicated selector, and both must keep a
> campus reference. So the real IA2 surface is ~2 redundant selects plus, for a multi-campus OWNER,
> the lack of a campus choice that persists across the 4 filter screens. Much smaller than stated.

### 8.5 Derived facts computed in more than one place

- **Teacher gaps — a real duplication.** `/classes` joins sections × subjects × assignments **in the
  browser** to decide what a gap is; `/staff` reads a **server-computed** `coverageGaps`. Two
  implementations of one derivation. **Fixed in IA1**: both now read `SetupService.coverageGaps`, and
  a spec asserts the two endpoints return the same set for the same session.

> [!warning] **⚠️ Correction (found building IA1): "Seats filled" was NOT a second implementation.**
> The audit listed `/classes` aggregating `section.enrolled` vs `/reports/class-strength` as a
> duplication. It is not. `section.enrolled` is itself **server-computed** — `listSections` runs a
> `groupBy` on `studentEnrollment` (status ACTIVE), the same table and filter `class-strength` uses —
> and the client merely **sums** those authoritative per-section counts. Summing server-provided
> numbers is presentation, exactly like `/staff` counting the server's gap list; it is not a second
> derivation of the fact. So IA1 leaves it alone. **Verifying the claim beat acting on it** — the fix
> here would have been churn that removed nothing.

### 8.6 Defects in the plan as a document

- **No success criteria.** Six phases, and no way to tell afterwards whether the IA improved. Every
  other plan in this repo states its gates.
- **The phase order contradicts its own risk section.** S1 (nav regroup) runs second while §7 calls
  it *"the riskiest phase for the least visible gain."* If that sentence is true — and it is — S1
  belongs last.
- **All four decisions in §5 are about Classes.** None asks the question that governs the system:
  *what is the rule for when a capability gets a screen, and when a number gets a link?*
- **It assumed the sidebar was the problem.** With 22 items across 7 groups, navigation is not the
  bottleneck; the **dead ends behind it** are. Regrouping a menu whose destinations are dead ends
  produces a tidier menu, not a usable product.

### 8.7 What is genuinely not broken

Stated because an audit that only finds faults is not measuring:

- **Nav ↔ route mapping is clean in both directions** — every `NAV` href has a page directory and
  every page directory has a `NAV` entry. No orphaned routes, no dangling links.
- **Campus grouping already exists in the data layer** on Classes (`groups`): the hierarchy is known,
  it is merely rendered flat.

## 9. The plan it should have been

Reordered by leverage ÷ risk, and rescoped from "Classes and Subjects" to "the product".

| | | Why here |
|---|---|---|
| **IA0** | **Every metric tile becomes a link** — 31 tiles, each to the filtered list behind it | Highest leverage, near-zero risk: no data, permission or layout change. Turns every existing summary into an entry point. |
| **IA1** | **One source per derived fact** — delete the client gap reduce and the client seats aggregate | Correctness, not cosmetics |
| **IA2** | **A shared campus context** — one selector in the shell, not twelve on twelve screens; invisible to a single-campus school and to a campus admin | Kills 12 duplications and makes "switch campus" a real action |
| **IA3** | **The missing screens, in risk order:** password change/reset, then SMS admin, then fee waivers/reversals, then payroll | A user who cannot change their own password is a security problem, not a UX one |
| **IA4** | Classes / Subjects redesign (v1's S2 + S3) | Now one instance of a solved pattern rather than the whole plan |
| **IA5** | Nav regroup (v1's S1) | **Last.** Riskiest, least gain, and pointless until the destinations are worth reaching |

**Add a gate, or §8.3 recurs.** A check that every non-webhook, non-internal route has a caller in
`apps/web` — the same shape as the tenant-enrolment assertion added to `check-rls-coverage.mjs`,
which exists precisely because that gate *"could only police tables that had already opted in."* A
route with no UI should be a deliberate, listed exception, not an accident nobody can see.

**The decision v1 should have asked:** *when does a capability earn a screen, and when does a number
earn a link?* Without a stated rule, the next 18 routes ship exactly the same way.
