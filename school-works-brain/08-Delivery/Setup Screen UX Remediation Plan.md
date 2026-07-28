---
title: Setup Screen UX Remediation Plan
type: plan
status: proposed — awaiting product decisions (§1)
created: 2026-07-27
scope: apps/web/app/(app)/setup/page.tsx (630 LOC) + supporting API/schema
---

# Setup Screen — UX Remediation Plan

> Source audit: 39 findings (SU-01 … SU-39) raised against `/setup`, plus 2 found while
> verifying the schema for this plan (SU-40, SU-41). Clarity score at audit: **5/10**.

## 0. Objectives & success criteria

| # | Objective | Measurable outcome |
|---|---|---|
| O1 | **The screen never lies** | A green ✓ means *every* class is admission-ready (≥1 section AND ≥1 subject). No state where setup says "complete" but admission fails. |
| O2 | **Kill subject drift** | Zero near-duplicate subject names per school (`Mathmetics`/`Math`). New subject entry surfaces existing names before creating. |
| O3 | **Destructive actions are survivable** | No native `confirm`/`prompt`; all delete targets ≥24px; archive offered before delete; blast radius stated. |
| O4 | **Separate first-run from daily work** | Ongoing class/section management reachable in ≤1 click without scrolling past completed wizard steps. |
| O5 | **Vocabulary is defined on screen** | Class / Section / Subject / capacity explained in-context; no meaning carried by the *absence* of a label. |
| O6 | **Keyboard + tablet usable** | All controls reachable by keyboard with `aria-expanded`; no layout break ≥768px. |

**Definition of done for the whole plan:** the 41 issues are closed or explicitly deferred with a
reason; web tsc + lint + Playwright green; a fresh-school walkthrough and an existing-school
walkthrough both pass manual QA (§5.3).

---

## 1. Decisions needed from you (BLOCKING — Phase 0)

These three cannot be resolved from the code; they change scope materially.

### D1 — Is there a "classroom"? ✅ **DECIDED: Option A — implemented 2026-07-27**
> **Section = the classroom group.** `Section.capacity` + a live enrolled count are now surfaced and
> editable in Setup; no schema change. Closes **SU-40**, and **SU-01** under Option A.
> - `setup.service.listSections` returns `enrolled` per section (ACTIVE enrollments in the **current
>   academic year** — the exact rule `assertSectionCapacity` enforces, so the UI can never disagree
>   with the admission block).
> - Section chip shows `18/40`, turning red + "full" at capacity.
> - Inline editor (name + seats) replaces the native `prompt()` rename; seats cannot be set below the
>   number already enrolled. Seats can also be set when creating sections ("Seats each").
> - Step-3 blurb now defines the term: *"A section is one classroom group with a fixed number of seats."*
> - Gates: web tsc ✅ · web lint ✅ · api build ✅.

### D1 — original options (for the record)
The schema has **no room/venue entity**. `Section` carries `capacity Int @default(40)` but no room.
- **Option A (recommended, no migration):** declare "Section = the classroom group". Surface
  `capacity` + live enrolled count so a section *reads* as a room with seats. Zero schema change.
- **Option B:** introduce `Room` (building/floor/number/seats) + `Section.roomId`. New model, RLS
  policy, migration, timetable implications. Only worth it if you plan room-based timetabling.

### D2 — Subject catalogue ✅ **DECIDED: Option A — implemented 2026-07-27**
> **Keep the per-class model; stop drift at the point of entry.** No migration. Closes **SU-04** and
> **SU-33** for *new* entries (existing drift still needs the gated §3.3 merge).
> - `GET /subjects/catalogue` → distinct subject names school-wide + `classCount` (one `groupBy`,
>   campus-scoped for a restricted admin).
> - Server **normalizes on write** (`trim` + collapse inner whitespace) in `createSubject`/`updateSubject`,
>   so `"  Math  "` and `"Math"` can no longer coexist.
> - Subject inputs are **autocompletes** over the catalogue (both entry points: "+ Subject" and the
>   "Subject not listed?" field inside section creation).
> - **Near-match guard** (`apps/web/lib/subject-match.ts`): on submit, a typo/abbreviation offers
>   *Use "Math"* or *Add anyway* — non-blocking, never refuses a genuinely new subject.
> - **Matching rule (verified, not assumed):** plain edit-distance ≤2 **fails** the real case —
>   `Math`→`Mathmetics` is distance **6**. So the rule is *exact ⇒ silent; single-word prefix ⇒ warn;
>   edit-distance ≤2 (≤1 for short names) ⇒ warn*. The prefix half is restricted to **single-word**
>   names because it otherwise fired on legitimate compounds (`English Literature`→`English`,
>   `Computer Science`→`Computer`, `Urdu Adab`→`Urdu`). Verified both ways in a scratch harness:
>   `Mathmetics|Mathematics|Maths→Math`, `Islamiat→Islamiyat`, `Bilogy→Biology`; and
>   `English Literature|Computer Science|Physical Education|Islamic Studies→null`.
> - Gates: web tsc ✅ · web lint ✅ · api build ✅ · api lint ✅.
> - **Not covered:** server-side near-match rejection (UI-level only — drift originates in the UI),
>   and CSV import still creates subjects unchecked.

### D2 — original options (for the record)
`Subject` is **per-class** (`@@unique([classId, name])`), so "Math" in 8th and "Math" in 9th are two rows.
- **Option A (recommended for now):** keep the model; add a **school-wide name index** + autocomplete
  + near-match warning at entry. Stops new drift immediately, no migration.
