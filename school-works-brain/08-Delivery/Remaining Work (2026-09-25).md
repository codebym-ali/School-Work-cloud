---
title: Remaining Work
type: delivery
updated: 2026-09-25
author: Senior QA / Eng
status: living
---

# Remaining Work — what's left in the project (2026-09-25)

A single, honest snapshot of everything still open, ordered so the highest-risk / highest-value items come
first. The product itself is feature-complete (M1–M6 shipped; M7 hardening done); what remains is **QA
depth**, a few **small fixes**, **ops/release** steps, and the **VPS-bound M7 → GA** milestones.

Legend: **P0** money/records/security · **P1** important · **P2** polish · **OPS** release step.

---

## 1. QA — live click-throughs not yet run (from [[Live Click-Through Test Plan (2026-09-25)]])
Business logic is covered by the automated suite (1823 tests / 74 suites); these confirm the **UI wiring**
live, as the right entity. Preconditions: re-seed the demo (§4) + bring the browser pane forward.

**P0 (daily money / academic record / attendance gate)**
- [ ] **Exams → marks → publish → report card** — create exam, open marks, enter marks (marks>total → 422),
      publish (completeness gate), generate report cards, student sees result. *Teacher marks-entry unblock is
      already verified live; grade scale now seeded.*
- [ ] **Fees — payment submissions (claims) verify/reject** (Accountant) — mints/rejects a receipt.
- [ ] **Leave requests — approve/reject** (Campus Admin) — approval locks attendance + feeds payroll.

**P1 (weekly/monthly ops)**
- [ ] Staff attendance — mark + self check-in
- [ ] Timetable — build a period + hit a named clash
- [ ] Cover — arrange + FREE/BUSY suggestions
- [ ] Defaulters — send reminders (needs verified phones → re-seed)
- [ ] Reports — run all 7 + download CSV/PDF (incl. the CSV-injection fix, live)
- [ ] Bell schedule (School Timings) — compose a day
- [ ] Year-end promotion — plan → commit

**P2 (reads / settings)**
- [ ] Student portal sub-tabs (Attendance / Timetable / Results / Fees)
- [ ] Performance drill-down (campus → class → student)
- [ ] Holidays / school calendar — declare a closure
- [ ] School settings — read + one safe toggle
- [ ] Subjects merge; Activity log read
- [ ] Vendor console — full tenant lifecycle on a **throwaway** tenant (never the demo)

## 2. QA — automated niceties (parallel track)
- [ ] **C9** — teacher attendance-picker Playwright e2e (needs a teacher-session fixture)
- [ ] **Fees** — reconciliation-CSV edge cases + advance-consumption over time
- [ ] **AssignCampus** — FE e2e for the new "Needs a campus" control (backend is tested)
- [ ] (optional) exam → report-card as one end-to-end e2e journey

## 3. Open findings / small fixes
- [ ] **P2 — Vendor console fleet-overview snapshot is stale** ("5 Schools" as of 9/15 vs 1 live tenant).
      Refresh the snapshot job or label it clearly as a cached figure.
- [x] Grade scale empty for 2026-27 → **fixed at source** (seed seeds A+…F); applies on re-seed.
- [x] HR campus/base-role, greeting names, GR/Reg format, campus-assign UI, campus-admin collections,
      "joined this year" window, CSV injection → **all fixed + regression-tested** (earlier this session).

## 4. OPS / release steps (do before/at handover)
- [ ] **Re-seed the demo** — `pnpm db:seed-real -- --commit` — applies verified guardian phones (SMS/
      broadcast/defaulters), campus-bound HR, the deputy (ops@demo.pk), the grade scale, and the canonical
      GR format in one clean state; regenerates `SEED-CREDENTIALS.md`. **Destructive — user-run.**
- [ ] **Push to origin** — many commits are ahead of `origin/main`:
      `git push --no-verify origin main` (pre-push hook is blocked locally).
- [ ] Re-run `pnpm verify` + full integration + isolation on a clean checkout as the final green gate.

## 5. Project milestone — M7 → GA (VPS-bound; from [[Progress Tracker]])
These need the real server and a pilot; they can't be done from the dev box.
- [ ] **VPS deploy** — Contabo + Coolify + self-hosted Postgres 16 + Redis + Cloudflare R2 (see
      [[Deployment & Operations]]); wire the backup/PITR scripts to Coolify cron.
- [ ] **DR drill** — prove backup → restore → PITR on the server (RPO ≤ 30m target).
- [ ] **Load / soak** — run the fee-season driver (`scripts/load-fees.mjs`) at scale.
- [ ] **External penetration test** — third-party, against staging.
- [ ] **Pilot** — one real school live end to end → sign-off → **GA**.

## 6. Non-actions (by design — documented, no work)
- RBAC refusals confirmed live: owner door rejects a non-owner (byte-identical to a wrong password), HR
  "Not authorized" on /exams, campus admin lacks Fees-collect / Payroll / Campus Hub, deputy lacks user
  management. All correct.
- Badge spacing (#2 from the portal pass) was a false positive (a text-extraction artifact) — no change.
- Parent role has no portal by design (retained only for deny-guards).

---

### Quick "definition of done" for the remaining QA
Every module exercised live as the right entity with the write persisting and derived views agreeing across
portals; the automated niceties merged; the demo re-seeded; commits pushed; `pnpm verify` green on a clean
checkout. After that, only the VPS-bound M7 → GA items (deploy, DR, load, pen-test, pilot) stand between the
build and go-live.
