---
title: Live QA Remediation Plan
type: delivery
updated: 2026-09-24
author: Senior Eng + FE + BE + School Manager
status: proposed
---

# Live QA Remediation Plan — fix the findings from the portal pass (2026-09-24)

> **✅ EXECUTED 2026-09-24 — A–E done; F (re-seed) is the remaining ops step.**
> A #1b Campus Hub "Needs a campus" + assign (`44158dd`, verified live: HR visible). B real name in `/auth/me`
> + greetings (`60efde3`, verified: "Ayesha" / "Nadia Khan"). C canonical GR/Reg (`34d1c4b`, GR-0031 test).
> D campus-admin collections + academic-year "joined" window (`3899951`, verified: Rs 86,500 tile). E badge
> spacing was a **false positive** (get_page_text artifact — badges are visually spaced; no change).
> Gates: **integration 1823 ✓ / 74 suites**, typecheck clean. F: run `pnpm db:seed-real -- --commit` to
> refresh the demo (verified phones, HR model, GR format) — destructive, user-run.

Resolves the findings in [[Live Portal QA — all entities (2026-09-24)]]. Each item is root-caused to a
file, given the smallest correct fix (not a spot-patch), a regression guard, and an effort/risk. Ordered by
**operational impact on a real Pakistani private school**, not by code size.

Legend: **P1** blocks a role/operation · **P2** wrong/confusing to staff or parents · **P3** polish.
Status of #1 (HR campus) is **already shipped** (`815ff81`) and is folded in so the plan is complete.

---

## A — HR / user administration is repairable from the UI  ·  **P1**  ·  (#1 done · #1b open)
**Why it matters (school lens).** In a real school the office — not a developer — onboards and fixes staff
logins. A staff member who is locked out of their own module on day one, with no way for the principal to
fix it, is a support call the product must not create.

**#1 — HR had no campus → saw 0 staff. ✅ DONE.** Root cause: `seed-real-school.ts` created HR
`campusBound: false`, and the staff directory is campus-scoped, so a campus-less HR resolves to zero.
Shipped: `scripts/fix-hr-campus.ts` (bound live HR to Main Campus) + seed set to `campusBound: true`
(`815ff81`). Verified live: HR sees all 9 staff.

**#1b — the owner cannot assign/repair a user's campus from the UI (OPEN).** Root cause: **Campus Hub lists
only users that already have a campus**, so an orphaned user (no campus) is invisible and unfixable; there
is no user-level "move to campus" control. Any user who ends up campus-less (bad import, a role change, this
seed bug) is stranded.
- **Fix (BE + FE).**
  1. **BE:** ensure `GET /users` returns campus-less staff too, and that `PATCH /users/:id` (or a focused
     `PATCH /users/:id/campus`) can set `campusId`. It is MFA-gated today — keep that, but the owner must be
     able to reach it. Confirm the users list isn't itself campus-filtered in a way that hides orphans.
  2. **FE (Campus Hub):** add an **"Unassigned staff"** section listing campus-less users with a
     **"Assign to campus →"** action; and on each user row a "Move to campus". Mirror the existing
     move-student affordance.
- **Regression.** integration: create a campus-less staff user → `GET /users` includes them; assign campus →
  they appear under that campus and their campus-scoped screens return data. e2e: owner sees an
  "Unassigned staff" entry and assigns it.
- **Effort** ~0.5–1d · **Risk** low-med (touches user admin; MFA gate unchanged).

---

## B — People are shown by their real name, not their email  ·  **P2**  ·  (#3)
**Why it matters (school lens).** A teacher named **Ayesha Farooq** greeted as "Good afternoon, **Teacher1**"
reads as a system that doesn't know its own staff — poor for trust, and wrong on any shared screen a parent
might glimpse. Names are identity in a school.

**Root cause.** `packages/school-ui/src/app/home/page.tsx:153` derives the name from the email
(`me.email.split('@')[0]` → "teacher1"), and the `Me` type carries **no name field** (`Me { id, email, roles,
campusId, modules, mfaEnabled, admissionsMode }`). The dashboard greeting has the same gap (shows nothing).
- **Fix (BE + FE).**
  1. **BE:** add `name` to the `Me` payload — the signed-in user's display name: staff → `StaffProfile.fullName`,
     owner → the owner's name (fall back to the email local-part). One join in the `/auth/me` (session) resolver.
  2. **FE:** `Me` type gains `name?: string`; `home` and `dashboard` greetings use `me.name ?? emailPrefix`.
     Keep the `capitalize` guard already noted in the code.
- **Regression.** integration: `/auth/me` for a staff user returns `name` = their StaffProfile fullName.
  unit/e2e: greeting renders the name when present, email-prefix when absent.
- **Effort** ~0.5d · **Risk** low (additive field).

---

