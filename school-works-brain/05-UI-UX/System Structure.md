---
title: System Structure (the hierarchy every screen sits in)
type: reference
status: TARGET DESIGN — 2026-08-18, derived from the IA audit. Not yet built.
updated: 2026-08-18
---

# 🏛️ System Structure

> The target shape. The analysis that produced it, and the phases that get there, are in
> [[Information Architecture Plan]] §8–§9. Related: [[School-Admin.pk Design Reference]] ·
> [[Key Decisions]]

This document exists because the audit found the product had **no stated structure** — 12 screens
each inventing a campus selector, 31 numbers leading nowhere, and 18 capabilities with no screen at
all. None of those are separate bugs. They are one missing document, and this is it.

---

## 1. The five spines

Fifty-eight models cluster into five, and **every screen belongs to exactly one**:

| Spine | Answers | Owns |
|---|---|---|
| **Structure** | What *is* the school? | Campus, AcademicYear, Class, Section, Subject, SectionSubject, BellSchedule, Term, Holiday |
| **People** | Who is here? | Student, Guardian, Enrollment, StaffProfile, TeacherAssignment, Inquiry → Admission, User |
| **Teaching** | What happens on a given day? | TimetableSlot, Attendance, Leave, Cover, Exam, Result, ReportCard, ClassTest |
| **Money** | What does it cost, and who paid? | FeeHead, FeeStructure, Invoice, Payment, Reversal, Discount, Credit, SalaryStructure, Payroll, Payslip |
| **Operations** | How does the school run itself? | SmsTemplate/Log/Credits, Document, AuditLog, ModuleAccess, Settings |

A screen that seems to belong to two spines is a screen doing two jobs. That is how
`/staff` ended up owning a *Structure* report ("Subjects with no teacher") — People spine, Structure
content.

---

## 2. The containment tree

```
School ─────────────────────────────────── level 0   settings, config, calendar
└── Campus ─────────────────────────────── level 1   THE SHELL CONTEXT, not a per-screen dropdown
    ├── Bell schedule                                  campus default, or a wing over named classes
    ├── Class  (Grade 9) ───────────────── level 2
    │   ├── Subject  (Grade 9 · Chemistry)  level 3   periodsPerWeek lives here
    │   └── Section  (A, B) ───────────── level 3
    │       ├── SectionSubject ────────── level 4     what THIS section studies
    │       ├── TeacherAssignment ─────── level 4     ⚠ a "gap" is a missing row here
    │       ├── TimetableSlot ─────────── level 4     day + period + room
    │       └── Enrollment → Student ──── level 4
    ├── Staff ──────────────────────────── level 2
    └── Fee structure ──────────────────── level 2
        └── Invoice → Payment ─────────── level 3/4
```

**Every edge is containment, not reference.** A section cannot exist outside a class; a class cannot
exist outside a campus. The schema has always known this. The UI is the only place it is invisible.

---

## 3. The five laws

Each law closes one audit finding. They are stated as rules, not preferences, because the audit's
root cause was that nothing was written down.

### Law 1 — A number is a link to the rows it counts

> **Every metric tile navigates to the filtered list behind it. A number with no list behind it is
> not a tile.**

Closes *31 tiles, 0 clickable*. ⚠️ **This invents nothing**: `.metric-link` already exists in
`globals.css`, fully styled with hover, focus-visible and a documented `.metric.metric-link` variant,
and is already used on `/dashboard` and `/staff-attendance`. The pattern is settled; 31 tiles on ten
screens simply do not use it.

| Tile | Goes to |
|---|---|
| Classes · Sections | `/classes` filtered to the campus |
| Seats filled | `/classes` sorted by fill, low first |
| Subjects taught | `/subjects` |
| **Without a teacher** | `/subjects?gap=1` — the list, not the class page |
| Staff on record | `/staff` |
| Setup unfinished | `/staff?setup=incomplete` |
| Joined this month / year | `/staff?joined=month` |
| Open inquiries · Ready to admit | `/admissions?status=…` |
| Tests today | `/admissions?test=today` |
| Attendance · Days absent · Not marked | the register, filtered to that status |
| Outstanding fees | `/fees?status=outstanding` |

### Law 2 — Campus is chosen once, in the shell

> **Campus is a property of the session, not a control on every screen. Screens read it from
> context.**

Closes *campus is a filter on 12 screens*.

- **One campus** → no control at all.
- **A campus admin** → no control; they have exactly one, and offering a choice they cannot make is
  the same defect as the seat that offered to fill itself again.
- **An owner with several** → one switcher in the app shell, beside the school name. Switching
  re-scopes every screen at once, which is what "switch campus" has always meant to a director and
  has never meant to this product.
- ⚠️ The shell control **narrows**; it can never widen. The API remains the authority and continues
  to force-scope a campus-bound user regardless of what the client sends.

### Law 3 — A capability has a screen, or a name  ✅ *(gate built, IA3)*

> **Every non-webhook route is reachable by a human, or is a listed exception.**

