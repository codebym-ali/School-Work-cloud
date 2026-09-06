---
title: Role-Based Home — divide the dashboard by the hats a person wears
type: plan
status: Phase 1 SHIPPED 2026-09-06 · Phases 2–3 optional/deferred
updated: 2026-09-06
---

# Divide the dashboard's work by role

**Operator ask (2026-09-06):** *"divide the task on their dashboard based on their role."*

Follow-on from the role-visibility change ([[Key Decisions]], role chips): the shell now **says** Ayesha
is Teacher · Admission Controller · HR Manager, but her Home still only **serves** one of those jobs.

## The problem, stated precisely

`/home` (the staff/teacher shell landing) is a **single-role screen**: timetable "now" card, my unmarked
registers, check-in, cover, notifications. Every one of those is TEACHER work.

A multi-hat person is normal staffing in a small Pakistani private school — one person teaches, runs
admissions, and keeps the staff file. For her, today's Home is actively misleading:

- Her **admissions** work (a test scheduled today, an applicant ready to admit) is invisible until she
  remembers to click Admissions.
- Her **HR** work (a new joiner with no salary structure, an unstaffed subject) is invisible likewise.
- The screen says **"Nothing scheduled"** when she has no timetable — which reads as *"you have nothing
  to do today"* to someone who in fact has two other jobs and a test to run at 11:00.

That last line is the whole argument for this change: **a home screen that under-reports work is worse
than no home screen**, because it is trusted.

## The rule

> **One screen, one day, sectioned by the hats she wears — derived from her roles, never hardcoded.**

Three properties, in priority order:

1. **Nothing is invented.** Every number below already has a permitted endpoint (see the data table).
   No new API, no new DB field in Phase 1.
2. **Derived, like the nav.** Sections come from the roles she holds, the same discipline as
   `groupedNav` / `roleLabels` / `selfServiceNav`. Hardcoding "if teacher and admissions then…" is how
   this codebase has silently deleted capability three times (CSV import, `/my-attendance`,
   `/my-leaves` — each became unreachable because a second list drifted from the first).
3. **A single-role person sees exactly what they see today.** This must be a pure addition for the
   ~90% who wear one hat, or it is a regression dressed as a feature.

## Section order — urgency, not rank

⚠️ **Not `ROLE_INFO` priority.** That list orders roles by *privilege* (HR Manager outranks Teacher), and
privilege is the wrong axis for a to-do list: her registers are time-boxed and her HR queue is weekly.

The rule: **the shell's own role leads, then the rest by `ROLE_INFO` priority.** She is on the *teacher
app* (`usesTeacherShell`), so Teaching leads; then Admissions; then HR. This keeps one ordering rule
rather than a per-person judgement, and it cannot disagree with which app she is looking at.

## Layout

```
Good morning, Ayesha                      ← unchanged
[Teacher] [Admission Controller] [HR Manager]

⚠ NEEDS YOU TODAY                         ← NEW: one merged strip, all hats
   3 registers unmarked · 2 entry tests today · 1 ready to admit · 1 joiner needs setup

▸ TEACHING            (existing cards, unchanged: now/next, registers, cover, check-in)
▸ ADMISSIONS          open inquiries · tests today · ready to admit · admitted this month
▸ HR                  headcount · joiners this month · needs setup · coverage gaps
```

**Why one merged strip and not a strip per section:** the question at 07:50 is *"what must I do today?"*,
not *"what must I do today as a teacher?"*. She is one person with one morning. The sections below are
for working *through* a job; the strip is for not missing anything. This mirrors the owner dashboard's
"Needs attention" strip, which already works this way.

## Data — all of it already exists and is already permitted

| Section | Source | Roles the API allows | Already used by |
|---|---|---|---|
| Teaching | `api.staff.myUnmarkedRegisters()`, `api.timetable.mine()`, `api.cover.mine()`, `api.staff.checkInState()` | self-scoped (any staff) | `/home` today |
| Admissions | `api.admissions.summary()` → `/inquiries/summary` | OWNER · CAMPUS_ADMIN · **ADMISSION_CONTROLLER** | owner `/dashboard` |
| HR | `api.hr.summary()` → `/staff/summary` | OWNER · CAMPUS_ADMIN · **HR_MANAGER** | `/staff` |

