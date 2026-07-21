# Architecture Audit — School Management SaaS

**Date:** 2026-07-21
**Scope:** whole-repo structural review — module design, data model, API design, background processing, testing/CI, deployment, and frontend.
**Method:** direct inspection of the implementation (not the blueprint/aspirational docs alone) — every claim below is checked against actual code, actual test runs, or an actual command's output.
**Scale at time of audit:** 173 non-test TypeScript source files (~12,800 LOC), 52 Prisma models, 11 migrations, 18 unit spec files, 22 integration/e2e specs (Jest), 10 Playwright specs.

**Rating scale:** each area gets a 1–10 score with the reasoning that produced it — not a vibe number.

---

## 1. Executive summary

| Area | Score | One-line verdict |
|---|---:|---|
| Multi-tenancy & isolation | **9.5/10** | Three independent, fail-closed layers — the standout of the system |
| Data model | **9/10** | Correctly normalized, composite-FK tenant chains, deliberate JSON-tiering for long-tail fields |
| Module boundaries | **7/10** | `libs → feature` is lint-enforced; `feature ↔ feature` is explicitly **not** — a real, documented gap |
| API design | **8.5/10** | Consistent error envelope, idempotency, DTO whitelisting; OpenAPI-generated client still missing |
| Background processing | **8.5/10** | Correctly separated worker deployable; BullMQ used appropriately for genuinely async work |
| Testing & CI | **9/10** | Merge-blocking isolation + matrix-conformance suites are rare discipline; web CI gate now closed |
| Deployment & ops | **8/10** | Real backup/PITR + health probes; TLS-termination gap is the one real hole (see security report) |
| Frontend architecture | **6/10** | Functional, consistently patterned, but thinnest layer — no data-fetching library, growing duplication |
| Scalability posture | **8/10** | Correctly sized for the stated 200–3,000-student market; connection pooling is the first real ceiling |
| **Overall** | **8.3/10** | A backend that would pass review at a series-A SaaS company; frontend needs a consolidation pass |

---

## 2. Multi-tenancy & isolation — 9.5/10

Three layers, each independently capable of catching what the others miss:

1. **Application layer** — a Prisma client extension ([`tenant.extension.ts`](../libs/database/src/tenant.extension.ts)) that reads `schoolId` from CLS (continuation-local storage) and injects/merges it into every query. Missing tenant context → **throws**, fail-closed, not fail-open.
2. **Database layer** — Postgres RLS with `ENABLE` **and** `FORCE` on every `school_id` table, applied by a generated loop ([`05_rls.sql`](../prisma/sql/05_rls.sql)) so a *new* tenant table is protected the moment it's created — no per-migration manual step to forget. `app_user` (the request-path role) has no `BYPASSRLS`.
3. **CI layer** — a merge-blocking `test:isolation` suite plus an automated RLS-coverage checker (`scripts/check-rls-coverage.mjs`) that fails the build if any `school_id` table lacks the policy.

**What makes this a 9.5 and not a 10:** the RLS session variable is set via `NULLIF(current_setting(...), '')::uuid` specifically to handle a pooled-connection edge case (a reset GUC returns empty string, not NULL, and `''::uuid` would otherwise raise `22P02` instead of matching zero rows) — this is *exactly the kind of defect class* connection pooling introduces, and it's been handled correctly, but it means the isolation guarantee has a documented dependency on this NULLIF wrapper never being accidentally removed in a refactor. Worth a dedicated regression test asserting the raw SQL text of the policy, not just its behavior.

**Verified, not assumed:** campus-level sub-tenancy (`restrictedCampusId`) is deliberately implemented in *services*, not guards — because guards run before the `withTenant` transaction opens, so they can't read the tenant row an ownership check needs. This is a subtle, correct architectural call, not an oversight (§22.8 in the code's own comments).

---

## 3. Data model — 9/10