- **Option B (later, bigger):** promote to a school-level `Subject` catalogue + `ClassSubject` join.
  Correct long-term, but migrating existing `ExamResult.subjectId` and `SectionSubject` is risky and
  should not be bundled with a UI fix.
- Either way, **existing drift needs a one-off merge** (§3.3, treated as a data migration, not UI).

### D3 — Where daily class management lives ✅ **DECIDED: Option A — implemented 2026-07-27**
> **`/setup` is now first-run only; `/classes` is the permanent manager.** Closes **SU-09, SU-20,
> SU-21, SU-25, SU-26, SU-27, SU-30, SU-39**.
> - **Extracted** `ClassesStep`/`ClassRow` out of `setup/page.tsx` (739 → 265 lines) into a shared
>   `app/(app)/classes/class-manager.tsx`, exported as **`ClassManager`** with a `showTools` flag.
>   Extraction was done by splitting the file mechanically, not retyping, to avoid transcription drift.
> - **New `/classes` page** (nav: Academics, OWNER_ADMIN + CAMPUS_ADMIN): search across class/section/
>   subject names, summary metrics (classes · sections · **seats filled** · **distinct** subjects — the
>   honest count from D2's catalogue), and the full manager.
> - **Class reordering** (SU-09, previously impossible): ↑/↓ per class. Implemented as a **full group
>   re-sequence** (`resequence()` → `order = index + 1`) rather than a two-row swap, so it is immune to
>   duplicate/colliding `order` values. Needed one backend field: `UpdateClassDto.order` (the `PATCH
>   /classes/:id` route and its matrix row already existed, so **no new matrix row**).
> - **`/setup` step 3** renders the same `ClassManager` while setup is incomplete (the wizard still
>   works end-to-end), then collapses to a one-line summary + *"Manage classes & sections →"*.
>   `/setup` stays routable, so existing deep links and Playwright specs keep working.
> - **SU-39 closed as a side effect:** `/classes` in `NAV` means `navItemFor('/classes/<id>')` now
>   matches by prefix, so the previously ungated class-detail page is role-gated by the layout.
> - Copy fixes: *"Choose different subjects"* → *"Pick this section's subjects"* (SU-21), and both
>   multi-entry inputs now say *"Separate with commas to add several at once"* (SU-20).
> - Gates: web tsc ✅ · web lint ✅ · api build ✅. `/classes` and `/setup` both serve 200.
> - **Not done here:** SU-22/SU-23 (chip affordance consistency) and the P1 safety items — the row
>   internals were moved verbatim and still carry native `confirm()` and the ambiguous section-pill click.

### D3 — original options (for the record)
- **Option A (recommended):** `/setup` stays the **first-run wizard** and collapses to a one-line
  "Setup complete" summary; a new **Classes** screen (nav: Academics) becomes the permanent manager.
- **Option B:** keep everything on `/setup` but auto-collapse completed steps and pin step 3 to the top.
  Cheaper, but keeps a wizard as a management console — the root cause stays.

---

## 2. Corrections to the audit (verified against `prisma/schema.prisma`)

Being accurate matters more than being right the first time — three findings were overstated and
two new ones surfaced:

| ID | Correction |
|---|---|
| **SU-32** | ~~"No duplicate-class-name guard"~~ → **DB enforces `@@unique([campusId, name])`**. The server returns a clean 409. Real (smaller) issue: the UI doesn't warn *before* submit, and the placeholder `9th` invites the collision. **Downgraded 🟡→🟢.** |
| **SU-33** | ~~"Duplicate subject can be created"~~ → **DB enforces `@@unique([classId, name])`** within a class. The genuine problem is **cross-class** drift, which no constraint can catch. **Re-scoped into SU-04.** |
| **SU-12** | Delete need not be the only option: **`Class.isActive` and `Section.isActive` already exist** — archive/deactivate is available with **no schema change**. Raises the fix quality at no cost. |
| **SU-40** 🔴 *(new)* | **`Section.capacity` (default 40) exists and is enforced** (CSV import rejects HARD-capacity overflow) but is **never shown or editable** in Setup. Admins can't see or change how many seats a section has, yet admissions fail against it. |
| **SU-41** 🔴 *(new)* | **`Class.minAgeYears` / `maxAgeYears` exist and gate admissions** (they produce the `422 AGE_OUT_OF_RANGE` block + override we hit live) but there is **no UI anywhere to set them**. A rule that blocks real admissions is unconfigurable from the product. |

---

## 3. Phased plan

Sequencing rationale: **stop lying (P1) → stop corrupting data (P2) → restructure (P3) → polish (P4)**.
P1 and P2 are independent and can run in parallel; P3 depends on D3; P4 lands on top of P3's markup.

### Phase 0 — Decisions + design spike *(no code)*
**Closes:** nothing directly; unblocks everything.
- Resolve D1, D2, D3.
- Produce a low-fi layout for the class row (what a school actually needs at a glance:
  name · strength/capacity · sections · subjects · status · one primary action + overflow).
- Agree the vocabulary strings for Class / Section / Subject / capacity (O5).
**Effort:** 0.5 day. **Output:** decision entries in `00-Meta/Key Decisions.md`.

---

### Phase 1 — "Tell the truth, and stop the accidents"
*Highest value per hour. Mostly frontend; two small API additions.*

**Closes:** SU-03, SU-05, SU-07, SU-08, SU-10, SU-11, SU-12, SU-13, SU-14, SU-15, SU-17, SU-18, SU-19, SU-28, SU-29, SU-31, SU-40, SU-41

**1.1 Honest completion state** *(SU-07, SU-08)*
- Step 3 is ✓ only when **every** class has ≥1 section **and** ≥1 subject.
- When not, the step header names the blockers: *"2 classes need attention: 9th (no section), 10th (no subjects)"*, each a jump link to the row.
- Per-class status pill: `Ready` / `Needs a section` / `Needs subjects`.

**1.2 Nothing means nothing** *(SU-03, SU-05)*
- Every section chip is **always** labelled: `Section A · all 7 subjects` or `Section B · 6 of 7`.
- Step header shows **distinct** subject count: `19 subject entries · 11 distinct`, with a tooltip
  explaining the difference. (Becomes redundant after P2 — keep until then.)

**1.3 Safe destructive actions** *(SU-10, SU-11, SU-12, SU-13, SU-14)*
- Replace **all** native `confirm()` / `prompt()` with the app's own modal (reuse the existing toast/card
  styling). Section rename becomes inline-edit, matching class rename which already works that way.
