---
title: Owner UX Remediation Plan
type: delivery
updated: 2026-09-29
author: Senior UI/UX Designer
status: proposed
---

# Owner UX Remediation Plan (2026-09-29)

Resolves the 8 prioritised owner-experience issues from the design review of Staff Attendance, Student
Attendance, Reports and Students (owner-web). The core diagnosis: **the owner is handed the office's clerical
tools instead of an oversight experience**, on top of a design system that isn't finished. The plan fixes
the two risks first, then builds one reusable **Owner Oversight pattern**, then polishes the system under it.

## Design principles (the bar every screen is judged against)
1. **Oversee, don't operate.** Owner screens answer "how is my school doing and where must I act?" first;
   records come second, and editing is for the role that owns the record.
2. **Summary → slice → record.** Every owner area opens on KPIs, lets you narrow by Campus → Class →
   Section, and drills down to the individual student or staff member.
3. **Every number is a door.** A KPI you can read you can also click, and it filters the list below.
4. **Calm by default.** One primary action per view, quiet secondary actions, warnings only when they matter.
5. **Speak the school's language.** DD/MM/YYYY dates, "Grade 6 — A", "Ahmed s/o Tariq", PKR with lakh
   grouping (Rs 1,85,000), and the academic session (Apr–Mar) as "this year".
6. **Accessible by construction.** WCAG AA contrast on every state, never colour alone, full keyboard use.

---

## Phase 0 — Remove the two risks (P0) · ~1 day

### 0.1 Owner cannot edit student attendance *(Issue 1)*
- **Policy:** marking belongs to the **class teacher**. **Ops Admin / Campus Admin** hold a **correction**
  role (reason required, audited). The **Owner is read-only**.
- **Backend:** remove `OWNER_ADMIN` from the write routes (`POST /attendance/bulk`, `PATCH /attendance/:id`)
  and add a mandatory `reason` to the admin correction path. Update the permission matrix rows so
  `matrix-conformance` enforces the new policy.
- **Frontend:** the owner's Attendance page renders **read-only** (no P/A/L/½ buttons, no Save). A
  "Request a correction" link routes to the ops/campus admin.
- **Acceptance:** owner POST to `/attendance/bulk` → 403; the owner UI has no write controls; an ops-admin
  correction without a reason → 422; every correction appears in the Activity log.

### 0.2 Fix the unreadable hover/selected state *(Issue 2)*
- **Root cause:** the shared selected/hover style fills the surface navy but leaves the text in its resting
  colour. The same token drives stat cards and day chips.
- **Fix at the token level, not per page:**
  - *Selected:* dark fill + **on-dark text** (`--text-on-accent`, white), accent-coloured number kept ≥ 4.5:1.
  - *Hover (not selected):* keep the **light surface**, add a 1px accent border + subtle elevation — hover
    should never invert the card.
  - *Focus:* visible 2px focus ring distinct from hover.
- **Sweep:** stat cards (staff attendance, dashboard), day chips (attendance "last 7 days"), filter chips.
- **Acceptance:** every interactive card/chip passes AA contrast in rest, hover, selected and focus, checked
  with the existing axe gate (`a11y.spec`) plus a manual state check.

---

## Phase 1 — The Owner Oversight pattern (P1) · ~5–6 days
One layout, built once as shared components, then applied to Students, Attendance and Reports. This is the
single biggest change and it resolves Issues 3, 4, 5 and 6 together.

### 1.1 The shared pattern
```
┌ Page header: title · scope chip ("All campuses" / "Main Campus") · date range · Export ┐
├ KPI strip: 4–8 clickable tiles (value · label · delta vs last period)                    ┤
├ Scope bar: Campus ▸ Class ▸ Section  (cascading, with live counts)  · search            ┤
├ Insight panel (optional): chart or "needs attention" list                               ┤
└ Data table: dense, sortable, row click → detail drawer; actions in a ⋯ menu            ┘
```
**Components to build (packages/school-ui):** `KpiStrip` / `KpiTile`, `ScopeBar` (cascading campus/class/
section with counts, URL-synced so views are shareable), `DataTable` (sort, pagination "1–25 of 312",
column visibility, row selection), `RowActions` (⋯ menu), `DetailDrawer`, `StatusPill`, `EmptyState`.

### 1.2 Students hub *(Issues 3, 4, 5, 8, 12)*
- **KPI strip:** Total active · Present today · Absent today · On leave · New this month · Withdrawn ·
  Fee defaulters · Missing guardian. Each tile filters the table.
- **Scope bar:** Campus → Class → Section, each option showing a count and today's attendance
  ("Grade 6 — A · 32 · 94%").
- **Table columns:** Photo/initials · **Name + father's name** ("Ahmed Butt · s/o Tariq Butt") ·
  **Class-Section** · GR · **Attendance % (term)** · **Last result / average** · **Fee status** pill · ⋯.
  REG No moves to the detail view; gender becomes an optional column.