- **Composite foreign keys** (`@@unique([id, schoolId])` + FKs on `(childFk, schoolId) → (id, schoolId)`) make a cross-tenant reference **structurally impossible** to construct, not just filtered out at query time. This is a stronger guarantee than RLS alone — RLS stops a cross-tenant *read*; composite FKs stop a cross-tenant *reference* from ever being written, even by code that (bug or not) bypassed the tenant extension.
- **Three distinct identifiers, correctly separated by lifecycle** (added this session, reviewed here for architectural soundness): `registrationNo` (admission-form reference, auto), `grNumber` (permanent student identity, auto), `rollNumber` (positional, manual, scoped to `(section, academicYear)`, changes on promotion). All three live on the model whose lifecycle they actually match — `registrationNo`/`grNumber` on `Student` (the person), `rollNumber` on `StudentEnrollment` (the year's placement). This is the right normalization call; a system that put roll number on `Student` would have to migrate/repair it every promotion cycle.
- **Gap-free sequence pattern, reused three times** (GR number, registration number, receipt number) — an atomic `{ increment: 1 }` on the tenant's own `School` row, executed **inside the same transaction as the row it numbers**, so a rollback of the insert rolls back the counter too. This is the correct way to implement a human-facing sequential ID without a separate sequence table or advisory lock, and its reuse across three features (rather than three separate implementations) is good internal consistency.
- **JSON-tiering for long-tail fields**: rather than 30+ nullable columns on a hot, frequently-queried table, both the teacher-application form and (per the current architecture plan) student admission push rarely-queried fields (medical, previous-school, skills) into a **validated nested JSON** (`@ValidateNested` + `@Type`), while queryable fields stay as real columns. This is a deliberate, correctly-reasoned trade-off — the cost (harder to report on JSON fields later) is accepted explicitly, with a stated promotion path ("promote a field to a column only when a real query need appears") rather than left implicit.
- **Soft deletes throughout** (`deletedAt`) rather than hard deletes — necessary in this domain since audit logs, invoices, and vacancies reference `User`/`Student` rows by FK with `RESTRICT`; a hard delete would simply fail against any table with history. The one places this was tested for real (bulk user removal, this session) correctly uses soft-delete + login-block rather than attempting a doomed hard delete.

**What holds it at 9, not 10:** 52 models is a large surface for one Prisma schema file; there's no visible ERD generation step in CI (no `prisma-erd-generator` or equivalent), so the data model's shape has to be read out of a 1,200+ line file rather than a diagram — a real onboarding/review-friction cost as the model keeps growing.

---

## 4. Module boundaries — 7/10 (the least examined area historically, and it has a real gap)

`.eslintrc.js` wires the `boundaries` plugin with one enforced rule:
```js
rules: [{ from: ['common', 'database'], disallow: 'feature', message: '...' }]
```
This *only* forbids `libs → feature` imports (the correct, load-bearing direction to protect — shared libraries must never depend on a specific feature). But the config's own comment is candid about what's **not** enforced:
> "Feature<->feature is allowed (modules 'communicate through exported services', blueprint §16) — a barrel-enforced stricter rule is a future refinement."

**Concretely:** nothing today stops the `admissions` module from reaching directly into `fees`'s internal service class rather than going through a public export, or from importing a DTO type meant to be module-private. The blueprint's stated architecture ("modules communicate through exported services only ... ESLint boundary rules enforce import direction") is **half-true** — the direction *out* of libs is enforced; the direction *between* features is aspirational, resting on convention and code review rather than tooling.

At 17 feature modules (admissions, attendance, auth, comms, documents, enrollment, exams, fees, hr, leaves, platform, portal, reports, setup, students, uploads, users) this hasn't caused a visible problem yet — but it's exactly the kind of gap that erodes silently as a codebase grows past the point where one person can hold all the module boundaries in their head.

**This is not a hypothetical concern for this codebase specifically:** this session's own HR module work imported `StudentEnrollment`/`Class`/`Section` types across the `hr`, `students`, and `setup` modules' boundaries fairly freely (as intended — they're genuinely coupled domains), which is fine *if* it stays disciplined; it's the discipline that has no tooling backstop.

---

## 5. API design — 8.5/10

- **Uniform error envelope**: `{ error: { code, message, details, requestId } }` everywhere, verified directly this session (a validation failure on the new teacher-application endpoint returned exactly this shape with per-field `details`). `requestId` correlates to the Pino log line via CLS — a real, working correlation mechanism, not just a documented intent.
- **DTO validation is global and strict**: `whitelist: true, forbidNonWhitelisted: true, transform: true` ([`main.ts:33-38`](../apps/api/src/main.ts#L33-L38)) — unknown fields are rejected outright, which is both a security control (mass-assignment) and an API-design one (the schema is the actual contract, not "whatever the client happened to send").
- **Idempotency-Key handling is a genuinely well-engineered piece** ([`idempotency.service.ts`](../libs/database/src/idempotency.service.ts)): reserve-then-run via `INSERT ... ON CONFLICT DO NOTHING` specifically because a plain unique-constraint violation would poison the surrounding transaction under concurrency. This is the kind of correctness bug most systems ship and only discover under production load; here it's pre-empted in a comment that explains exactly why the naive approach fails.
- **Permission matrix as executable spec**: `test/matrix/permission-matrix.ts` is *data* that drives live HTTP requests against every route/role combination — a change to any `@Roles` decorator that diverges from the matrix fails CI. This is a stronger guarantee than a written permissions table in a doc, because a doc can drift from the code silently; this cannot (verified directly this session: adding a role required updating the matrix or the new role's positive-reachability assertion would fail).

**What holds it at 8.5, not higher:** no OpenAPI-generated client — `apps/web/lib/api.ts` is a **hand-written**, manually-kept-in-sync type/fetch layer. This is explicitly tracked in the project's own backlog ("kept hand-written types in `lib/api.ts` for now") rather than an oversight, but it's real ongoing cost: every new endpoint (this session added `/vacancies`, `/teacher-applications`, `/users/bulk-delete`, etc.) requires manually mirroring its shape on the frontend with no compiler check that the two sides agree.

---

## 6. Background processing — 8.5/10

- Correct separation: `apps/worker` is a **second deployable** sharing the codebase, not a background thread inside the API process — meaning API request latency is never affected by a slow SMS batch or a nightly maintenance job, and the worker can be scaled/restarted independently.
- BullMQ used for genuinely async work (SMS fan-out, invoice-batch generation, nightly maintenance) — appropriate choice, not overused for things that should be synchronous.
- Health-check design correctly treats the worker's dependencies (Redis, Postgres) as hard, with bounded-timeout checks (see §8) — a worker that can't reach Redis is correctly reported as down rather than hanging.

**Not deeply re-verified this session** (out of scope for this pass): idempotency/retry semantics of individual BullMQ job handlers, and whether job failures are alerted on distinctly from request-path errors. Flagged as a follow-up area, not a finding.

---

## 7. Testing & CI — 9/10

- **Test pyramid is real and enforced in the correct order**: `test:unit → test:integration → test:isolation` chained (not parallel) in both `package.json`'s aggregate `test` script and CI — deliberately fixed after a real bug was found (parallel integration+isolation runs contended over a shared BullMQ queue, causing duplicate SMS dispatch in tests). That's a team that hit a flaky-test root cause and fixed the *structure*, not just retried the test.
- **The permission matrix and the tenant-isolation suite are both merge-blocking** — the two test suites where a false "pass" would be most dangerous (an auth bypass, a cross-tenant leak) are exactly the two that cannot be skipped or soft-failed.
- **Verified working this session, not just claimed**: adding the `ADMISSION_CONTROLLER` and `HR_MANAGER` roles both required matrix updates; the conformance suite correctly asserted deny-by-default on every other route for the new role in each case, and a CSRF-handling bug in the matrix harness itself (DELETE rows weren't getting a CSRF token, causing a false-positive failure) was found and fixed as part of this session's work — the test infrastructure is actively maintained, not just initially built.
- **The web app's CI gate was closed this session**: previously, `apps/web` had no typecheck/lint/build step in `.github/workflows/ci.yml` — meaning a frontend-breaking change could merge green. A parallel `web` job (typecheck → lint → build) was added; this is now resolved and worth noting explicitly since an earlier pass in this same engagement flagged it as the single biggest testing gap.

**What holds it at 9, not 10:** no visible accessibility test gate (axe-core or equivalent) despite the frontend having enough forms/tables to benefit from one; no contract/schema-diff test between the hand-written `lib/api.ts` types and the actual DTOs (this would partially compensate for §5's OpenAPI-client gap).

---

## 8. Deployment & operations — 8/10

- **Health probes are correctly two-tier and genuinely well-built** ([`health.controller.ts`](../apps/api/src/health/health.controller.ts)): `/health/live` (process-up, never touches a dependency — for restart-on-crash) vs `/health/ready` (checks Postgres + Redis with a **2-second bounded timeout each**, since the shared ioredis client is configured with `maxRetriesPerRequest: null` and would otherwise hang the probe indefinitely against a down Redis). The code comment documents a **real prior bug** it fixes: an earlier version returned `200` with a `degraded` body, meaning the orchestrator's healthcheck never actually failed. S3 is deliberately *not* gated on readiness (a soft dependency — only uploads/PDFs need it), so an object-storage blip doesn't pull a healthy API node out of rotation. *(Correction to an earlier, less rigorous pass in this same engagement, which incorrectly claimed no health endpoint existed — it does, and it's better-engineered than a typical one.)*
- **Backup/PITR is real, not aspirational**: nightly logical `pg_dump` → R2, WAL archiving with a 5-minute `archive_timeout` (≤5-min RPO), a `pg_basebackup`-based base-backup script, and — critically — **restore has actually been rehearsed locally** (row-count comparison against the seeded DB across 8 tables including `fee_payments`), not just scripted and hoped to work.
- **One real, honestly-flagged gap**: `docker-compose.prod.yml` ships Traefik on `:80` only, with an explicit comment that TLS needs a `:443` entrypoint + certresolver added before real use. See the companion security report (§2.2) for the concrete impact — this sits at the intersection of "architecture completeness" and "security," and is listed there in full rather than duplicated here.
- **Structured logging + Sentry + Prometheus** are wired (`nestjs-pino` with request/tenant correlation, Sentry on unhandled 500s and exhausted jobs, a `/metrics` endpoint) — a real observability foundation, not just a `console.log` scattered codebase.

---

## 9. Frontend architecture — 6/10 (the system's weakest layer, and the gap is widening, not closing)

- **Consistent pattern, no framework**: every screen follows the same shape (raw `useState` + `fetch` via `lib/api.ts`, manual loading/empty/error handling) — predictable to read, but there is **no shared data-fetching/caching layer** (no SWR/React Query). Every screen re-implements its own load/reload logic; a cache-invalidation bug in one screen doesn't teach you anything transferable about another.
- **Duplication is visible and growing, not shrinking**: `ResetPw` exists as a copy-pasted component in at least two pages (Campus Hub, Admission Portal) rather than a shared component — a concrete, named instance of the exact kind of drift that accumulates as more screens are added (this session alone added four new full pages: Staff, Recruitment, Teachers, Admissions Team).
- **No shared UI kit**: inline styles (`style={{ ... }}`) are used pervasively rather than a small set of reusable primitives (Table/Form/Dialog/Toast) with a spacing/type scale defined once. Functional, but every new screen is built slightly differently rather than composed from parts.
- **Role-based nav/gating is centralized and correct** (`lib/roles.ts` + `(app)/layout.tsx`) — this *is* the one piece of frontend architecture that's genuinely well-factored: a single source of truth for what nav items and routes a role can reach, reused by every new feature this session (Teachers, Recruitment, Staff, Admission Portal all plugged into the same mechanism cleanly).

**Why this is scored lower than the backend rather than "different but fine"**: the backend's module-boundary discipline (§4) has at least a lint rule protecting half of it; the frontend has none. The cost compounds specifically *because* the system is actively growing (four new screens in one session) — each new screen is currently built by hand-copying the nearest existing pattern, which is exactly how `ResetPw` ended up duplicated.

---

## 10. Scalability posture — 8/10

For the stated target (200–3,000 students per school, 4-campus example, ~6,000 total) the architecture has **years of headroom on data volume** — attendance, the heaviest table, works out to roughly 1.2–2.4M rows/year even at the upper end, well within comfortable range for indexed Postgres range scans. The modular-monolith-plus-separate-worker choice is correctly sized for this scale; microservices here would be pure overhead.

**The first real ceiling is connection pooling, not data volume or code structure**: `DATABASE_URL` carries `connection_limit=25` per API instance with no PgBouncer in front. Running more than roughly 3 API instances concurrently risks exceeding Postgres's `max_connections` (default 100, minus migration/platform overhead) during a synchronized peak (the 8 a.m. attendance-marking rush across multiple campuses is the concrete scenario). This is an operational tuning item, not an architectural flaw — but it should be resolved (PgBouncer, or a lower per-instance `connection_limit` with a documented instance-count ceiling) **before** scaling the API out to more than a couple of instances, not discovered during an incident.

---

## 11. Best & ideal architecture approaches for this system

Concrete and prioritized, matched to what this codebase specifically needs next — not a generic maturity checklist:

1. **Close the `feature ↔ feature` boundary gap (§4) before it costs something.** Either add a barrel-only import rule (each feature module exports through one `index.ts`; ESLint's `boundaries/entry-point` rule can enforce this directly) or explicitly accept the current convention-only approach in writing and revisit it once the module count grows further. The dangerous middle ground is leaving it silently unenforced while believing it's enforced — this report exists partly to close that gap in understanding.
2. **Put PgBouncer (or equivalent pooling) in front of Postgres before scaling past ~3 API instances.** This is the single highest-leverage infra change available — cheap to add now, expensive to diagnose blind during a real incident.
3. **Generate the frontend API client from the backend's types (OpenAPI or a tRPC-style approach), retiring the hand-written `lib/api.ts`.** Every session that adds backend endpoints (this one added a dozen) currently requires manually re-deriving the frontend types with zero compiler check that they match — exactly the kind of drift a generated client eliminates by construction.
4. **Extract a minimal shared frontend UI kit** (Table, Form field, Dialog, Toast, and the now-duplicated `ResetPw`) as a first-class package before the next round of screens, rather than after — the duplication cost only goes up from here, and there's already a second confirmed instance of the same component copy-pasted.
5. **Add an ERD-generation step to the dev workflow** (`prisma-erd-generator` or similar, even just run on demand rather than in CI) now that the schema has crossed 50 models — a text-only 1,200-line schema file is a real review/onboarding cost at this size.
6. **Add a lightweight contract test** between `lib/api.ts`'s hand-written types and the actual backend DTOs (even a coarse "does this shape still parse" check) as a stopgap until #3 is done — this converts silent drift into a loud, cheap-to-fix CI failure.
7. **Treat the connection-pool math and the TLS-termination gap as a joint "go-live readiness" checklist item**, since both are the kind of infra detail that's easy to defer indefinitely without a forcing function — see the companion security report for the concrete assertion-based approach recommended there (fail fast at boot, don't rely on remembering).
8. **Keep doing exactly what's already working well**: the atomic-counter pattern (GR/registration/receipt numbers), the JSON-tiering decision for long-tail form fields, the permission-matrix-as-executable-spec, and the fail-closed default on every new authorization check (`restrictedCampusId`'s nil-UUID sentinel) are all genuinely good, repeatable patterns — the right move for new features is to reach for these first rather than re-derive a new approach each time, which is exactly what has been happening across this session's HR/recruitment/admission work.