- **Archive before delete:** primary destructive action becomes *Archive* (`isActive=false`, reversible);
  *Delete* moves behind an "⋯" overflow menu and requires typing the class name when dependants exist.
- Confirmation states blast radius: *"Section A has 24 enrolled students. Archiving keeps their records; deleting is blocked while students are enrolled."*
- Action row restructured: **one primary** (`+ Section`), secondary (`+ Subject`), rest into "⋯".
- All icon targets ≥24×24 with ≥8px separation from the label.

**1.4 Feedback where the action is** *(SU-15, SU-17, SU-18, SU-19)*
- Row-level inline messages for row-level actions; page toast reserved for page-level events.
  (Or a sticky toast region — decide in P0 design.)
- Disabled buttons state the reason: *"Enter a class name"*, *"Select a campus"*.
- Skeleton rows while `loaded === false`; the "No classes yet" empty state renders **only after** load.
- Replace blanket `reload()` with targeted refetch of the affected collection (removes flicker).

**1.5 Show what matters** *(SU-28, SU-29, SU-40)*
- Class row shows **strength** (enrolled) and per-section `18/40` fill; replaces `Created <date>`
  (moved to a tooltip/detail).
- **Section capacity becomes visible and editable** — the constraint already exists server-side.

**1.6 Age band is configurable** *(SU-41)*
- `Min age` / `Max age` on class create + edit, with the copy *"Used to warn during admission; the admission controller can override."*

**1.7 Panels stop fighting the user** *(SU-31)*
- Sync `open` from `openByDefault` **on first load only**; user's manual collapse persists across refetches.

**API/backend work in this phase (flag for estimation):**
- `GET` class/section **enrolled counts** (new lightweight summary endpoint or extend `/classes`).
- `PATCH /classes/:id` to accept `minAgeYears`/`maxAgeYears` (today the client only renames).
- `PATCH /sections/:id` to accept `capacity`.
- Archive endpoints (or `isActive` on the existing PATCH).
- Matrix-conformance rows for any new/changed endpoint (project gate).

**Acceptance:** a school with one deliberately broken class (no sections) shows ✗ + names it; deleting a
section with enrolled students is blocked with a readable reason; no native dialog appears anywhere.
**Effort:** ~3–4 dev-days (≈1 of it API).

---

### Phase 2 — Subject integrity *(depends on D2)*
**Closes:** SU-04, SU-06, SU-33, SU-34

**2.1 Stop new drift**
- `GET /subjects/catalogue` → distinct subject names across the school with usage counts.
- Subject input becomes an **autocomplete** over that catalogue.
- **Near-match guard** on submit: normalized compare (lowercase, strip spaces/punctuation) + edit-distance ≤2
  → *"'Mathmetics' looks like 'Math', used in 2 other classes. Use existing / Create anyway."*
- Normalize on write: trim + collapse internal whitespace. (Case handling: decide in P0 — recommend
  preserve-as-typed, compare case-insensitively.)

**2.2 Stop the retyping that causes drift**
- "Copy subjects from another class" available on **existing** classes, not only at creation *(SU-34)*.
- Bulk apply: pick a subject set → apply to N classes.
- Class creation's copy step becomes part of one transaction/flow so a partial failure can't leave a
  subject-less class silently.

**2.3 Clean up existing drift — treated as a data migration, not a UI task**
- Read-only **drift report** first (groups of near-identical names + affected classes/exam results).
- Merge tool repoints `SectionSubject` and **`ExamResult.subjectId`** to the survivor, then deactivates
  the duplicate. Runs **dry-run first**, inside a transaction, writes an audit record.
- Requires a DB backup/restore-verify beforehand (project already has `restore-verify-local.sh`).

**Risk:** 🔴 highest-risk phase — `ExamResult` is graded student data. Do not bundle with UI changes;
ship 2.1/2.2 first, run 2.3 separately with the report reviewed by you.
**Acceptance:** typing "Mathmetic" warns; drift report returns 0 groups after merge; exam results per
subject reconcile to the same totals pre/post merge.
**Effort:** ~2 days (2.1/2.2) + ~2–3 days (2.3 incl. verification).

---

### Phase 3 — Information architecture *(depends on D3)*
**Closes:** SU-01(A), SU-09, SU-20, SU-21, SU-22, SU-23, SU-24, SU-25, SU-26, SU-27, SU-30

