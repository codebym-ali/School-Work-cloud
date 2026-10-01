---
title: Attendance Hub — students, teachers & staff, and what waits for the owner, behind one sidebar entry
type: plan
status: BUILT 2026-09-30 (uncommitted at time of writing) — supersedes the first "five flat options" draft; decisions D1–D3 taken as defaults
created: 2026-09-30
scope: packages/roles (nav) · packages/school-ui app/attendance (hub, page), staff-attendance, leaves, cover, dashboard, reports · test/e2e + packages/roles spec
---

# Attendance Hub

> Operator: *"I want to join these pages into a single tab — no many tabs."* and, separately: *"I'm a technical
> person and I'm confused which attendance is students and which is teachers — how will an owner understand?"*

## 1. What was wrong

- Sidebar **Attendance** meant *student* attendance, but nothing said so. **Staff Attendance** sat in another group
  (People) with the same icon as Leave requests. Leave requests and Cover sat in Teaching.
- The Attendance page said "Attendance / Present today / Registers not marked / Absent 3+ days" — no word
  "students", and "register" is jargon.
- The first draft of this plan proposed five flat options (Overview · Class registers · Staff · Leaves · Cover). Review
  found it: contradicted "no many tabs"; grouped by noun, not by the owner's questions; never showed students and
  staff together; left most roles with a one-item hub; used a meaningless combined badge.

## 2. The owner's three questions (what the design is built around)

1. **Who is in school today?** — students *and* teachers & staff, side by side, clearly separate.
2. **Who is behind?** — classes that haven't taken attendance; staff not yet marked.
3. **What needs my decision?** — leave requests, classes needing a substitute.

## 3. Structure (as built)

One sidebar entry, **Attendance**, for owner and campus admin (Operations Admin via the role hierarchy). Inside,
**three** choices, nothing nested: **Today · Students · Staff**, each carrying its own count (`Students (16)`).

| Choice | Content |
|---|---|
| **Today** (default) | Two panels — **STUDENTS** (present of expected, absent, late · on leave, classes that haven't taken attendance + overdue/due-by) and **TEACHERS & STAFF** (at work of total, absent, on leave, not marked) — plus **WAITING FOR YOU** (leave requests to review → *Review*, classes needing a substitute → *Arrange cover*). Closed day → "School is closed today" / "No staff attendance today". |
| **Students** | Overview (tiles, who's behind, heatmap). **Open a class's attendance** → the class view with its own empty state + "Needs attention today" shortcuts; heatmap cell → that class and day; **← All classes** returns. |
| **Staff** | The staff attendance sheet (date + filters kept) and **Arrange cover →**. |
| *Leaves* / *Cover* | Not tabs. Reached from *Waiting for you* (and from Staff for Cover) with a **← Back** link; the bar keeps Today / Staff highlighted. |

The URL carries the view: `/attendance` (Today), `?tab=students|staff|leaves|cover`. Old deep links still work:
`?view=register`, `?sectionId=…&date=…`, `?unmarked=1` open a class under Students.

## 4. Wording

| Was | Now |
|---|---|
| Present today | Students present today |
| Registers not marked | Classes that haven't taken attendance |
| Absent 3+ days | Students absent 3+ days (in a row, without leave) |
| Dashboard "Staff at work" | Teachers & staff at work (links to the Staff view) |
| Reports card "Attendance overview" | "Student attendance" → `/attendance?tab=students` |
| Staff Attendance icon = Leave requests icon | its own `attendance` icon |

## 5. Who sees what

| Role | Experience |
|---|---|
| OWNER_ADMIN / CAMPUS_ADMIN / OPERATIONS_ADMIN | The hub. Sidebar loses Leave requests, Cover and Staff Attendance. |
| HR_MANAGER | No hub — **Staff Attendance stays in their sidebar** and opens directly. |
| TEACHER | Unchanged: the marking screen. |

`NavItem.hiddenFor?: Role[]` hides an entry from the sidebar **for those roles only** (effective roles, so an Ops Admin
counts as a campus admin). It never changes who may open a route (`canReach`/`navItemFor` unchanged).

## 6. Old URLs keep working

`/staff-attendance`, `/leaves`, `/cover` (owner / campus admin) forward to `/attendance?tab=…`, keeping `date` and
`status`. The HR manager's `/staff-attendance` is not redirected. `/staff-attendance/[staffId]` is untouched. The
three screens take an `embedded` prop (heading hidden) — the same pattern the Fees page already used.

## 7. Gotchas found while building (keep)

- **Read the URL after mount, not during render.** On an in-app redirect the page renders before the address bar
  updates, so a render-time read opened Today instead of the requested tab.
- **Seed state from the URL at creation, not in an effect** (staff sheet): an effect that reads the URL races the one
  that writes it back, and dev-mode double effects made the second read see today's date.
- **Merge query params, never replace** (`replaceState('?date=…')` erased `?tab=staff`).
- **Don't clear a deep-linked section before the sections list has loaded** — the campus filter is restored from
  storage a moment after mount and the old check wiped the section.
- **No remembered-class inside the hub**: "Open a class's attendance" must start at the picker; the session memory is
  only for the standalone register.

## 8. Verification

- Live (owner): one sidebar entry; Today panels + waiting strip; tabs with counts; Students overview → class → back;
  Staff with date/status preserved (old link `/staff-attendance?date=2026-09-28&status=UNMARKED` lands on Staff,
  28 Sep, "Not marked" = 12); `/leaves` and `/cover` forward; `?view=register&sectionId=…&date=…` opens Grade 2 — B on
  24 Sep ("Register complete", 20 students). No horizontal overflow at 375 px on Today / Students / Staff.
- `packages/roles/src/attendance-hub-nav.spec.ts` — who sees which sidebar entries, routes stay role-gated, icon differs.
- Gates: typecheck, lint, 254 unit tests, axe gate for `/attendance`, Playwright `attendance.spec` (owner read-only
  flow, updated) and the staff "dashboard leads with what is not known" spec.
- **Pre-existing failures, not caused by this work:** `staff-attendance.spec` "every count on the register…"
  (looks for `.grid button.metric-link` — the staff page moved to `KpiStrip` on 2026-09-29, the spec was last edited
  2026-09-27) and the owner half of the teacher check-in test (`⚠️ Not marked` button text); `closure-banner.spec`
  fails at `goto('/my-attendance')` (route is STAFF/TEACHER only). They should be repaired separately.

## 9. Not done / open

- "Remind teacher" on an overdue class (needs a decision on the notification path).
- Campus admin not exercised live (owner session only); logic covered by the unit spec and the existing route gates.
- Decisions D1–D3 were not answered and took the defaults: three choices (Today · Students · Staff); Leave requests
  reachable from *Waiting for you* and removed from the sidebar; hub named "Attendance".
