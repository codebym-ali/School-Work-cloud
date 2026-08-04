---
title: Classes Screen Refactor Plan
type: plan
status: SHIPPED 2026-08-02/03 — P0–P4 all built; §9 decisions all DECIDED
created: 2026-08-02
scope: apps/web/app/(app)/classes/** + apps/web/app/(app)/setup/page.tsx + apps/api hr.listAssignments
---

# Classes screen — refactor & UX redesign plan

> Operator: *"this section is soo messy … select the class, opens in a new page, then select the
> section and change the subjects of that section. Keep the section and their subjects separate.
> On the classes list show the subjects and the teachers assigned, as tags."*

Source files read for this plan: `classes/page.tsx` (136), `classes/class-manager.tsx` (**710**),
`classes/[id]/page.tsx` (201), `setup/page.tsx` (372), `lib/api.ts`, `setup.controller.ts`,
`setup.service.ts`, `hr.controller.ts`, `staff.service.ts`, `test/matrix/permission-matrix.ts`.

---

## 1. Diagnosis — why it reads as messy

Not a styling problem. Three root causes, in order of consequence.

**R1 — The page is organised around the data model, not the job.** `Class`, `Subject`, `Section`
are three sibling lists rendered at the same visual weight inside one card, because that is how
the three tables relate. The operator's questions — *"who teaches 9-A Maths?"*, *"which section
takes Biology?"*, *"fix this typo"* — cut **across** those lists and none of them has a home.

**R2 — Editing happens in place, on a list.** Every mutation is an inline panel inside the row
(`panel`, `renaming`, `editingSection`, `menuOpen`, `pendingDelete`, `nameWarnings` — 11 `useState`
in `ClassRow` alone). So the list is simultaneously a report and six forms. Opening one pushes
every class below it down the page, and nothing is addressable by URL.

**R3 — One component serves two pages.** `ClassManager` is rendered by both `/setup` step 3 and
`/classes`, differentiated by a `showTools` flag, with ~40 lines of handler wiring copy-pasted
between the two hosts. Every behaviour therefore has two truths and two places to regress.

---

## 2. Defects found (functional — not cosmetic)

| # | Finding | Evidence | Sev |
|---|---|---|---|
| **CL-F1** | **A section's subject list can never be changed after it is created.** The only way to fix an elective list is to delete the section — which the server refuses once students are enrolled. | `PUT /sections/:id/subjects` implemented (`setup.service.ts:228`), client method exists (`api.ts:410`), **zero callers in `apps/web`** | **High** |
| **CL-F2** | **A subject can never be renamed.** `Mathmetics` is visible in 9th on the operator's screen and is permanent: rename has no UI, and delete is blocked once exam results / assignments / timetable slots reference it. | `PATCH /subjects/:id` + `api.subjects.rename` (`api.ts:420`), **zero callers**; `ClassManager` passes only `onDeleteSubject` | **High** |
| **CL-F3** | **Teacher assignment ignores the academic year.** `assignmentFor()` matches on `(sectionId, subjectId)` only and `assign()` deletes that match before creating the new one — so with two years of data the UI shows last year's teacher as current and **destroys the historical row** on reassignment. | `classes/[id]/page.tsx:58-59, 68-81`; `api.teacherAssignments.list()` takes no year | **High** (latent: demo has 1 year) |
| **CL-F4** | Assignments are campus-scoped by the **teacher's** campus, not the **section's** — a campus admin can be shown a class with assignments missing. | `staff.service.ts:272` `{ staff: { user: { campusId: restricted } } }` | Med |
| **CL-F5** | `/classes/[id]` sends the user back to `/setup` in four places ("← Setup", "add sections in Setup", "add subjects in Setup") — but Setup collapses step 3 to a *link to /classes* once setup is complete. A closed loop with no way to do the thing. | `classes/[id]/page.tsx:88,108,126,159` vs `setup/page.tsx:131-138` | Med |
| **CL-F6** | The list cannot answer "which subjects have no teacher?" — the question `GET /staff/summary` already answers for HR, unavailable here. | `staff.service.ts:180 coverageGaps` | Med |
| **CL-F7** | `PUT /sections/:id/subjects` has **no behavioural e2e** — only an authz row in the matrix. The capability about to become central is untested. | `permission-matrix.ts:55`; no case in `campus-scope.e2e` | Med |

## 3. Structural findings

- **CL-S1** `class-manager.tsx` — 710 LOC, one file, six responsibilities (add-class form, class list, subject editor, section editor, section-subject picker, delete host).
- **CL-S2** No URL state: which class is open, which panel, which section — all component-local. No deep link, no back button, no refresh survival.
- **CL-S3** Sections and subjects share one visual language (`.chips` + `.badge`) despite different nouns, lifecycles and blast radius. A section "badge" is a compound control — navigate + Edit + Delete — dressed as a tag.
- **CL-S4** Every mutation calls `reload()` → 5 parallel refetches. Invisible at 3 classes, not at 30 × 4.
- **CL-S5** `setup/page.tsx:147-184` and `classes/page.tsx:90-131` are the same handler set, twice.

## 4. UX findings

- **CL-U1** No hierarchy between one-off setup and recurring work — `Add class` (once per year) sits above the fold; assigning a teacher (every term) is two clicks and a page away.
- **CL-U2** The card shows structure but not the state of the world: no teachers, no class teacher, no unassigned count.
- **CL-U3** `Section B · own subjects (6 of 7)` names the exception but hides the six behind a `title` tooltip — invisible on touch, unusable on mobile.
- **CL-U4** The subject chip's only affordance is a destructive `✕`; the safe action (rename) is missing entirely.
- **CL-U5** `Edit` + `Delete` per section chip: 2 sections = 4 buttons on one line, 6 sections = 12, and the row wraps into the unreadable band visible in the operator's screenshot.
- **CL-U6** Two "add subject" entry points with different behaviour (class menu = comma list + near-name warning; section form = single inline add), neither reachable from the subject row itself.
- **CL-U7** Class actions split between two visible buttons and a `⋯` menu whose contents change per host (`showTools`).
- **CL-U8** `Teachers` is labelled as a teacher screen but opens the whole class workbench.

---

## 5. Target design

### 5.1 Information architecture

| Route | Job | Character |
|---|---|---|
| `/classes` | **The register.** What exists, what is incomplete, who teaches what. | Read-mostly. One primary action (Add class) + one per row (Manage). |
| `/classes/[id]` | **The class workbench.** Everything about one class. | All editing lives here. |
| `/classes/[id]` `?section=<id>` | **The section pane.** Seats, *its* subjects, *its* teachers. | Master–detail, URL-addressable. |
| `/setup` step 3 | Summary + "Go to Classes →". Never renders `ClassManager`. | Link only. |

**Rule:** the list never mutates anything except creating a class and reordering. Every other
write happens on the workbench. That single rule removes 9 of `ClassRow`'s 11 state hooks.

### 5.2 `/classes` — the class card

```
┌───────────────────────────────────────────────────────────────────────┐
│ 8th   ·  Main Campus            [Ready to admit]  7 students          │
│                                              [ Manage ▸ ]  [ ⋯ ]      │
│  Sections   A · 6 of 40 · Ms. Ayesha Khan      B · 1 of 40 · no CT    │
│  Teaching   [Biology · A. Khan] [Computer · —] [English · S. Bibi] …  │
│             ⚠ 2 subjects have no teacher                              │
└───────────────────────────────────────────────────────────────────────┘
```

- **Teaching tags** (the operator's ask): one tag per subject in the class catalogue, reading
  `Subject · Teacher` in `badge ok`, or `Subject · Unassigned` in `badge warn`. Clicking a tag
  opens the workbench focused on that subject's row.
- **Section chips** become read-only: name · seats · class teacher. Click → workbench `?section=`.
- `⋯` keeps only: Edit name & age · Move earlier · Move later · View students · Delete class.
- Multi-section classes show one tag row per class (union across sections), with a per-section
  breakdown on the workbench — an elective split is an exception, and only the exception is named.

### 5.3 `/classes/[id]` — the workbench

Header: `8th` · Main Campus · 2026-27 · 7 students · 2 sections · 7 subjects · [View students] [⋯].
Coverage strip: `12 of 14 section-subjects have a teacher · 2 gaps →`.

**Panel A — Subjects (the class catalogue).** *"The subjects 8th offers. Each section picks from
this list."*

| Subject | Studied by | Teachers | |
|---|---|---|---|
| Biology | Both sections | A. Khan | Rename · Remove |
| Computer | Section A only | — | Rename · Remove |

Add row: comma-separated list + `datalist` catalogue + the existing near-name warning
(`nearestSubject`). Rename inline (Enter saves / Esc cancels). Remove → `ConfirmDialog`, server
names the blocker. → closes **CL-F2, CL-U4, CL-U6**.

**Panel B — Sections.** A table, not chips: name · seats · enrolled · subject count · class
teacher · [Open]. `Open` sets `?section=<id>` and reveals:

**Section pane** (`Section A · 8th`)
1. **Name & seats** — inline, seats cannot drop below enrolled (existing guard, kept).
2. **Subjects this section studies** — radio `Same as the class (7)` / `Choose for this section`,
   toggle chips over the catalogue, plus "not listed? add it" which creates on the *class* and
   ticks it here. Save → `PUT /sections/:id/subjects`; empty selection ⇒ inherits the class.
   → **closes CL-F1, CL-U3.**
3. **Class teacher** — one picker (`subjectId: null` homeroom assignment).
4. **Teacher per subject** — the existing grid, moved here, now year-scoped.
5. **Danger zone** — Delete section, guarded.

This is the literal shape the operator asked for: the class catalogue and the section's own list
are **two separate panels**, and the section's subjects are changed *inside the section*.

### 5.4 Component decomposition

```
apps/web/app/(app)/classes/
  page.tsx                    list: data + handlers only
  class-card.tsx              presentational card + teaching tags        [new]
  add-class-form.tsx          extracted verbatim from class-manager      [new]
  [id]/page.tsx               workbench shell: header, coverage, tabs, ?section=
  [id]/subject-catalogue.tsx  add / rename / remove class subjects       [new]
  [id]/section-list.tsx       sections table                             [new]
  [id]/section-pane.tsx       seats, subject selection, teachers         [new]
  confirm-dialog.tsx          unchanged
apps/web/lib/
  use-class-structure.ts      one fetch+mutate hook for both pages       [new]
apps/web/app/(app)/classes/class-manager.tsx                             [DELETED]
```

`useClassStructure()` owns `{campuses, classes, sections, subjects, catalogue, assignments, staff}`,
one `reload()`, one `run(fn, okMessage)` → kills **CL-S4, CL-S5**.

⚠️ **Do not gate the add-class form on a flag.** Setup renders class management only when the
school has *no* classes yet — the exact moment adding the first one is the entire point. Under
this plan Setup stops rendering it at all, so `/classes` must carry a first-run empty state.
(This is the near-miss already recorded on 2026-07-30; it must not be reintroduced.)

---

## 6. Backend work — deliberately minimal

No migration. No new table. No new route.

- **B1** `staff.service.listAssignments(sectionId?, staffId?)` → accept `academicYearId?`, default
  to the **current year**, and `include` the teacher's `{ id, fullName, user: { email } }`.
  Fixes **CL-F3** at the source (the UI can no longer see or clobber another year's row) and lets
  the list render teacher tags without pulling the whole `/staff` payload.
- **B2** Scope assignments by the **section's** campus (`section: { class: { campusId } }`) instead
  of the teacher's user campus. Fixes **CL-F4**.
- **B3** `api.ts`: `teacherAssignments.list({ sectionId?, staffId?, academicYearId? })`, and a
  `TeacherAssignment.staff?: { id, fullName, email }` field.

Everything else the redesign needs already ships: `PATCH/DELETE` on classes, sections and subjects;
`PUT /sections/:id/subjects`; `GET /subjects/catalogue`; `enrolled` per section; guarded deletes
that name their blocker.

---

## 7. Phases

| # | Deliverable | Gates |
|---|---|---|
| **P0** | **Backend**: B1 + B2 + tests. Ships alone, no UI change. | api tsc · lint · new + existing e2e · matrix |
| **P1** | **Decompose, no behaviour change**: extract `add-class-form`, `class-card`, the `useClassStructure` hook; delete `class-manager.tsx`; Setup step 3 → summary + CTA; `/classes` gains a first-run empty state; fix the four stale `/setup` links (**CL-F5**). | web tsc · lint · browser: fresh tenant with 0 classes can still start |
| **P2** | **The workbench**: subject catalogue panel (add/rename/remove), sections table, section pane with **subject editing** (CL-F1) + year-aware teacher assignment moved in. | web tsc · lint · new e2e for section subjects |
| **P3** | **The list**: teaching tags, coverage line, read-only section chips, actions collapsed to `Manage` + `⋯`. | web tsc · lint · browser pass |
| **P4** | **QA + brain**: Playwright helper rewrite, `classes.spec.ts`, full suite, Progress Tracker + Key Decisions. | `pnpm test` · `pnpm test:e2e` · both lints · api+worker build |

Each phase is independently committable and independently revertable.

---

## 8. Test plan

**Integration (jest) — new `section-subjects.e2e-spec.ts`** (closes **CL-F7**)
1. `PUT /sections/:id/subjects` replaces the set (not appends) — `listSections` reflects it.
2. `[]` ⇒ the section inherits the class catalogue (zero link rows, not zero subjects).
3. A subject from another class ⇒ **422**, and the existing links are untouched.
4. A campus-bound admin on another campus's section ⇒ **403**.
5. Changing the set does **not** disturb `TeacherAssignment` rows for subjects that survive.

**Integration — `teacher-assignments`**
6. `list()` returns only the current year by default; an explicit `academicYearId` selects another.
7. **Regression for CL-F3:** assigning a teacher for year B leaves year A's row intact.
8. **Regression for CL-F4:** a campus admin sees an assignment on their own section even when the
   teacher's user record carries a different campus.

**Playwright** — `test/e2e/helpers.ts` is *already* stale (drives a Setup UI that no longer exists;
`pnpm test:e2e` cannot pass today). Rewrite it to seed structure **via the API** rather than the UI
— faster, and it stops the suite breaking on every screen change. Then `classes.spec.ts`:
add class → 2 subjects → 1 section → change that section's subjects → assign a teacher →
assert the teaching tag appears on `/classes`.

**Manual browser pass** (demo tenant, restored afterwards, per established practice)
| | Check |
|---|---|
| 1 | Fresh tenant, 0 classes: `/classes` empty state adds the first class |
| 2 | Setup step 3 links to `/classes` and nothing on `/classes/[id]` sends you back to Setup |
| 3 | Rename `Mathmetics` → `Mathematics`; the exams/attendance screens follow |
| 4 | 8th-B: change subjects from 6 → 5; list shows the exception, section pane shows *which* |
| 5 | Section subject removal does not orphan that section's other teachers |
| 6 | Assign a teacher; tag flips amber → green on `/classes` |
| 7 | Delete guards still name the blocker (class w/ sections, section w/ students, subject w/ results) |
| 8 | Seats cannot be set below enrolled |
| 9 | Campus-bound admin sees only their campus, and cannot open another campus's class by URL |
| 10 | Back button restores the selected section (`?section=`) |
| 11 | ≤720px: card readable, section pane usable, no horizontal body scroll |
| 12 | Keyboard: tags, menu and pane reachable; `aria-expanded` on the menu |

---

## 9. Decisions — ✅ ALL DECIDED (operator, 2026-08-02)

- **D1 — Section route shape: master–detail `/classes/[id]?section=<id>`.** A school with two
  sections must not navigate three levels deep, and switching sections should not refetch. The URL
  still carries the selection, so it is shareable and back-button-safe.
- **D2 — Setup keeps no class editing: summary + "Go to Classes →" only.** This is what makes one
  component with one host possible. `/classes` must therefore carry the first-run empty state.
- **D3 — Playwright helpers are rewritten in this work**, seeding structure via the API rather than
  the UI. `pnpm test:e2e` has been unusable since 2026-07-30; UI-driven seeding is why it breaks on
  every screen change.

## 10. Out of scope

Rooms/venues (no `Room` entity — D1 of the Setup plan chose "Section = the classroom group"),
timetabling, per-section capacity policy, bulk import of class structure, and the deeper
"class row as one expandable thing with a status" restructure deferred on 2026-07-30.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Removing `ClassManager` from Setup strands a brand-new school | `/classes` first-run empty state; verified on a throwaway tenant with 0 classes (**not** demo) |
| `useSearchParams` needs a Suspense boundary in App Router | Follow the existing precedent: read `window.location.search` in an effect (as `/attendance` and `TeacherExams` already do) |
| Deleting a 710-line shared component regresses `/setup` | P1 is behaviour-preserving and gated separately from P2 |
| Demo-data damage during the browser pass | Create → verify → restore, as in every prior live pass |