- **Detail drawer (row click):** profile, guardians, attendance calendar, results trend, fee ledger —
  without leaving the list.
- **Bulk actions (on selection):** Send SMS · Export · Move section. **Delete leaves the row**: it lives
  inside the profile behind a typed confirmation; "Withdraw" is the everyday action.
- **Search as you type;** "Missing guardian · 3" becomes a KPI tile, not a lone chip.

### 1.3 Student performance view *(Issue 5)*
- **Class-level:** a tab on the Students hub, **Performance**, scoped by the same Campus → Class → Section:
  class average, subject averages, distribution (A+…F), top 5 and **students at risk** (below pass, falling
  trend, or <75% attendance — the combination Pakistani schools act on).
- **Student-level:** results trend across exams in the detail drawer.
- Reuses the existing performance endpoints (`/reports/performance/*`) — this is a presentation layer.

### 1.4 Attendance overview (owner, read-only) *(Issues 3, 1)*
- **KPI strip:** Present % today · Absent · On leave · Late · **Registers not marked** (with the responsible
  teacher named) · Chronic absentees (3+ days).
- **Heatmap:** sections × last 14 days, coloured by attendance %, click a cell → read-only register.
- **Needs attention list:** unmarked registers (teacher + time), students absent 3+ consecutive days,
  sections below a threshold.
- **Staff Attendance** gets the same header + KPI strip; marking stays for campus/ops admin, with one-tap
  segmented status buttons (matching the student register) and **"Mark all present"** instead of 13
  dropdowns.

### 1.5 Reports centre *(Issues 6, 7)*
- **Gallery, grouped by category:** Enrollment · Attendance · Fees · Exams · Staff · Communication.
  Each card: name, one-line question it answers ("Who owes fees and how much?"), a live preview figure,
  last run.
- **Report view:** its own filters shown up front with defaults (scope bar + date range), results inline
  (chart where the data is visual, table below), **Export (CSV / PDF) grouped top-right of the results**.
- **Later (P3):** saved views and scheduled email ("Fee collection · 1st of every month").

---

## Phase 2 — Design-system polish (P2) · ~3 days *(Issues 7, 8)*
- **Typography:** one type scale; page titles, section headers, labels. **Sentence case everywhere**
  ("Half day", not "HALF DAY"; "Male", not "MALE").
- **Status colour language, used identically everywhere:** Present/Paid = green · Absent/Overdue = red ·
  Late/Partial = amber · On leave = blue · Not marked/Pending = neutral grey. Always paired with an icon or
  label (never colour alone).
- **Actions:** one primary button per view; secondary as outline; row actions in a ⋯ menu; destructive
  actions red *only* inside a confirmation.
- **Banners:** the MFA notice becomes a slim, dismissible top strip (dismissed for 7 days) plus a badge on
  Security; contextual warnings (past-date marking) become inline hints next to the control.
- **Header identity:** show the person's name and role ("Muhammad Ali · Owner"), not the email; remove the
  duplicated "Owner" pill in the sidebar.
- **Sidebar:** exactly one active item; all groups collapsible consistently.
- **Dates:** DD/MM/YYYY with weekday ("Mon, 29/09/2026") via a shared date picker; currency via one
  formatter (Rs with lakh grouping).
- **Density:** compact table rows and right-sized controls (no 175px status buttons).
- **Housekeeping:** confirm the Next.js dev badge never ships in production builds.

---

## Delivery plan
| Phase | Scope | Issues | Effort | Gate |
|------|-------|--------|--------|------|
| 0 | Attendance write-lock for owner · state/contrast token fix | 1, 2 | ~1 day | permission-matrix + a11y |
| 1a | Shared components (KpiStrip, ScopeBar, DataTable, RowActions, DetailDrawer) | — | ~2 days | Storybook/visual check |
| 1b | Students hub + Performance tab | 3, 4, 5, 8 | ~2 days | e2e: filter/drill/drawer |
| 1c | Attendance overview (owner) + Staff attendance rework | 3, 1 | ~1.5 days | e2e + read-only check |
| 1d | Reports centre | 6, 7 | ~1.5 days | e2e: every report runs + exports |
| 2 | Design-system polish across owner pages | 7, 8 | ~3 days | a11y + visual review |

**Total ≈ 11–12 days.** Phase 0 is independent and should ship immediately.

## Validation
- **Usability check with a real owner/principal** on three tasks: *"How many students are absent today at
  the Main Campus, and who?"*, *"Which Grade 6 section is doing worst in Mathematics?"*, *"Download the
  list of fee defaulters for this month."* Target: each done in under 60 seconds without help.
- **Accessibility:** axe gate green; manual keyboard pass; AA contrast on all interactive states.
- **Regression:** permission matrix (owner write → 403), e2e for each hub's KPI → filter → drill → drawer.
- **Live re-review** of the four original screens against the principles above before sign-off.

## Out of scope (logged for later)
Scheduled report emails, saved custom views, mobile-first owner app, Urdu localisation (explicitly deferred
by the product owner).