## C — GR & Registration numbers are consistent and school-shaped  ·  **P2**  ·  (#4)
**Why it matters (school lens).** The **GR (General Register) number is the child's permanent identity** in a
Pakistani school — it's on the register, the leaving certificate, every fee receipt. Two formats in one
school (`GR-0001` for old students, `GR 3`/`3` for new ones) is a real records problem: staff can't search
reliably, and it looks unprofessional on documents.
**Root cause.** The seed inserted `grNumber`/`registrationNo` as **hardcoded strings** (`GR-0001`,
`REG-2026-001`) bypassing the app's counter, so live admissions issued from the counter produce a different
shape (bare `3`).
- **Fix (decide the canonical format first, then align both sides).**
  1. **Confirm the app's live format** (read `students.service` GR/Reg generation) — is it `GR-####`,
     `<year>-####`, or a bare number? Decide the canonical school format (recommend zero-padded with a prefix,
     e.g. `GR-0031`, and `REG-<year>-####`, matching what offices already write by hand).
  2. **BE:** make the generator emit that exact format (zero-pad, prefix, per-school counter). Ensure
     `School.nextGrNumber` / `nextRegNo` counters exist and advance atomically (same class as the
     receipt-counter fix — race-safe).
  3. **Seed:** generate seed GR/Reg via the **same** helper (not hardcoded), so seeded and live students are
     identical in shape and the counter starts above the seeded max.
- **Regression.** integration: admit N students → GR/Reg match the canonical regex and are contiguous;
  a re-seed + a live admit share the format and never collide.
- **Effort** ~0.5–1d · **Risk** med (format is data — settle it once; a migration may be needed if existing
  tenants must be normalised, but for demo a re-seed suffices).

---

## D — Dashboard tiles are correct for every role  ·  **P3**  ·  (#5, #8)
**#5 — Campus-admin "Collections" tile renders blank** where the owner sees `Rs 86,500`. Root cause:
the collections figure is likely owner-only or not passed to the campus-admin dashboard branch. **Fix:** show
the campus-scoped collections total for the campus admin (they run the campus's money day to day and should
see it), or, if intentionally hidden, remove the empty tile rather than showing a blank. Confirm intent
first. **Effort** ~0.25d.
**#8 — Staff "Joined this year: 0"** though 9 joined 2026-04-01. Root cause: the "this year" window (calendar
vs academic year) or the `joinedAt` comparison. **Fix:** align the window with the **academic year** (a
Pakistani school thinks in sessions, Apr–Mar), matching how the rest of the app scopes "this year". Confirm
the metric's intent, then fix the boundary. **Effort** ~0.25d.
- **Regression.** integration: seed staff with known `joinedAt` → the counter matches the chosen window;
  campus-admin dashboard returns a collections figure.

---

## E — Badge spacing (verify first — likely a non-issue)  ·  **P3**  ·  (#2)
**Status: needs visual confirmation.** The run-together text ("B**class teacher**", "Butt**primary**") came
from `get_page_text`, which drops inter-element whitespace — it is **not proof of a visual bug**. The
my-classes badges already carry `marginLeft` (`my-classes/page.tsx:52–53`), so they render spaced. Some
badges (e.g. the student-portal guardian "primary") may lack an explicit margin.
- **Fix (only if a screenshot shows real crowding).** Add a small left margin to the **base `.badge` CSS
  class** (school-ui design tokens) so every badge is spaced regardless of per-use inline styles — one change,
  systemic, removes the reliance on remembering `marginLeft` at each call site.
- **Effort** ~0.25d if needed · **Risk** minimal (cosmetic token).

---

## F — Demo data reflects the latest fixes (operational, not a code bug)  ·  (#6)
**#6 — SMS broadcast reaches "0 families"** because the demo was seeded **2026-09-23**, before the WS-D
verified-phone fix and this session's HR-campus fix. **Action:** re-seed the demo
(`pnpm db:seed-real -- --commit`) so it picks up (a) verified guardian phones (broadcast reaches real
recipients), (b) HR bound to a campus, and (c) — once C ships — the canonical GR/Reg format. Re-generate
`SEED-CREDENTIALS.md`. No code change; a release/ops step after B–E merge.

---

## Sequencing & acceptance
| Order | Item | Ships | Gate |
|-------|------|-------|------|
| 1 | **A #1b** — assign/repair user campus in UI (P1) | orphaned users fixable by the office | users-list-includes-orphan + assign integration |
| 2 | **B** — real name in `Me` + greetings (P2) | staff greeted by name | `/auth/me` name integration |
| 3 | **C** — canonical GR/Reg format + shared generator (P2) | one identity format school-wide | GR-format + contiguity integration |
| 4 | **D** — campus-admin collections + joined-this-year window (P3) | correct tiles per role | dashboard metric integration |
| 5 | **E** — badge spacing (verify, fix base class only if real) (P3) | consistent chips | visual check |
| 6 | **F** — re-seed the demo (ops) | demo shows all fixes | manual: broadcast > 0, HR ok, GR consistent |

**Definition of done.** Every finding closed by a root-cause fix with a merge-blocking test where it's
code; #2/#6 confirmed by a screenshot / a re-seeded demo. `pnpm verify` + integration + isolation green.
Re-run the live portal pass for the four staff roles and confirm each greeting, tile, and the HR/user-admin
flow. **Effort:** ~2.5–3 developer-days. **Risk posture:** A and C are load-bearing (user admin + the child's
permanent identity); B/D/E are low-risk; F is an ops step.

## Non-actions (by design, documented)
- Owner-door refusing a non-owner, HR "Not authorized" on /exams, campus-admin lacking Fees-collect/Payroll —
  all correct RBAC, confirmed live. No change.
