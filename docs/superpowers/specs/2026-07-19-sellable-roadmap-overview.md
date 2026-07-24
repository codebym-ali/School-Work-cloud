# Sellable Roadmap — "Body over Engine" Release Plan

> **Status:** Approved sequencing (2026-07-19). Owner: project lead. Audience: implementing colleague.
> **Context:** Backend (multi-tenancy, RLS, fee engine, payroll, exams, comms) is enterprise-grade
> and largely complete. The gap is **buyer-facing surface** — the screens and channels a school
> owner, parent, and teacher actually see. This roadmap sequences the buyer-facing work so the
> product becomes demoable and sellable to Pakistani private schools on a per-student monthly model.

## Why this order

Sequenced by **dependency + sales impact**, not by build size. The first three features together
form the demo that wins a pilot (parent engagement + fee recovery); 4–5 round out daily usage.

| # | Feature | Rationale for position | Size | Release |
|---|---------|------------------------|------|---------|
| 1 | **Parent portal** | Foundation: parent identity (1 parent → N children), phone+OTP login, child-switcher. Everything parent-facing depends on it. Reuses the student `/me` portal pattern. | Medium | **R1** |
| 2 | **WhatsApp integration** | The "wow" channel. Fee reminder + absence alert on WhatsApp. Plugs into the existing `sms-gateway.ts` channel abstraction and comms pipeline. Pairs with #1. | Medium | **R1** |
| 3 | **Fee challan printing (bank-style)** | Small build, big demo impact. The challan PDF generator is shared by front-desk (bulk print) **and** the parent portal (single download from #1). | Small | **R1** |
| 4 | **Admin screens + SMS/comms center** | Frontend over ready backend (SMS center, leave-approval queue, users & roles, audit browser). Also closes the security gaps the audit found (unguarded SMS endpoints, over-permissioned leave create). | Small–Medium | **R2** |
| 5 | **Homework/Diary + Timetable** | Largest new build (new Homework model; `TimetableSlot` exists but needs API+UI). Lights up the parent portal's "diary" tab (which #1 ships dormant). Drives teacher daily adoption. | Large | **R2** |
| — | Transport | Deferred to v2. Show on the roadmap slide; do not build yet. | — | v2 |

**Release 1 (sales demo):** #1 + #2 + #3 → run a free pilot in 2–3 friendly schools; the pilot's
defaulter-recovery + parent-engagement data becomes the sales pitch.
**Release 2:** #4 + #5.

## Cross-cutting facts (true for every spec)

- **Stack:** NestJS 10 (`apps/api`), BullMQ worker (`apps/worker`), Prisma + Postgres 16 (RLS),
  Next.js (`apps/web`). API prefix `/api/v1`. Ports: API 4000, web 3001, PG 5433, Redis 6381.
- **Tenancy is non-negotiable:** every tenant table carries `school_id`; 3-layer isolation
  (Prisma extension asserts `schoolId` on create + RLS FORCE + isolation suite). Services pass
  `schoolId` explicitly. Avoid Prisma `upsert` on tenant models (use find-then-write).
- **§22.8 ownership checks go in the service, not a guard** (guards run before the `withTenant` tx,
  so RLS returns 0 rows). Every parent/child scoping check follows this rule.
- **Money is `Decimal(12,2)`**; receipt/challan numbers are gap-free (reuse the fees module discipline).
- **Reusable building blocks already in the repo:**
  - `libs/common/src/pdf/pdf.service.ts` — PDF rendering (has `reportCard`; extend for challan/homework).
  - `libs/common/src/storage/storage.service.ts` — R2/S3 `putObject` + presigned URLs.
  - `apps/api/src/modules/comms/sms/sms-gateway.ts` — channel abstraction (WhatsApp plugs here).
  - `apps/api/src/modules/comms/sms/sms-producer.service.ts` + `sms-queue.provider.ts` — BullMQ dispatch.
  - `apps/api/src/modules/portal/student-portal.service.ts` — the self-scoped portal pattern to copy.
- **Brain rule:** every feature updates `school-works-brain/` (Progress Tracker + area note +
  Key Decisions) in the same PR. Specs live here in `docs/superpowers/specs/` (frozen design),
  progress is tracked in the brain — never in `docs/`.

## Known security fixes to fold in (from the 2026-07-19 audit)

These are **bugs**, not features — fix them as the relevant screens are built so they get test coverage:

1. **SMS endpoints unguarded** — `apps/api/src/modules/comms/comms.controller.ts` `GET /sms/templates`,
   `/sms/credits`, `/sms/logs` have no `@Roles`. Any authenticated user (incl. PARENT/STUDENT) can read
   SMS logs + credit balances. Fix in **#4** (SMS center) and add matrix-conformance rows.
2. **Student-leave create over-permissioned** — `apps/api/src/modules/leaves/leaves.controller.ts` lets
   OWNER_ADMIN/CAMPUS_ADMIN `POST /student-leaves`; blueprint restricts create to TEACHER (own section) /
   PARENT (own child). Fix in **#1** (parent leave path is out of v1 scope, but tighten the guard) and **#4**.
3. **Teacher can file leave for any student** — no section-ownership check, no `source` field
   (`leaves.service.ts`). Tighten when the leave-approval queue lands in **#4**.

## Spec index

| Feature | Spec file |
|---|---|
| #1 Parent portal | `2026-07-19-parent-portal-design.md` |
| #2 WhatsApp integration | `2026-07-19-whatsapp-integration-design.md` |
| #3 Fee challan printing | `2026-07-19-fee-challan-printing-design.md` |
| #4 Admin screens + comms center | `2026-07-19-admin-screens-comms-center-design.md` |
| #5 Homework/Diary + Timetable | `2026-07-19-homework-diary-timetable-design.md` |

Each spec is self-contained and follows the same shape: Business Analysis → Users → Permissions →
Data Model → API → UI → Edge Cases → Testing → Scalability → Open Decisions. Where a spec makes a
design choice the product owner has not explicitly confirmed, it is flagged in **Open Decisions** at
the top of that file rather than assumed silently.
