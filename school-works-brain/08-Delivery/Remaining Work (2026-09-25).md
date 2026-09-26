---
title: Remaining Work
type: delivery
updated: 2026-09-26
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
> The **P0 backend flows below were verified end-to-end against the live demo on 2026-09-26** (API-driven —
> see §7). What remains for these three is the lighter **UI** click-through, not the logic.

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
- [x] **P2 — Vendor console "5 Schools" snapshot** — **resolved at the data layer** (cross-verified 2026-09-26).
      `platform_stats` is an append-only time-series snapshot table; its **latest row now reads `schools_total=1`**
      (the old "5 schools" rows are August/September history the job never prunes, by design). Only remaining
      check is a **P2 display** one: confirm the console reads `ORDER BY captured_at DESC LIMIT 1` (one-line query
      fix if it doesn't) — not the data problem originally described.
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
- **Owner login is door-scoped, not broken.** Two endpoints: `POST /auth/login` (door=`staff`) and
  `POST /auth/owner-login` (door=`owner`). After the password check, `doorAllows(door, roles)`
  (`auth.service.ts:146`) rejects an owner at the staff door with a response **byte-identical to a wrong
  password** (anti-enumeration; logged as `LOGIN_WRONG_DOOR`). `owner@demo.pk`/`Owner!Secret12` at
  `/auth/owner-login` (owner-web :3005) returns 200. A staff-door 401 for the owner is the feature working —
  **do not "fix" it.**
- Badge spacing (#2 from the portal pass) was a false positive (a text-extraction artifact) — no change.
- Parent role has no portal by design (retained only for deny-guards).

## 7. Cross-verification vs the live project (2026-09-26)
Live, API-driven verification against the running demo tenant (real login + MFA enrolment, real writes, DB
inspected). This exercises the **backend flow end-to-end**; a UI click-through (§1) is still the lighter,
remaining confirmation on top of this.

**P0 flows — verified working end-to-end (business logic + gates):**
- [x] **Exams → marks → publish → report card** — create → open → `marks>total` 422 → publish blocked
      `RESULTS_INCOMPLETE` until every student×subject marked (class-wide) → `PUBLISHED` → 10 report cards with
      computed %, grade from the seeded scale, section rank. `WEIGHTAGE_SUM_INVALID` gate (class weightages must
      total 100) also confirmed.
- [x] **Fee claim → verify/reject** (Accountant, MFA-enrolled) — submit → **verify minted a receipt** → reject.
      Payment-method gate confirmed (demo is CASH-only; a BANK_TRANSFER claim is correctly refused at verify).
- [x] **Leave → approve/reject** (Teacher files, Campus Admin decides) — approve/reject both persist; the
      overlap-conflict gate (409) fires.

**P1 / P2 — verified via API:**
- [x] All **7 reports** return 200 (daily-collection, fee-ledger, attendance-register, class-strength,
      defaulters, exam-summary, sms-usage); **CSV export** returns `text/csv`. Defaulters list + Activity/audit
      log read OK.
- [x] **Student portal** — login by Reg-No + CNIC, and overview / attendance / results / fees sub-tabs all 200.
- [ ] **Staff self check-in** returns 403 *"Self check-in is switched off for this school"* — a **school
      setting**, not a bug. Enable the toggle to demo the flow.
- [x] §3 "done" claims confirmed in the DB: grade scale A+…F seeded for 2026-27; GR/Reg format (`GR-`,
      `REG-2026-`, AUTO).

**P0 — SECURITY (from `audit-reports/2026-07-21-security-audit.md`) — ✅ IMPLEMENTED 2026-09-26:**
Were pre-deploy blockers, untracked here because `audit-reports/` was never reconciled into the brain.
Both fixed, tested (215 unit + 4 integration), typecheck + lint clean, API boots healthy.
- [x] **`trust proxy` configured** — `TRUST_PROXY` env (default `uniquelocal`) + `parseTrustProxy()`
      (`env.schema.ts`), applied via `app.set('trust proxy', …)` in `apps/api/src/main.ts` before routing, so
      `req.ip`/`req.protocol` are correct where the §29 limiter (`rate-limit.guard.ts:94`) and §31 audit trail
      (`tenant-resolution.middleware.ts:45`) read them. **Not hardcoded `1`** — `uniquelocal` trusts XFF only
      from the private docker-internal proxy and ignores a forged header from a public client; CIDR list
      supported for a Cloudflare-proxied future. Runtime XFF spoof-rejection + per-client bucketing proven by
      `test/integration/trust-proxy.e2e-spec.ts`.
- [x] **`COOKIE_SECURE` production guard** — `env.schema.ts` `superRefine` now refuses to boot when
      `NODE_ENV=production && !COOKIE_SECURE` (and likewise if `TRUST_PROXY` is disabled), mirroring the
      `RATE_LIMIT_ENABLED` guard. Stops a dev `.env` copied to a server from silently shipping session cookies
      without `Secure`. **Hard dependency (audit 2.2): TLS must terminate at the edge** (Caddy on-demand /
      Traefik `:443` + certresolver) — a Secure cookie cannot travel over plain http.

## 8. Additional hardening implemented (2026-09-26)
Senior-team remediation batch — the safely-fixable items from the prioritized issue list. All verified
(typecheck + lint + 215 unit tests green; live-checked where noted).
- [x] **TLS at the edge (audit 2.2)** — `docker-compose.prod.yml` Traefik now has a `websecure :443`
      entrypoint, a Let's Encrypt certresolver (`le`), and a permanent `:80→:443` redirect, so nothing is
      served in cleartext and `COOKIE_SECURE=true` works. `ACME_EMAIL` added to `.env.example`; `docker compose
      config` validates. Tenant-fleet wildcard needs DNS-01 (documented inline; Coolify's Traefik or
      `deploy/Caddyfile` on-demand TLS are the alternatives).
- [x] **CSRF constant-time compare (audit 4.1)** — `csrf.guard.ts` now hashes both tokens and uses
      `crypto.timingSafeEqual` instead of `!==`. Live-verified: matching → passes, wrong/missing → 403.
- [x] **PII log-redaction drift (audit 3.3)** — `logger.config.ts` refactored to a `SENSITIVE_BODY_KEYS`
      list redacted at the body root **and** one nesting level (catches `guardian.cnic` etc.); added CSRF
      header, MFA `code`/`otp`/`totp`/`token`, `bForm`, extra phone/financial keys. Drift-resistant.
- [x] **Owner greeting (P2)** — dashboard subtitle falls back to the role label ("School Admin") instead of
      the raw email when the owner has no staff profile. Live-verified on owner-web.
- [x] **Node pin (P1)** — `.nvmrc` = 22 (dev box was on v26; CI/prod use 22). Aligns local with CI.
- [x] **Vendor snapshot query (P1)** — verified already correct: `platform.service.ts:166` reads
      `findFirst({ orderBy: { capturedAt: 'desc' } })`. Stale figure was data freshness (nightly job), self-heals.

### Phase 0/1 implemented (2026-09-26)
- [x] **Merge + push** — security/hardening branch fast-forwarded into `main` and pushed to origin.
- [x] **Audit 3.2 — transitive CVEs** — `pnpm audit` cut **68 → 33**: `next` 14.2.15→^14.2.34 (all 5 apps),
      `nodemailer`→^9.1.0, `pnpm.overrides` for `multer` (dead transitive — presigned uploads, no
      FileInterceptor), `lodash`, `js-yaml`→^4.3.1, `postcss`, `browserslist`. All 5 Next apps build green;
      `pnpm verify` green. **Residual is the Next 14→15 major** (deferred): the remaining critical is a
      *Windows-host-only* RCE — **prod is Linux, not affected**; the RSC-DoS high also needs Next 15.
- [x] **Audit 3.1 — per-tenant encryption keys** — `FieldEncryption` now derives a per-scope key via
      **HKDF-SHA256(masterKey, salt=scopeId)** and writes a **v2** wire; v1 (master-key) still decrypts so a
      migration runs without downtime. `scopeId` = schoolId for tenant data (student CNIC), operator id for
      platform_users (no tenant). Callers updated (auth, platform-auth, students, guardians). Re-encryption
      migration `scripts/reencrypt-fields-v2.ts` (`pnpm db:reencrypt`, dry-run by default). Proven: 7 unit
      (round-trip, cross-scope isolation, v1 back-comp) + **4 MFA integration suites / 30 tests on real PG**.

### Still open (execution / VPS-bound)
- **QA breadth** — the un-exercised P1/P2 flows (§1) and the §2 automated niceties.
- **Next 14 → 15** major upgrade (its own initiative; residual CVEs, prod not currently exposed).
- **M7 → GA (VPS-bound)** — deploy, DR drill, load/soak, external pen-test, pilot (§5).

---

### Quick "definition of done" for the remaining QA
Every module exercised live as the right entity with the write persisting and derived views agreeing across
portals; the automated niceties merged; the demo re-seeded; commits pushed; `pnpm verify` green on a clean
checkout. After that, only the VPS-bound M7 → GA items (deploy, DR, load, pen-test, pilot) stand between the
build and go-live.