- **Split** (D3-A): `/setup` = first-run wizard, collapsing to a compact summary once complete; new
  **Classes** manager screen with search / filter / sort, sticky "Add class" at top, per-class strength.
- **Class reordering** *(SU-09)*: up/down or drag, writing `order` — currently permanent and wrong (9th, 10th, 8th).
- **Consistent affordances** *(SU-22, SU-23)*: subject and section chips get distinct styling;
  navigation becomes an explicit link/action, never an ambiguous pill click.
- **Explain the model inline** *(SU-01 option A, SU-20, SU-21)*: a one-line definition of section+capacity;
  multi-entry ("A, B, C") stated as helper text rather than hidden in a placeholder; rename
  "Choose different subjects" → *"Pick this section's subjects"* and stop pre-ticking all.
- **Fix the ping-pong** *(SU-30)*: Setup ⇄ Teachers ⇄ Staff — assign teachers in context.
- Keep `/setup` deep links working (redirect/anchor) so existing bookmarks and Playwright specs don't break.

**Effort:** ~5–6 dev-days. **Risk:** 🟡 touches routing + `NAV` role gating (add the new route to `NAV`, and
add a matrix row — note **SU-39**: `/classes/[id]` is currently absent from `NAV`).

---

### Phase 4 — Accessibility, responsive, polish
**Closes:** SU-24, SU-35, SU-36, SU-37, SU-38, SU-39

- Step headers become real `<button>`s with `aria-expanded`/`aria-controls`, keyboard operable *(SU-35)*.
- All targets ≥24×24 (WCAG 2.5.8); raise 12px muted text to ≥13px and re-check contrast *(SU-36, SU-37)*.
- Responsive pass at 1280 / 1024 / 768: action cluster collapses to "⋯" so **Delete never relocates** *(SU-38)*.
- Add `/classes/[id]` to `NAV` + a matrix-conformance row *(SU-39)*.
- Focus management for the new modals (trap, restore on close).

**Effort:** ~2–3 dev-days.

---

### Phase 5 — Deferred / product-gated
- **SU-01 Option B** (`Room` entity + timetabling) — only if D1 = B.
- **D2 Option B** (school-level subject catalogue + `ClassSubject`) — schedule as its own milestone.

---

## 4. Coverage matrix (all 41 issues)

| Phase | Issues closed |
|---|---|
| **P0 decisions** | D1, D2, D3 (unblock SU-01, SU-04, SU-25) |
| **P1 truth & safety** | SU-03, 05, 07, 08, 10, 11, 12, 13, 14, 15, 17, 18, 19, 28, 29, 31, **40**, **41** |
| **P2 subject integrity** | SU-04, 06, 33, 34 |
| **P3 IA** | SU-01(A), 09, 20, 21, 22, 23, 24, 25, 26, 27, 30 |
| **P4 a11y/responsive** | SU-24, 35, 36, 37, 38, 39 |
| **P5 deferred** | SU-01(B), SU-02 (fully resolved only by catalogue model) |
| **Downgraded** | SU-32 (DB already guards; UI warning folded into P1.4) |

**SU-02** (subjects at two levels) is *mitigated* by P1.2 labelling and P3 copy, but only *resolved* by D2-B.

---

## 5. Test plan

**5.1 Automated**
- Playwright `setup.spec.ts` (new): fresh school → campus → year → class → section → subject → ✓ complete;
  broken-class school → step shows ✗ + names the class; archive vs delete paths; a11y assertions.
- Extend existing specs that touch Setup so the IA split (P3) doesn't silently break them.
- `axe` pass on `/setup` and the new Classes screen (P4).
- Matrix-conformance rows for every new/changed endpoint (**merge-blocking project gate**).

**5.2 Regression watch (P2/P3 blast radius)**
- Admissions age-gate (422 + override) still behaves after SU-41 edit UI.
- Exam marks entry & report cards after any subject merge.
- Class dropdown ordering across Students / Attendance / Exams / Fees after reorder (P3).

**5.3 Manual QA matrix**
| Scenario | Roles |
|---|---|
| Fresh school, zero data | OWNER_ADMIN |
| Existing school, mid-year edit | OWNER_ADMIN, CAMPUS_ADMIN (scoped to own campus) |
| Multi-campus, 12+ classes | OWNER_ADMIN |
| Keyboard-only, then 768px tablet | any |

**5.4 Gates (unchanged project standard)**
`pnpm test` (unit → integration → isolation) · `test:isolation` · RLS-coverage · lint · strict typecheck ·
api + worker build · web tsc + lint.

---

## 6. Risks & rollback

| Risk | Severity | Mitigation |
|---|---|---|
| Subject merge corrupts graded results (P2.3) | 🔴 | Dry-run report reviewed first; single transaction; audit record; DB backup + `restore-verify-local.sh` beforehand; ship separately from UI. |
| IA split breaks deep links / Playwright (P3) | 🟡 | Keep `/setup` routable with redirects/anchors; update specs in the same PR. |
| Class reorder changes ordering app-wide (P3) | 🟡 | Verify every class dropdown consumer; ordering is display-only, no FK impact. |
| New endpoints drift from permission matrix | 🟡 | Matrix row added with each endpoint — the suite fails the build otherwise. |
| Scope creep into a redesign | 🟡 | Phases are independently shippable; P1 alone materially raises clarity. |

**Rollback:** each phase is a separate branch/PR; P1/P3/P4 are frontend-reversible. P2.3 is the only
irreversible step — gated behind a reviewed dry-run and a verified backup.

---