Closes *capabilities with no UI*. **Built in IA3** as `route-coverage.e2e-spec.ts`: it reads the
**live Express router** and fails on any route neither called from `apps/web` nor listed. (⚠️ The
audit's "18" was wrong three ways — a per-file prefix bug and a substring heuristic — so the gate
reads the real route table instead of parsing files. The true figure was **19 genuine gaps**, with
the seven `/reports/*` routes NOT among them: they are reached via a dynamic `apiGet(\`/reports/${key}\`)`,
which the gate's matcher now accounts for.) The known backlog is enumerated in the gate itself and
shrinks as screens ship. First screen built: **SMS admin** (`/sms`), which also fixed a latent
over-exposure — the SMS read routes had no `@Roles` and were readable by any staff.

### Law 4 — A derived fact has one implementation, server-side  ✅ *(gaps: done, IA1)*

> **A number computed in the browser that the server can compute is a second implementation, and a
> defect the day it is written.**

Closes *the teacher-gap fact, computed twice*. (⚠️ The seats figure looked like a second instance and
was not — `section.enrolled` is server-computed and the client only sums it; verifying beat acting.
The precedent this law rests on is written down: three copies of the attendance percentage once gave a
parent, a teacher and a director three different figures for one child.) **Done in IA1**: gaps unified
in `SetupService.coverageGaps`, both `/classes` and `/staff` read it, asserted equal by spec.

### Law 5 — A link lands on the row, not the page

> **A deep link carries enough to scroll to and highlight the thing it named.**

`/classes/:id#subject-<id>`, not `/classes/:id`. Naming *"9th A · Chemistry"* and then dropping the
reader at the top of a 13-subject page is most of a fix, and none of the relief.

---

## 4. Navigation — seven groups, none over five  ✅ *(built, IA5)*

Ordered by the spines, with every missing capability placed. **Bold = does not exist today.**

| Group | Screens | Spine |
|---|---|---|
| **Overview** | Dashboard · Reports · Performance | cross-cutting |
| **Enrollment** | Admissions · Admission Portal · Students | People |
| **School structure** | **Campuses** · Classes · **Subjects** · School Timings · Timetable | Structure |
| **Teaching** | Attendance · Leave requests · Cover · Exams & Results | Teaching |
| **Finance** | Fees · Payment submissions · **Waivers & reversals** · **Advances** | Money |
| **People** | Staff · Staff Attendance · **Payroll** | People |
| **Administration** | School configuration · School settings · School calendar · **SMS & notifications** · **Documents** | Operations |

Two of the eighteen gaps are **not** new screens, and placing them correctly matters more than
adding nav items:

- **Change password** belongs on `/security`, which already exists and already handles MFA. It is a
  field on a screen, not a screen.
- **Forgot password** is pre-login: it belongs on the login doors, and appears in no navigation at
  all.

`Campuses` moves out of Administration into the group containing what it contains. Nothing else moves
between groups, and **no href changes** — `navItemFor` gates on `href`, so renaming one would
silently open a route to everyone.

---

## 5. Screen anatomy, by level

Every screen is one of four shapes. Consistency here is what makes the product learnable.

| Level | Shape | Contains | Example |
|---|---|---|---|
| **L1 Collection** | Tiles → grouped list → row actions | Metric tiles (all links, Law 1), a campus-scoped list, one primary create action | `/classes`, `/students`, `/staff` |
| **L2 Record** | Identity header → tabs of its children | The thing, then its contained levels as tabs | `/classes/:id` → Sections · Subjects · Timetable |
| **L3 Row** | Inline edit within its parent | Never its own page | a section's subject + teacher |
| **L0 Config** | Form sections, no tiles | School-wide rules | `/settings`, `/setup` |

⚠️ **The create action is a button, never a permanently open form.** `/classes` currently devotes the
top of the page to "Add a class" whether or not anyone is adding one — the thing you came for is
below the thing you rarely want.

---

## 6. The two screens the audit named

### 6.1 Classes (L1)

```
Classes                                          [ + Add class ]
 ⟨ Main Campus ⟩  ← only when the owner has >1; never for a campus admin

 [17 Classes] [18 Sections] [17/720 Seats] [13 Subjects] [⚠ 24 no teacher]
      ↑ all five are links (Law 1)

 ┌──────────────────────────────────────────────┐
 │ Grade 9        2 sections · 13 subjects       │
 │ 34/80 seats               ⚠ 6 need a teacher  │ ← the gap sits where the fix is
 │                                     Manage →  │
 └──────────────────────────────────────────────┘
```

The school-wide gap *report* disappears from this screen. The gap *count per class* stays, because
that is the level at which somebody acts on it.

### 6.2 Subjects (L1)  ✅ *(built, IA4)*

Backed by `GET /subjects/catalogue`, **which has existed all along with no caller**.

| Subject | Taught in | Periods/week | Without a teacher |
|---|---|---|---|
| Chemistry | Grade 9, Grade 10 | 5 | ⚠ 3 sections |

This is the destination for the *"Without a teacher"* tile, and the cross-class home for
`periodsPerWeek` — a coordinator allocating a year's load thinks in subjects across classes, not one
class at a time.

---

## 7. Where `/staff` gives its Structure content back

The audit's clearest example of a screen doing two jobs. `/staff` keeps the **count and a link**
(useful when hiring); the 40-chip list moves to `/subjects?gap=1`. One list, one home, one
implementation — Laws 1 and 4 together.

---

## 8. What this structure deliberately does not change

- **No API rewrites.** Every consolidation targets an endpoint that already exists.
- **No permission changes.** Screens keep their roles; the API stays the authority.
- **No data model changes.** The hierarchy is already in the schema.
- **No new visual language.** `.metric-link` and the retheme tokens already exist.

---

## 9. How to tell it worked

The audit's failure was having no success criteria. These are countable, before and after:

| Measure | Today | Target |
|---|---|---|
| Metric tiles that are dead ends | **31** | 0 |
| Screens with their own campus selector | **12** | 0 (one in the shell) |
| Routes with no UI and no listed exception | **18** | 0 |
| Derived facts with >1 implementation | **1 real** (teacher gaps; the seats one was a false alarm — verified) | ✅ **0** (gaps unified in IA1) |
| Largest nav group | **9** | ≤5 |
