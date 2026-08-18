---
title: Campus Lens (the multi-campus director's view)
type: plan
status: BUILT — 2026-08-18 (option B). Oversight + grouping + create-prefill. See §10.
updated: 2026-08-18
---

# 🔭 Campus Lens

> The IA2 design, re-derived from how Pakistani private schools actually run branches — after the
> audit's "12 duplicated selectors" was found to be ~2 redundant selects. Related:
> [[System Structure]] · [[Information Architecture Plan]] §8.4 · [[Key Decisions]]

## 1. The market reality this is built for

Pakistani private schools split cleanly into two operating shapes, and the product serves both today
without ever naming the difference:

- **Single-campus schools** — the large majority: the independent neighbourhood school, 100–800
  students, one premises, one principal who is often the owner. **Campus is not a concept they have.**
  It must be invisible plumbing for them: no control, no headers, nothing.
- **Multi-campus groups** — common and growing: the branch/franchise chains (Beaconhouse, City
  School, Roots, Allied, Dar-e-Arqam, Punjab Group…) and, just as often, the independent school with
  **2–3 branches** — most characteristically a **separate Boys Campus and Girls Campus**, or Primary
  on one premises and Secondary on another. A director here reviews branches **one at a time, then
  compares**.

## 2. Who stands where (mapped to the roles that exist)

| Real role | System role | Campus relationship |
|---|---|---|
| **Director / Owner / CEO** | `OWNER_ADMIN` | School-wide. Sees every branch. Reviews each in turn. |
| **Campus Head / Principal / Branch Incharge** | `CAMPUS_ADMIN` | Bound to **one** campus. Is *at* their branch. |
| Accountant, admission officer, teacher | their role + `campusId` | Bound to one branch. |

⚠️ **A gap worth naming, out of scope here:** a **central-office head accountant / HR head** who
oversees all branches *without being the owner* has no role — it is `OWNER_ADMIN` (everything) or
`CAMPUS_ADMIN` (one branch). Real groups have this person. Filed for a future role scope, not IA2.

## 3. The principle

> **Campus is a lens the director looks through, not a field stamped on every screen.**

One lens, in the shell, owned by the session. Everything else reads it. The lens is **invisible
unless the signed-in user is an owner with more than one campus** — which makes it free for the
single-campus majority and for every campus-bound role.

The server already supports this exactly: `effectiveCampusFilter(user, clientCampusId)` honours an
**owner's** chosen campus and **force-ignores** a campus-bound user's — so "the lens narrows, it can
never widen" is already true in the API. IA2 is therefore a **client convenience**, not a security
boundary: the boundary is already held server-side.

## 4. What the lens drives — three screen behaviours, one control

The audit's real error was treating every `campusId` on every screen as the same thing. They are
three different jobs, and one lens serves all three:

| Screen kind | Screens | With lens = **All campuses** | With lens = **one branch** |
|---|---|---|---|
| **Oversight lists** | dashboard, fees, students, staff, staff-attendance, performance, admissions | whole school | scoped to that branch — their own campus select **removed** |
| **Grouped displays** | classes, setup | campus **headers** (Model Town: … / DHA: …) — correct as-is | collapse to just that branch |
| **Create forms** | admissions (new inquiry), calendar (closure), timings (schedule), classes (add class) | campus field **defaults to nothing**, admin picks | campus field **pre-filled to the lens**, still editable |

⚠️ **Create-form pickers never disappear.** You cannot admit a student, declare a closure, or add a
class without saying *which branch*. A viewing lens does not remove a creating choice — it only
**pre-fills** it. Conflating the two is what made the audit miscount.

## 5. The boys/girls case, which is the everyday one

For the very common Boys-Campus / Girls-Campus school, the lens is not an occasional admin tool — it
is the **daily** motion: the director opens fees for the Boys Campus, reviews defaulters, switches
the lens to Girls Campus, reviews the same. Today they re-pick the campus on each screen with no
memory between them. The lens is "set the branch once, every oversight screen follows." That is the
whole value, and it is a real daily saving for this shape of school.

## 6. What "All campuses" means, per screen (the director's whole-school view)

- **Dashboard / fees / collections:** the group total — cash flow across branches, the director's
  headline number.
- **Staffing gaps / attendance:** every branch's, together.
- ⚠️ **Not yet built, and the real prize: branch COMPARISON.** A director's actual question is "how
  is DHA doing *versus* Model Town" — collections, attendance %, admissions, defaulters, side by
  side. The lens makes single-branch review easy; a **per-branch comparison dashboard** is the
  higher-value follow-on and belongs with Reports (IA4/Overview), not here. Named so it is not lost.

## 7. Mechanism (if built)

- A `CampusLensContext` in the app shell, seeded from `me`. Value: `campusId | null` (null = All).
- Rendered **only** when `isOwner && campuses.length > 1`. Everyone else: the context is fixed
  (a campus admin's own campus; a single-campus school's only campus) and no control shows.
- Persisted in `localStorage` so the branch a director chose survives a reload — a director lives in
  one branch for a stretch, and losing it on every refresh is the annoyance.
- Oversight screens read the lens instead of holding their own `fCampus`; grouped screens read it to
  decide headers-vs-single; create forms read it to pre-fill.
- ⚠️ **The lens is passed as `clientCampusId`; the API stays the authority.** A tampered lens value
  from a campus-bound user changes nothing — `effectiveCampusFilter` already ignores it.

## 8. Scope options put to the operator

- **A — Proportionate only.** Remove the redundant campus `<select>` on `/students` and `/staff` for
  campus admins (match `/performance` + `/staff-attendance`, already correct). ~20 lines, no shell
  machinery. Closes the only real "chooser you can't use." Leaves multi-campus directors re-picking
  per screen.
- **B — The lens (recommended for a multi-campus market).** Build §7 for the four oversight filter
  screens + the two grouped screens + create-form pre-fill. Real daily value for branch and
  boys/girls schools; invisible and free for single-campus. More surface, and the persistence +
  read-the-lens wiring across ~8 screens.
- **C — Lens + branch-comparison dashboard.** B, plus §6's per-branch comparison view. The
  director's actual headline need, but it is a new Reports screen and overlaps IA4 — larger.

## 9. Recommendation

**B**, scoped to oversight + grouping + create-prefill, if the target market includes the branch and
boys/girls schools (it does — they are a large share of Pakistani private education). It is invisible
for single-campus schools, so nothing is imposed on the majority, and it turns the director's daily
branch-switching from per-screen re-picking into one shell choice that follows them.

**A** is the honest minimum if the near-term customers are overwhelmingly single-campus — then the
lens is machinery for a case few users hit, and the two redundant selects are the only real defect.

**C** only once someone asks for branch comparison; it is a Reports feature wearing a campus hat.


## 10. As built — option B, 2026-08-18

`CampusLensContext` in the app shell, seeded from `me`, rendered **only** for an owner with >1
campus. Persisted in `localStorage` and restored on load. The active campus is passed to screens as
the ordinary `clientCampusId` — the server's `effectiveCampusFilter` remains the authority, so the
lens is convenience, never a boundary.

**Screens wired:**
- **Oversight lists** — `staff`, `staff-attendance`, `performance`, `students` read the lens and
  **dropped their own campus `<select>`**. `students` also resets its class/section drill when the
  lens branch changes (a class from another branch does not apply).
- **Grouping** — `classes` shows one campus when lensed in, all (with headers) on "All".
- **Create pre-fill** — `classes` (add class), `timings` (new schedule), `admissions` (new inquiry)
  default their campus field to the lens; the field stays editable.

**Deliberately NOT lensed:**
- `setup` — it is where you **manage** campuses; hiding other campuses there would hide what you came
  to edit. The lens is for oversight, not for editing the structure itself.
- `calendar` — a closure is declared per-campus explicitly; low value, left to the form's own picker.

**Verified live (demo owner, 2 campuses):** the control appears with All + both campuses; switching to
Falcon then E2E narrowed the staff list each time (bodyLen 3038 → 2887 → 2107) and wrote the choice to
`localStorage`; the lens **followed to `/classes`** and collapsed its grouping to the one branch;
**a reload restored the branch**; "All campuses" cleared the store and showed both campus headers.

**Gates:** web tsc + lint + production build; **Playwright 42 passed / 2 skipped / 0 failed** (the
shell change touches every page, so the full suite was the bar).

⚠️ **The scope shrank from the audit's framing, and honestly.** The audit's "12 duplicated selectors,
a campus admin sees a chooser they can't use 12 times" was ~2 redundant selects — see §8.4 of
[[Information Architecture Plan]]. What shipped is the *real* value the audit gestured at: a
multi-campus director sets the branch once and every oversight screen follows, which is the daily
motion of a Boys/Girls-campus school.

**Still open (named, not lost):** a central-office head accountant/HR role that spans branches
without being the owner (§2); and a per-branch **comparison** dashboard (§6, option C) — the
director's "DHA vs Model Town" question, which belongs with Reports.