## 7. Out of scope
Timetabling, room allocation (unless D1=B), fee-structure UX, teacher assignment redesign, and the
`Subject` catalogue re-modelling (D2-B) — each is its own piece of work.

## 8. Indicative effort

| Phase | Effort | Ship independently? |
|---|---|---|
| P0 decisions | 0.5 d | — |
| P1 truth & safety | 3–4 d | ✅ yes — biggest clarity gain |
| P2.1/2.2 drift prevention | 2 d | ✅ yes |
| P2.3 drift cleanup | 2–3 d | ⚠️ separate, gated |
| P3 IA | 5–6 d | ✅ yes (after D3) |
| P4 a11y/responsive | 2–3 d | ✅ yes |
| **Total** | **~15–19 dev-days** | excluding P5 |

**Recommended first slice:** P1 alone. It closes 18 of 41 issues, needs no schema change, and moves the
clarity score from 5/10 to ~7.5/10 on its own.

---
---

# Part II — Round 2 plan (post D1–D3 re-audit, 2026-07-27)

## II.0 Where we actually are

D1, D2 and D3 shipped (see §1). A second QA/UX pass on the **current** screen found:

- **12 of the original 41 closed** — SU-01(A), 04, 09, 20, 21, 25, 26, 27, 30, 33, 39, 40.
- **~14 new findings (N-01 … N-14)**, most of them *seams created by the split* rather than deep faults.
- **P1 (truth & safety) and P4 (a11y) never ran** — so the heaviest user-facing problems are still live:
  false completion state, native `confirm()`, toast placement, keyboard access, unconfigurable age band.

Clarity moved **5/10 → 6.5/10**. The remaining gap is mostly P1.

> **Root lesson for sequencing:** shipping the *structural* phase (D3) before the *truth* phase (P1)
> created N-03 — two screens now disagree on the subject count. Structure should follow truth, not lead
> it. P1 runs next, before any further restructuring.

## II.1 New decision needed — D4 (blocks Phase 3b only)

### D4 ✅ **DECIDED: Option B — implemented + live-verified 2026-07-27**
> **`/setup` is now "School configuration"** — first-run wizard while incomplete, a real configuration
> home afterwards. Closes **N-01, N-02, N-04, N-05, N-12**.
> - Nav label `Setup` → **`School configuration`** (⚙️, Administration). With `Classes` now under
>   Academics, the "two doors" ambiguity (N-02) is resolved by name, not by memory.
> - **Adaptive copy (N-05):** the "Three things to set up… do them in order" instruction is replaced once
>   complete by *"Your campuses, school years and class structure…"*, and the 3-of-3 progress card is
>   **hidden** rather than left as permanent furniture.
> - **Honest summary (N-04):** *"Classes, sections and subjects are managed on the Classes screen"* —
>   no longer implies campuses/years moved too.
> - **Campus rename + delete (N-12)** — inline editor for name/address, delete behind a confirm. The
>   `PATCH`/`DELETE /campuses/:id` endpoints **already existed and were matrix-tested**; only the UI was
>   missing, so this was frontend-only. `Campus.address` added to the web type (API already returned it).
>   Server-side delete guard already names the real blocker (classes/users/inquiries/vacancies/applications).
> - Cross-link *"Staff logins … are managed in Campus Hub"* so campus **config** vs campus **people**
>   don't become a new ambiguity.
> - `/setup` stays routable — deep links unaffected.
> - **Live-verified** as owner on the demo tenant: sidebar reads "School configuration" + "Classes";
>   completed-state header/summary/link render; progress card correctly hidden; campus row shows
>   Rename/Delete; the rename editor opens and cancels cleanly. Gates: web tsc ✅ · web lint ✅ · repo
>   eslint ✅. API `PATCH /campuses/:id` re-verified idempotently (200, no data changed).
> - **Deliberately still open here:** **N-03** — step 3 still reads *"19 subjects"* (raw count) while
>   `/classes` says distinct. That is Phase 1a, kept out to avoid mixing phases.
> - **Follow-up found, not fixed:** academic years remain **add + set-current only** — there is no
>   `PATCH`/`DELETE /academic-years/:id` on the API, so year editing needs backend work (Phase 3b).
> - **Test debt surfaced:** `test/e2e/exams.spec.ts` has been **stale since 2026-07-10** — it expects
>   "Class created"/"Section created"/"New student", none of which exist since the Setup redesign. Its
>   nav selector was updated to the new label so this change adds no new breakage, but the spec needs a
>   full rewrite against the current UI (tracked separately — it is red for reasons predating D1–D4).

### D4 — original options (for the record)
Today it is a near-empty page with full sidebar prominence that mostly points at `/classes`.
- **Option A — Auto-hide.** Drop it from the sidebar once `nextStep === 0`; keep the route reachable from
  Classes/Campus Hub. Cheapest; but "where did Setup go?" becomes a support question.
- **Option B — Rename to "School configuration" (recommended).** Keep the route, retitle it, and make it
  the honest home for the things that *genuinely* live there: campuses, academic years, GR-number mode,
  grading scale, section-capacity mode. First-run keeps the numbered-wizard behaviour; afterwards it
  becomes a config screen rather than a signpost. Fixes N-01/N-02/N-04/N-05 in one move **and** gives
  N-12 (campus rename/delete) a natural home.
- **Option C — Merge into Campus Hub** and delete `/setup`. Cleanest IA, largest churn, breaks deep links
  and Playwright specs.

## II.2 Phase 1a ✅ **IMPLEMENTED + live-verified 2026-07-27**