`AdmissionsSummary` gives `totals.{open,testsScheduled,readyToAdmit,admitted}`, `testsToday`,
`admittedThisMonth`, `conversionRate`. `HrSummary` gives `headcount`, `joinersThisMonth`,
`needsSetup[]`, `coverageGaps[]` — both already carry exactly the actionable counts this screen wants.

**Verified 2026-09-06** against the controllers: Ayesha's two extra hats can both call their rollup, so
her sections will populate rather than 403.

## Non-negotiables

- **Each section fetches independently and fails silently.** Established precedent on this screen ("a
  home that goes blank because one of three rollups was denied is worse than one missing a card") and on
  the owner dashboard, where a denied fetch simply auto-hides the section. This also means the client
  never needs to predict permissions — **the API remains the enforcement point**; the role check here is
  display only.
- **Every chip and tile is `canReach()`-filtered.** The exact bug already fixed once on the owner
  dashboard (#2a): a Collections tile linked a campus admin to an owner-only screen and dead-ended on
  "Not authorized". A task you cannot open is worse than a task you were not shown.
- **No section for a hat with nothing to say.** An empty "HR" heading reads as a fault; render the
  section only when its rollup returned something.

## Phases

**Phase 1 — `/home` becomes role-sectioned.** ✅ **SHIPPED 2026-09-06** *(front-end only)*
> Built as planned, with one deliberate refinement: **the "Needs you today" strip carries the OTHER
> hats only, not teaching.** The teaching card above already names the exact register and links to
> it, and this file's own rule is that "two versions of one message on one screen is how a list of
> alerts stops being read" (the reason `REGISTER_UNMARKED` is filtered out of "Needs you"). So the
> strip surfaces the work that had NO representation on the page, and teaching keeps the better
> treatment it already had. A single-hat teacher therefore sees no strip at all — unchanged, as
> required. Rollups are fetched **only when she holds the role**, so a plain teacher does not incur
> two guaranteed 403s per load; the API remains the enforcement point.

1. `packages/roles`: `homeSections(roles)` → the ordered section keys she qualifies for (shell role
   first, then `ROLE_INFO` order). One exported rule, unit-testable, no component knows the ordering.
2. `packages/school-ui/src/app/home/page.tsx`: keep today's teacher cards as the **Teaching** section
   verbatim; add `AdmissionsSection` / `HrSection` components, each self-fetching + fail-silent.
3. The merged **Needs you today** strip: derive chips from whichever rollups resolved, `canReach`-filter,
   link through. Green "All clear" when genuinely empty (same as owner dashboard).
4. Effort **M**. Risk **Low** — additive, no backend, no schema.

**Phase 2 — the admin `/dashboard`** *(optional, smaller than it looks)*
Already sectioned by area (Academics & Enrollment / Finance / Communication) and already role-filtered,
so a multi-hat *admin* is mostly served. Revisit only if an admin reports the same complaint; do not
re-cut a working screen for symmetry.

**Phase 3 — plain `STAFF` have no home at all** *(open question, not scoped here)*
`/home` is `roles: ['TEACHER']`; a non-teaching staff member lands on `/my-attendance`. If Phase 1 lands
well, giving STAFF the same sectioned home is the natural follow-up — decide after Phase 1.

## Edge cases to design against

| Case | Expected |
|---|---|
| Single-role teacher | Byte-identical to today — no headings, no extra fetches |
| Teacher + Accountant | Teaching leads; Finance section (pending claims) below |
| Ops Admin | Sections from **held** roles only — never the six it satisfies by hierarchy |
| A rollup 403s / times out | That section is absent; the rest of the page is unaffected |
| Every section empty | "All clear" — never a wall of zeroes |
| Owner/Campus Admin | Untouched — they are on the admin shell and `/dashboard` |

## Testing

- **e2e (`teacher-shell` / new `home-roles` spec):** a seeded TEACHER+ADMISSION_CONTROLLER sees both
  headings; a plain TEACHER sees neither heading and no admissions fetch fires; a denied rollup hides
  only its own section.
- **Unit:** `homeSections()` ordering across the six role combinations in the edge-case table.
- **Regression:** the single-role teacher path is the one that must not move.

## Definition of done

Ayesha opens `/home` and sees, in one screen: her registers, her entry tests today, and her HR queue —
each linking to the screen that does it. A single-role teacher sees exactly what they saw before. No new
endpoint, no new permission, and no client-side gate that the API does not already enforce.
