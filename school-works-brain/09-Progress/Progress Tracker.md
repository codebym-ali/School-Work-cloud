---
title: Progress Tracker
type: status
updated: 2026-07-06
current_milestone: M3 complete → M4 next
overall: 3 of 7 milestones (GA)
---

# 📊 Progress Tracker

> [!info] Living document — update at the **end of every phase**.
> Procedure at the bottom. Related: [[Roadmap & Milestones]] · [[Testing & Quality]].

**Last updated:** 2026-07-06 · **Stack:** Contabo VPS + Coolify + self-hosted Postgres 16 + Redis + Cloudflare R2 (see [[Deployment & Operations]]) · **Repo:** NestJS monorepo (`apps/api`, `apps/worker`, `libs/common`, `libs/database`).

## Milestone status

| Milestone | Status | Gate | Shipped |
|---|---|---|---|
| **M1 — Foundations** (tenancy, auth, CI) | ✅ Done | Tenant-isolation suite green before any feature | 2026-07-04 |
| **M2 — Students & Admissions** | ✅ Done | Admit journey E2E green | 2026-07-04 |
| **M3 — Attendance, Leaves & SMS core** | ✅ Done | Mark attendance E2E + absence SMS verified | 2026-07-06 |
| **M4 — Fees end-to-end** | ⏳ Next | Collect-fee E2E + `fee-integrity-check` clean | — |
| **M5 — Exams & Report Cards** | ⬜ Planned | Enter/publish marks + parent views report card | — |
| **M6 — HR, Payroll, Docs, Reports** | ⬜ Planned | Promotion E2E + all 7 reports export | — |
| **M7 — Hardening & Pilot → GA** | ⬜ Planned | Load + pen test + DR drill + pilot live | — |

**Quality gates (always green):** ✅ tenant-isolation suite · ✅ RLS-coverage check · ✅ lint + strict typecheck · ✅ api + worker builds.
**Test count:** **39 passing** across 7 suites (unit + integration/e2e + isolation).

---

## ✅ M1 — Foundations (Done)
Blueprint §16–§22, §34. See [[Multi-Tenancy & Isolation]], [[Security & Compliance]].
- [x] NestJS monorepo (api + worker + libs), webpack bundling, path aliases, docker-compose (pg/redis/minio/clamav)
- [x] Full Prisma schema (48 models, §17) + SQL companions: RLS policies (FORCE, fail-closed), partial uniques, CHECKs, trigram, grants; two DB roles (`app_user` no-BYPASSRLS, `platform_admin` BYPASSRLS)
- [x] 3-layer tenant isolation: Prisma client extension + `withTenant` tx wrapper + RLS + **merge-blocking isolation suite**
- [x] Auth (§22): argon2id + HIBP, JWT httpOnly/SameSite cookies + `kid` rotation, single-use refresh rotation w/ family-reuse detection, lockout, TOTP MFA, CSRF, AES-256-GCM field encryption, Redis access denylist
- [x] Tenant resolution middleware, guards (Jwt/TenantScope/Roles/Csrf), §25.1 error envelope, Zod env + SchoolSettings validation
- [x] CI pipeline (`.github/workflows/ci.yml`) in §34 order
- **Tests:** 7 isolation + 6 auth e2e green.
- **Hardening beyond blueprint:** RLS policy uses `NULLIF(current_setting(...),'')::uuid` to fail closed on a reset pooled connection.

## ✅ M2 — Students & Admissions (Done)
Blueprint §7–§8. See [[Enrollment & Admissions]].
- [x] Setup: academic years (+set-current), campuses, classes, sections, subjects
- [x] Platform provisioning (`ProvisioningService`) + dev seed (`pnpm db:seed` → tenant `demo`)
- [x] Students directory (name/GR/guardian-phone search), CRUD + soft delete, guardians (one-primary invariant), phone-normalized parent **link-or-create** (no silent merge)
- [x] Admissions: inquiry state machine, entry tests, **transactional admit** (guardian + GR + student + primary link + enrollment + admission, atomic), age-band eligibility, audit
- [x] Enrollment: list + **transfer** (close-old/open-new)
- **Tests:** admit-journey e2e + inquiry state-machine unit green.