Closed **N-03, N-07, N-08, N-10, N-11, N-14** (N-04/N-05 were already closed by D4).

- **N-03 (the trust bug) — fixed at the source.** Rather than pointing Setup at D2's catalogue endpoint,
  both screens now derive the count from the **same client-side helper**
  `subjectCatalogueFrom(subjects)` (`lib/subject-match.ts`), so they cannot drift apart again and the
  figure doesn't depend on a reachable endpoint. **Live-verified:** Setup now reads
  *"3 classes · 4 sections · **11 subjects**"* (was 19 — the raw row count). Confirmed against real data:
  19 rows → 11 distinct, `Math` present in 2 classes.
- **N-08 — the guard no longer fails silently open.** The same derivation is used as a **fallback
  catalogue**, so autocomplete + near-match warnings work even when `/subjects/catalogue` is
  unreachable (verified: `Mathmatics` → suggests `Mathmetics` from a derived catalogue, no API).
  Server catalogue is still preferred when present.
- **N-07 — "no current year" stops masquerading as zero.** `listSections` now returns
  **`enrolled: null`** (not `0`) when no academic year is current; the chip renders `—/40` with an
  explanatory tooltip, the manager shows *"Seats show capacity only — set a current school year to
  count enrolment"* once, and the Classes metric shows `—/seats`. The capacity-vs-enrolled guard
  correctly does **not** block when enrolment is unknown.
- **N-10** — section editor now titled *"Editing Section B"*.
- **N-11** — subject ✕ raised to the same 24×24 target as the section controls.
- **N-14** — one `<datalist>` per manager instead of one per class row (id passed down).
- Gates: web tsc ✅ · web lint ✅ · api build ✅.

### II.2 (original scope, for the record)

Small, high-trust-impact fixes. Ship as one PR.

| Issue | Change | Acceptance |
|---|---|---|
| **N-03** 🔴 | Setup step-3 count uses the **distinct** subject count (reuse D2's catalogue), or drops the subject figure entirely and defers to `/classes`. | Setup and `/classes` never show different subject totals. |
| **N-07** 🟡 | When no academic year is current, seats render `—/40` with the hint *"No current school year — enrolment isn't counted yet."* instead of a confident `0`. | With `isCurrent` unset, no section claims 0 enrolled. |
| **N-10** 🟡 | Inline section editor gains a heading: *"Editing Section B"*. | With ≥2 sections, the open editor names its target. |
| **N-11** 🟡 | Subject chip ✕ raised to the same 24×24 target as the section controls. | Both chip rows have identical target sizes. |
| **N-04 / N-05** 🟡 | Summary copy → *"Classes and sections are managed on the Classes screen."*; page header adapts once complete (drop "Do them in order"). | No sentence claims campuses/years moved. |
| **N-08** 🟡 | When the catalogue is empty, the subject field shows nothing misleading; the guard's absence is not silently implied to be "checked". | Empty catalogue ⇒ no false sense of validation. |
| **N-14** 🟢 | Render the subject `<datalist>` **once per manager**, not once per class row. | One datalist node regardless of class count. |

## II.3 Phase 1b — Truth & safety *(the original P1, now the top priority)*

Unchanged from Part I §3 Phase 1, minus what D1 already delivered (SU-40). Closes:
**SU-03, SU-05, SU-07, SU-08, SU-10, SU-11, SU-12, SU-13, SU-14, SU-15, SU-17, SU-18, SU-19, SU-28,
SU-29, SU-31, SU-41.**

Highest-value items, in order:
1. **SU-07 / SU-08 — honest ✓.** Complete only when *every* class has ≥1 section **and** ≥1 subject; the
   step names the offenders and links to them. Per-class status pill: `Ready` / `Needs a section` / `Needs subjects`.
2. **SU-03 — never let absence carry meaning.** Always label: `Section A · all 7 subjects` / `Section B · 6 of 7`.
3. **SU-10/11/12 — safe deletes.** App modal replaces `confirm()`; **Archive** (`isActive`, already in the
   schema) becomes the primary destructive action; confirmation states blast radius (enrolled students).
4. **SU-15 — feedback next to the action** (row-level inline messages).
5. **SU-41 — min/max age UI** on class create/edit (`UpdateClassDto` already accepts both fields).
6. **SU-18 / SU-31** — skeleton before first paint; stop the effect overriding manual collapse.
7. **SU-28 / SU-29** — show strength, demote `Created …`.

**API work:** enrolled counts per class (section counts exist after D1), archive endpoints, matrix rows.
**Effort:** ~3–4 d. **Acceptance:** a school with one section-less class cannot show "Setup complete";
no native dialog remains anywhere on the screen.

## II.4 Phase 2b — Subject work remaining

| Issue | Work |
|---|---|
| **SU-34** 🟡 | "Copy subjects from another class" for **existing** classes (today it exists only at creation), plus bulk-apply a set to N classes. *(Explicitly not delivered in D2.)* |
| **SU-02** 🔴 | Make the class-catalogue ↔ section-list duality legible: one line of copy + consistent labelling. Fully resolved only by D2-B (deferred). |
| **SU-06** 🟡 | House style for naming ("Grade 1" vs "9th" vs "Nursery") applied to hints/placeholders. |
| **§3.3** ⚠️ | **Existing drift merge** (`Mathmetics` → `Math`) — unchanged from Part I: dry-run report you review, single transaction, audit record, verified backup. Touches `ExamResult.subjectId`. Still the only irreversible step in the whole plan. |

**Effort:** ~2 d (+2–3 d for the gated merge).

## II.5 Phase 3b — IA finish *(needs D4)*

**N-01, N-02, N-04, N-05, N-12, N-13, N-09, SU-22, SU-23.**
- Implement the D4 outcome (recommended: rename to *School configuration*, keep first-run wizard).
- **N-12** — campus rename/delete and academic-year edit (today both are **add-only**; a typo is permanent).
- **N-09 / SU-22 / SU-23** — de-crowd the section pill (4 targets today), give subject vs section chips
  distinct affordances, make "view students" an explicit action rather than an unmarked pill click.

**Effort:** ~3–4 d. **Risk:** 🟡 routing + nav changes; keep `/setup` routable and update specs in the same PR.

## II.6 Phase 4 — Accessibility & responsive *(unchanged)*
**SU-35, SU-36, SU-37, SU-38** — real `<button>` step headers with `aria-expanded`, ≥24px targets
everywhere, ≥13px body text, and a tested 1280/1024/768 pass. **Effort:** ~2–3 d.

## II.7 Ops note (not a product defect)

D1/D2/D3 added API surface (`enrolled`, `/subjects/catalogue`, `UpdateClassDto.order`). The dev API runs
from `dist` (`node dist/apps/api/main`), so it serves stale code until rebuilt + restarted — which is why
seats read `0/40` and the autocomplete is empty today (**N-06**). Normal deploy behaviour, not a bug.
**Action:** none in prod; locally `pnpm start:api:dev`. Worth adding a build-version line to
`/health/ready` so a stale API is obvious rather than looking like missing data.

## II.8 Coverage matrix (round 2)

| Phase | Closes |
|---|---|
| **1a same-day** | N-03, N-04, N-05, N-07, N-08, N-10, N-11, N-14 |
| **1b truth & safety** | SU-03, 05, 07, 08, 10, 11, 12, 13, 14, 15, 17, 18, 19, 28, 29, 31, 41 |
| **2b subjects** | SU-02(partial), 06, 34 · §3.3 drift merge (gated) |
| **3b IA** (needs D4) | N-01, N-02, N-09, N-12, N-13, SU-22, SU-23 |
| **4 a11y** | SU-35, 36, 37, 38 |
| **Deferred** | SU-01(B) rooms, D2-B catalogue re-model, SU-32 (DB already guards) |

## II.9 Sequencing & effort

| Phase | Effort | Depends on |
|---|---|---|
| 1a same-day corrections | 0.5–1 d | — |
| 1b truth & safety | 3–4 d | — |
| 2b subjects | 2 d (+2–3 d gated merge) | — |
| 3b IA finish | 3–4 d | **D4** |
| 4 a11y & responsive | 2–3 d | 3b (markup settles) |
| **Total** | **~11–15 dev-days** | excluding the gated merge |

**Order: 1a → 1b → 2b → (D4) → 3b → 4.** Truth before structure this time.

## II.11 Execution sequence

### Step 0 — Land what's already built *(do first)*
Working tree holds **D1–D4 + Phase 1a**, nothing else. *(Correction: the earlier "eight pending commits"
was wrong — the owner-add-student authz, guardian-email 409 fix and "+ Add teacher" button were already
committed in `29aaea8` / `9911e46`.)*

A phase-by-phase commit split is **not achievable** here: `setup.service.ts` and `setup/page.tsx` each
carry hunks from D1, D2, D3 and 1a, and this environment has no interactive hunk staging (`git add -i`
is unsupported). So split by **layer**, which is clean and leaves each commit independently buildable:

| # | Commit | Contents |
|---|---|---|
| **0.1** | `feat(setup-api): section enrolment, subject catalogue, class ordering` | `setup.service.ts`, `setup.controller.ts`, `dto/setup.dto.ts` — enrolled counts (`null` when no current year), `GET /subjects/catalogue`, subject-name normalisation, `UpdateClassDto.order`. Web tolerates the absence of these fields, so this is safe alone. |
| **0.2** | `feat(web): School configuration vs Classes manager` | `class-manager.tsx`, `classes/page.tsx`, `subject-match.ts`, `setup/page.tsx`, `lib/api.ts`, `lib/roles.ts`, `test/e2e/exams.spec.ts`, plus this plan document. |

**Gate before pushing:** web tsc + lint, api build, **restart the API** and re-verify seats/catalogue live.

### Step 1 — Phase 1b · truth & safety — ⏳ **TRUTH HALF DONE 2026-07-27, safety half open**

**Done (truth):**
- **SU-07/08 — honest ✓.** Step 3 is complete only when **every** class has ≥1 section *and* ≥1 subject
  (`classesReady`), and `nextStep`/progress derive from it. When it isn't, a warning **names the
  offenders**: *"2 classes cannot take students yet: 9th (no section), 10th (no subjects)"*.
- **SU-03 — absence no longer carries meaning.** Sections always state their subjects:
  `Section A · all 7 subjects` / `Section B · 6 of 7 subjects`. Empty `subjectIds` correctly reads as
  *inherits all*, which is what the API means by it.
- **SU-28/29 — strength over trivia.** Class row shows a **Ready / Needs a section / Needs subjects**
  pill plus live student count and age band; `Created …` demoted to a tooltip on the class name.
- **SU-41 — age band configurable at last.** Rename became a proper class editor (name + min/max age)
  with a min<max guard. `UpdateClassDto` already accepted the fields — only the UI was missing.
- **SU-18 — no false empty state.** Steps render a skeleton until `loaded`, so a configured school never
  flashes as "nothing set up".
- **SU-31 — panels stop fighting the user.** A manual collapse is remembered (`touched` ref); derived
  state only syncs until the user first interacts.
- Prop rename `onRenameClass` → `onUpdateClass` across manager + both pages.
- Gates: web tsc ✅ · web lint ✅ · `/setup` + `/classes` serve 200, no compile errors.
- **Live UI verification blocked** by the preview pane dropping `*.localhost` cookies (API login itself
  returns 200 — tooling limitation, not an app fault). Logic is gated by tsc/lint + route smoke only.

**Safety half — done 2026-07-28 (`e84f178`), except archive:**
- **SU-11/12 — `confirm()` is gone.** New `classes/confirm-dialog.tsx` replaces every native
  `confirm()`/`prompt()` on both screens. This was the real interaction risk: Chrome's *"prevent this
  page from creating additional dialogs"* removed the old guard entirely after one use, so subsequent
  deletes fired **with no confirmation at all**. The in-app dialog cannot be suppressed, traps focus,
  and closes on Escape.
- **Blast radius stated.** A class names its section/subject counts, a section names its enrolled
  students, a subject names the exam results / assignments / timetable slots that will block it.
- **SU-15 — feedback where the click was.** `run()` now returns the failure message and the dialog
  renders it **inline**, so a refused delete explains itself instead of only writing a toast at the top
  of the page. (Non-destructive actions still use the page toast — full row-level messaging is open.)
- **SU-13/14 — hierarchy.** `+ Section` primary, `+ Subject` secondary, and Edit / Teachers / View
  students / Delete moved into an **⋯ overflow menu**, so Delete no longer sits among routine actions
  nor relocates as the row wraps.
- **SU-17** — disabled "Add class" states the reason.
- **Correction to the earlier framing:** the server *already* refuses class, section and subject deletes
  when dependents exist and names them (`deleteClass`/`deleteSection`/`deleteSubject`). The catastrophic
  path was never open — this slice closes the **interaction** risk, not a data-loss hole.
- Gates: web tsc ✅ · web lint ✅ · `/setup` + `/classes` 200 · no `confirm(`/`prompt(` left in either screen.

**Still open:** **SU-10 archive-before-delete** — deliberately deferred. `isActive` exists on Class and
Section, but "archived" only means something if archived classes also disappear from the admission,
exam, fees and attendance pickers, and that risks blank labels on historical records that resolve names
through the same list endpoints. That is a **product decision (D5)**, not a code detail. Also open:
**SU-19** (targeted refetch).

### Step 1 — Phase 1b · original scope *(3–4 d, no decisions)*
The largest remaining slice; do it before any further restructuring.
1. Honest ✓ (**SU-07/08**) + per-class status pills — *the "you can admit students" claim must be true.*
2. Always-label section subjects (**SU-03**) — *closes the original complaint.*
3. Archive-before-delete + app modal replacing `confirm()` (**SU-10/11/12**).
4. Row-level feedback (**SU-15**), disabled-reason text (**SU-17**).
5. Min/max age UI (**SU-41**) — *`UpdateClassDto` already accepts both fields.*
6. Skeletons (**SU-18**), stop the panel effect fighting the user (**SU-31**), strength over `Created` (**SU-28/29**).
**Exit:** a school with one section-less class cannot show "complete"; no native dialog remains.

### Step 2 — Phase 2b · subjects *(2 d)*
`SU-34` copy-subjects for existing classes + bulk apply · `SU-02` duality copy · `SU-06` naming house style.
**Exit:** a class can inherit another's subject list without retyping.

### Step 3 — §3.3 drift merge ⚠️ *(2–3 d, gated, ships alone)*
Dry-run report → **you review** → backup + `restore-verify-local.sh` → transactional merge with audit.
Touches `ExamResult.subjectId`. **Never bundled with UI work.**
**Exit:** drift report returns 0 groups; per-subject result totals reconcile pre/post.

### Step 4 — Phase 3b · IA finish *(3–4 d)*
Needs backend for academic-year edit (`PATCH`/`DELETE /academic-years/:id` **do not exist**).
`N-09`, `SU-22/23` chip affordances · year editing · remaining IA polish.

### Step 5 — Phase 4 · a11y & responsive *(2–3 d)*
`SU-35` keyboard step headers · `SU-36/37` targets + contrast · `SU-38` 1280/1024/768 pass.
Runs last so it lands on settled markup.

### Step 6 — Test debt *(0.5–1 d, can run in parallel any time)*
Rewrite `test/e2e/exams.spec.ts` against the current UI — **red since 2026-07-10**, predating all of this
work. Add a `setup.spec.ts` covering wizard → complete → Classes manager.

### Sequence at a glance
```
Step 0 (commit) → 1b truth&safety → 2b subjects → 3 drift merge (gated, alone)
                                                → 4 IA finish → 5 a11y
                  Step 6 test debt ── parallel, any time ──┘
```
**Rule carried forward:** truth before structure. D3 shipped ahead of P1 and produced N-03 (two screens
disagreeing); Phase 1b is therefore sequenced ahead of any further restructuring.

## II.10 Definition of done

- No screen contradicts another (subject counts, seat counts).
- "Setup complete" is true only when every class can actually take a student.
- No native `confirm()`/`prompt()`; every destructive action is archivable or states its blast radius.
- Every control keyboard-reachable; no layout break ≥768px.
- Target clarity score: **9/10**.