## ✅ M3 — Attendance, Leaves & SMS core (Done)
Blueprint §9, §10, §14, §26–§27. See [[Attendance & Leaves]], [[HR, Payroll, Comms & Documents]].
- [x] SMS/comms core: pluggable gateway adapter (`console`; Telenor/Jazz later), GSM-7/UCS-2 segment calc, template render, **credit ledger + overdraft for critical sends**, SmsLog, templates CRUD, manual send, **HMAC delivery webhook**, retry
- [x] **BullMQ `sms` queue** (producer in api) + `SmsProcessor` Worker in the worker deployable (runs each job in tenant context + `withTenant`)
- [x] Attendance (§9): bulk mark with future/holiday/weekly-off validation, edit-lock window, cross-teacher conflict, **partial-failure contract**, absence-SMS enqueue; admin post-window edit; staff attendance
- [x] Leaves (§10): student + staff state machine, overlap guard, staff quota → auto-UNPAID, **ON_LEAVE written + locked on approve**
- [x] Provisioning seeds default SMS templates + BASIC 1000-credit grant
- **Tests:** attendance e2e (w/ live SMS dispatch) + leaves e2e + segment/render unit green. Worker boots clean.
- **Findings:** §22.8 ownership checks that read tenant data run as **service-level checks, not guards** (guards run before the withTenant tx → RLS returns 0 rows). BullMQ uses parsed-URL connection options to dodge a dup-ioredis-version type clash.

---

## ⏳ M4 — Fees end-to-end (Next)
Blueprint §12. See [[Fees & Payments]]. Gate: collect-fee E2E + nightly `fee-integrity-check` clean.
- [ ] Fee heads / structures / late-fee policy
- [ ] Idempotent invoice batches (`[schoolId, classId, month, year]`)
- [ ] Discounts (sibling, stacking) + fines (`mark-overdue` job)
- [ ] Payments: `Idempotency-Key`, `SELECT … FOR UPDATE`, gap-free receipts, partial/paid status
- [ ] Advances/credits, reversals (OWNER_ADMIN), waivers, defaulters
- [ ] Receipt SMS, reconciliation (CSV), `fee-integrity-check` nightly job

## ⬜ M5 — Exams & Report Cards
Blueprint §11. See [[Exams & Report Cards]].

## ⬜ M6 — HR, Payroll, Documents, Reports
Blueprint §13, §15, §28. See [[HR, Payroll, Comms & Documents]]. Includes promotion workflow (§7).

## ⬜ M7 — Hardening & Pilot → GA
Load (k6), pen test, DR drill, pilot onboarding via feature flags.

---

## 🧾 Cross-cutting backlog (not milestone-blocking)
- [ ] **M1 remainder:** nightly `pg_dump` + WAL → R2 backups + weekly restore-test *(do before real fee data)*
- [ ] Students CSV import (needs upload pipeline §22.6) — deferred from M2
- [ ] Phone OTP verification flow (§14) — deferred from M3
- [ ] Swagger/OpenAPI explorer + generated typed client
- [ ] Frontend (Next.js) — not started; UI/UX in [[05-ui-ux-specification]]
- [ ] Vendor console (PLATFORM_ADMIN) HTTP surface + auth
- [ ] Rate limiting (Redis sliding window, §29), observability (Sentry + Coolify logs)

---

## 🔁 How to update this file (every phase)
1. Move the milestone row to ✅ with the ship date; set the next one to ⏳.
2. Fill its checklist, list the tests that went green, and note any findings/deviations.
3. Update the header (`updated`, `current_milestone`, test count) and the top gates line.
4. Update any brain note whose **Implementation status** changed, and [[Roadmap & Milestones]] if sequencing shifted.
5. Commit with the phase (the repo history + this file must agree).
