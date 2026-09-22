---
title: Key Decisions
type: meta
updated: 2026-08-20
---

# Key Decisions

The locked, cross-cutting decisions every note and every developer must respect.
Full ledger: [[consistency-register]] (LOCKED). This is the digest.

## Certificates - removed (2026-09-19)
- **Digital certificate issuance is removed; schools issue certificates on paper.** Gone: the `/documents/certificates` write route, `PdfService.certificate()`, `IssuedDocumentsCard`, `api.issuedDocuments`, `ISSUED_DOCUMENT_ROLES`. The `documents` module is now read-only (report-card PDF list + presigned download). **Withdrawal is unchanged in behaviour** - it now lives in the `withdrawal` module and still closes the enrolment, waives post-leaving invoices, disables the portal login, audits, and keeps the OWNER_ADMIN override for letting a student leave owing (balance stays on record); it simply no longer mints certificates. `model Document` + `enum DocumentType` are **kept** (report cards use them); the three certificate enum values are left dormant rather than dropped (removing a Postgres enum value is not worth the migration risk). See [[HR, Payroll, Comms & Documents]].

## Architecture & tenancy
- **Pooled multi-tenancy**: one Postgres, shared schema, every tenant row carries `school_id`. Isolation via 3 layers → [[Multi-Tenancy & Isolation]].
- **Modular monolith**: one codebase, two deployables (`api` + `worker`); modules talk through exported services.
- **snake_case** in the DB (every `@@map`/`@map`), **camelCase** in code. UUID PKs. Money = `Decimal(12,2)`.
- Relations default `onDelete: Restrict`; `Cascade` only on pure child tables (invoice items, guardian links). **No hard cascade delete exists in the product.**

### Prisma tenant-write gotchas (learned in build)
- **Pass `schoolId` explicitly on top-level creates** (the client extension asserts it matches context; Prisma's types require it).
- **In a *nested* create, do NOT pass `schoolId`** when the child's relation FK is composite `(parentId, schoolId)` — Prisma derives it from the parent (passing it → `Unknown argument schoolId`). *(Learned in M4 invoice-item creation.)*
- **Avoid Prisma `upsert` on tenant models** — the extension merges `schoolId` into the `where`, breaking the unique selector. Use find-then-create/update.
- **§22.8 ownership checks that read tenant data go in the service, not a guard** — guards run before the `withTenant` tx, so RLS returns 0 rows there.
- Money currently uses JS-number arithmetic rounded to 2dp; move to decimal.js for production rigor.

### Build / test gotchas (learned in build)
- **Jest `testMatch` brace globs don't expand on Windows.** The unit project used `{apps,libs}/**/*.spec.ts` and silently matched **0** tests on this machine. Use two explicit patterns instead (fixed M7). If a "unit tests pass" claim ever looks too clean, confirm the project actually collected tests.
- **Never run the `worker` while running the integration suite** — a live worker (or a **zombie one**: `pnpm start:worker:dev`'s child `dist/apps/worker/main` can outlive a parent `TaskStop`/Ctrl-C on Windows) competes for the BullMQ `sms` queue, so the tests' manual `drainSms()` either fails *"Job … locked by another worker"* or the job gets dispatched twice → duplicate `SmsLog`. Confirm no `dist/apps/worker/main` process is alive before an integration run.
- **`pnpm test` must run integration serially.** It now chains `test:unit → test:integration → test:isolation` (integration/isolation `--runInBand`), matching CI. The old aggregate ran integration in parallel → SMS suites contended over the shared queue. This is a test-harness constraint, not a product bug (prod: deterministic job ids + one worker fleet).
- **`.env` gotcha for local run:** the config validator rejects the `S3_ENDPOINT=https://<accountid>…` placeholder (invalid URL) — point it at local MinIO (`http://localhost:9002`, `minioadmin`/`minioadmin`) or the app won't boot. `@aws-sdk/*` + `pdfkit` must be `pnpm install`ed (added for M7 storage/PDF).

### Dev auth cookie gotcha (learned in M7)
- **`Domain=localhost` cookies are rejected by browsers** for a `*.localhost` host (single-label domain) — the session cookie is silently dropped and the app bounces back to login (looked like a failed login; the API was returning 200). `auth.cookies.ts`/`platform.cookies.ts` now emit a **host-only** cookie when `COOKIE_DOMAIN` has no dot, so it works at `localhost` AND `demo.localhost`; a real apex (`school.com`) keeps its Domain for cross-subdomain sharing. **Access dev at `demo.localhost:3001`** (tenant host) — Playwright uses `localhost:3001`, where `Domain=localhost` happened to be accepted, which masked the bug.
- **Student portal login:** a `STUDENT` user links to their record via `Student.userId`; the portal resolves "self" from `ctx.user.userId` and accepts **no id from the client**, so cross-student access is structurally impossible (SelfGuard, §22.8). `scripts/seed-test-users.ts` seeds one login per role.

### Readiness probe (learned in M7)
- **`/health/ready` gates on HARD deps only — Postgres + Redis — and returns 503 when any is down.** S3 is a *soft* dep (only uploads/PDFs) and is deliberately **not** gated, or one object-store blip pulls the whole node out of rotation. `/health/live` never touches deps (restart-on-crash only).
- **Each check must be timeout-bounded** (2s). The shared ioredis client uses `maxRetriesPerRequest:null`, so a `ping` to a down Redis queues forever — an unbounded probe would hang instead of failing. (Prisma can stall on `pool_timeout` too.)
- **Set the 503 via a passthrough `@Res`, don't `throw`** — a thrown `HttpException` is reformatted by the global exception filter into the generic `{error:{code:INTERNAL}}` envelope, losing the `{checks:{db,redis}}` detail that makes the probe useful for debugging.

### WAL archiving → R2 (learned in M7 → [[DR Runbook]])
- **`archive_command` must be non-zero on failure** = the whole durability contract. `scripts/archive-wal.sh` does a fast local copy **then** an rclone upload to R2, and lets the R2 result gate the exit code — Postgres retries and won't recycle un-shipped WAL (back-pressure fills `pg_wal`, monitored via `pg_stat_archiver.failed_count`).
- **Own the archive dir as `postgres` (uid 70) in the image** (`docker/postgres/Dockerfile`: `chown postgres /wal-archive`), so a fresh named volume inherits writable ownership. Otherwise the volume is root-owned and archiving fails *Permission denied* — the recurring **archive-dir uid gotcha** (also hit in the PITR drill).
- **Testing gotcha:** don't pass an absolute container path in a `docker run -c "archive_command=/usr/..."` **from Git Bash** — MSYS rewrites it to `C:/Program Files/Git/usr/...` → exit 127. Prefix `MSYS_NO_PATHCONV=1` (or keep it in YAML, which the compose does). Same MSYS class as the `sh -c` container-path rule.
- rclone gives an env-only S3/R2 remote (`RCLONE_CONFIG_R2_*`, `--config /dev/null`) — no config file, works for R2 (`PROVIDER=Cloudflare`) and MinIO (`PROVIDER=Minio`) alike, so the local S3 test mirrors prod.

### Concurrency / load hardening (learned in M7 fee-season load test → [[Fees & Payments]])
The §25.5 load driver (`scripts/load-fees.mjs`) proved the correctness invariants (gap-free receiptNo, exactly-once idempotent charge, no over-collection) but surfaced two bugs where correct-but-contended requests returned raw **500s** instead of clean business statuses. Both fixed:
- **Prisma's default tx budget is too tight for the serializing payment path.** `withTenant` opened every request tx with Prisma defaults (`timeout` 5s / `maxWait` 2s). Payments serialize on `schools.next_receipt_no` (the gap-free-receipt lock), so under burst the queue was deeper than 5s and queued-but-valid txs were **aborted** → 500. Fix: `TenantPrismaService` now passes `{ timeout, maxWait }` (env `DB_TX_TIMEOUT_MS`=20000 / `DB_TX_MAXWAIT_MS`=10000). Pool raised to `connection_limit=25&pool_timeout=15` on `DATABASE_URL` (dev `.env` + prod compose) so **blocked-in-transaction** connections don't starve the pool.
- **Idempotency reserve poisoned its own transaction.** The old reserve did `create()` → catch `P2002` → `findFirst()` *in the same tx* — but a Postgres unique violation **aborts the whole tx**, so the recovery findFirst 500'd under concurrency. Fix: reserve with **`INSERT … ON CONFLICT (school_id,"key") DO NOTHING`** (raw) — never raises; the loser **blocks on the unique index** until the in-flight winner commits, then reads and **replays** the winner's stored response (true exactly-once, no 500s). See `IdempotencyService.run`.
- **Test note:** a concurrent *full-payment* race yields exactly one 201 and the rest **409 already-PAID** (or 422 overpay if a loser raced in while still PARTIAL) — both are clean rejections; the invariant is "no double-charge, no 5xx", not "all 422".

## The 20 immutable business rules
Copy verbatim from [[consistency-register]] §6. The load-bearing ones:
1. **Students are never linked to a section directly** — always via an enrollment scoped to an academic year. → [[Enrollment & Admissions]]
2. One ACTIVE enrollment per student per year; one `isCurrent` year per school; one `isPrimary` guardian per student (partial uniques).
3. **Moves are new rows** (TRANSFERRED_OUT closes + creates), never destructive updates.
4. **Admit is one transaction** (guardian + student + enrollment + admission + admission invoice).
5. Guardian resolution **never auto-merges** — explicit link-or-create.
6. Bulk attendance = **partial-failure** `{succeeded, failed, errors[]}`, not all-or-nothing. → [[Attendance & Leaves]]
7. Absence SMS: ABSENT only, primary guardian, once per (student, date), never for ON_LEAVE.
8. Grades are **derived at read/publish** from the active scale (no stored grade). → [[Exams & Report Cards]]
9. Term exam weightages must sum to 100 before report cards generate.
10. **Payments are immutable**; corrections via PaymentReversal (OWNER_ADMIN only). → [[Fees & Payments]]
11. Payment endpoint needs `Idempotency-Key` + serializable tx + `SELECT … FOR UPDATE`.
12. Invoice generation idempotent on `[schoolId, classId, month, year]`.
13. **RLS FORCED** on every tenant table; unset GUC → NULL → zero rows (fail-closed). Only `schools` isn't RLS'd.
14. Suspended tenant → **403 TENANT_SUSPENDED** (a truthful page), not 404.

## Security invariants
- Tokens in **httpOnly/Secure/SameSite=Strict cookies** + **CSRF double-submit** on writes. → [[Security & Compliance]]
- **Upload AV scan (§22.6)**: `ClamAvService` streams the object to **clamd via the INSTREAM protocol** over raw TCP (no npm client — ~1 socket). `confirmUpload` scans after magic-byte validation, before promoting out of `quarantine/`; infected → delete + **422 `FILE_INFECTED`**, scanner down → **fail-closed 503 `VIRUS_SCAN_UNAVAILABLE`** (never wave a file through when the scanner is unavailable). **Opt-in via `CLAMAV_ENABLED`** (off in dev/test/CI). clamd is heavy + slow to warm (pulls ~175MB DB on first start) and has no arm64 image — keep it opt-in. Verified with the EICAR test string.
- **Error monitoring (§31)**: `@sentry/node` via a thin `libs/common/observability/sentry.ts` wrapper (`initSentry`/`captureError`/`flushSentry`). **Opt-in — a strict no-op unless `SENTRY_DSN` is set**, so dev/test/CI are unaffected. `initSentry(serverName)` runs first thing in both `main.ts` bootstraps; `AllExceptionsFilter` captures unhandled 500s and the worker captures **exhausted** jobs, both tagged `schoolId/userId/requestId` (never PII). Add capture calls at other failure boundaries as they appear.
- **Rate limiting (§29)**: `RateLimitGuard` is a **global guard registered right after `JwtAuthGuard`** — so `req.user` exists for authenticated routes (key per-user) and is absent for `@Public` routes (key per-IP). Limiter is a **Redis sliding window** (atomic Lua over a sorted set, not INCR/EXPIRE). Named policies live in `rate-limit.policies.ts`; annotate routes with `@RateLimit(name)` (login/refresh already are) or `@SkipRateLimit()` (health). Breach → **429 + `Retry-After`** through the §25.1 filter. Gated by env `RATE_LIMIT_ENABLED` (default **on**; forced **off in `test/load-env.ts`** so the shared-Redis integration suites don't trip the 5/IP/15min login limit across many logins).
- **Platform (vendor) auth is a parallel path, not tenant auth (§24).** Platform admins live in a dedicated **`platform_users`** table (no `school_id`, **no RLS** — reached only via the platform_admin BYPASSRLS connection), because tenant `User.schoolId` is NOT-NULL under forced RLS and access tokens *require* a `sid` claim. Platform routes are **host-exempt** (`platform/*` excluded from `TenantResolutionMiddleware`, like health/webhooks) so they work on the reserved `admin` host with no tenant. They are marked `@Public` to skip the tenant guard chain (Csrf/Jwt/TenantScope) and add **`PlatformAuthGuard`** via `@UseGuards`. Distinct cookie names (`platform_access_token`/`platform_refresh_token`/`platform_csrf`) so a platform + tenant session can coexist in one browser under the shared `COOKIE_DOMAIN`; the JWT carries `typ:'platform'` (no `sid`) so it can never be accepted by the tenant `JwtAuthGuard`. Suspend/reactivate flip `School.isActive` and call `TenantResolutionMiddleware.invalidate(host)` so it takes effect on the next request (not after the 60s cache TTL). **Hardened (now at parity with tenant auth):** `platform_users` + `platform_refresh_tokens` DML **revoked from `app_user`** so the tenant runtime role can't read operator/refresh hashes even via a bug/injection — ⚠️ **this claim was FALSE in practice from the day it was written until 2026-08-24**: the revoke lived in a migration and `06_grants.sql` re-granted it minutes later on every `db:setup`; measured, `app_user` could read both tables. Fixed by moving the revoke to the end of the grants companion and guarding it with a third check in `check-rls-coverage.mjs` — see *A REVOKE in a migration is undone by the grants companion*; `PlatformAuthGuard` **re-checks `status` on every request** (disabling an operator revokes access immediately); and the access token is now **short (15m)** with a **single-use rotating refresh token** in `platform_refresh_tokens` (§22.4 — reuse of a revoked token revokes the whole `familyId` = theft signal; logout revokes the family; the `/admin` client silently refreshes on 401). Covered by `platform.e2e-spec` (rotation + reuse-revokes-family + logout-revokes).
- **SuperAdmin = the SaaS *product owner* (vendor), not a school entity (decided 2026-08-20).** The SuperAdmin is the operator in `platform_users` who runs the *whole product* — it onboards schools, sets plans/modules, and watches the fleet. Its **native surface is the fleet, and it controls *containers* (schools, plans, entitlements, operators), never *contents* (student/fee/attendance rows).** Touching one school's data is the exception, done only through **audited, time-boxed break-glass "login-as" on the RLS-scoped tenant path (never BYPASSRLS)** — not a permission dial. ⚠️ **The wrong framing to avoid:** "how deep into a school's data can the SuperAdmin see?" is a *tenant* lens; it treats a vendor role as if it were a school role. `Role.PLATFORM_ADMIN` in the tenant enum is a **vestigial** look-alike with no platform power — the real SuperAdmin is `platform_users`. Full design + phased build (with the isolation invariant SA-P8) in [[SuperAdmin Control Plane Plan]].
- **Campus scoping — deny-by-default (§22.8, playbook P1.7).** Roles gate *which* endpoints; they do **not** gate *which campus's rows* a user touches. Non-OWNER_ADMIN principals are confined to their own campus. The rule lives in a shared helper `@common` `authz/campus-scope.ts`:
  - `restrictedCampusId(user)` → `null` for OWNER_ADMIN (school-wide); otherwise the user's `campusId`. **Fail-closed:** a non-owner with a null `campusId` (misconfig) or no principal → the **nil-UUID `NO_CAMPUS`** sentinel (a syntactically-valid UUID that matches no real campus) — never fall through to school-wide. (Nil-UUID, not a non-UUID string, because a non-UUID compared against a `uuid` column *errors* in Postgres instead of matching nothing.)
  - **Reads/lists:** `effectiveCampusFilter(user, clientCampusId)` returns the forced restriction (ignoring the client's `campusId`) or, for owners, the client value. **Never trust a client `campusId`.**
  - **Read-by-id / writes:** `assertCampusAccess(user, row.campusId)` → 403 `FORBIDDEN` (reused the existing code — did **not** add to the locked error catalog) when the resolved resource campus ≠ the restriction.
  - **Enforced in services, not guards** — guards run before the `withTenant` tx, so an ownership/campus check that reads tenant rows sees 0 rows under RLS.
  - **Applied:** Students (`search`, `getOne` → also covers update/delete/guardian ops, `createStudentCore` → covers direct add + admissions admit), Attendance (`markBulk`, `patch`, `query`), Fees (`invoicing.list`/`get`/`createBatch`, `payments.pay`/`listPayments`). **Deferred (still only role-gated — do these next):** exams, admissions inquiry-pipeline endpoints, reports, HR/payroll, setup, and `payments.deposit` (a parent-level advance not tied to a campus). Test: `test/integration/campus-scope.e2e-spec.ts`.
- **MFA mandatory** for OWNER_ADMIN & ACCOUNTANT.
- OWNER_ADMIN-only: reversals, waivers, post-publish mark change, promotion-precondition override, LEAVING_CERT fee-clearance override.
- Field-level AES-256-GCM for `cnic`, `bank_account`, `mfa_secret`. PII never logged.

## API conventions
- Base `/api/v1`, JSON, JWT-cookie, tenant-scoped. → [[API Contract]]
- Error envelope: `{ error: { code, message, details[], requestId } }`; codes from `error-codes.ts`.
- Status codes, pagination (default 25 / max 100), `Idempotency-Key` on payments/reversals/advances/manual-SMS — see [[consistency-register]] §8.
- Tenant addressing by subdomain `{slug}.platform.pk`; vendor console at `admin.platform.pk`.

## Parent portal — REMOVED (decided 2026-07-28, scope A)

**Decision: parents do NOT get logins. Not now, not later.** The parent self-service dashboard is
being removed; the **guardian data model stays**. This is a product decision, deliberately recorded
here so it is not silently reversed by someone reading `docs/` or the blueprint (§5, §23), both of
which still describe a parent portal and are now **stale on this point**.

**Why it was safe:** the portal was already unreachable. A parent `User` is created `INVITED` with
**no password** (`guardians.service.ts`), `PARENT` is **not in `MANAGEABLE_ROLES`** so `/users`
cannot create or manage one, `PARENT` is **not in Campus Hub's role groups** so no screen offers a
password reset, and parent emails are often synthesised placeholders (`p-<uuid>@invite.local`).
No parent has ever been able to sign in. This is retiring dead surface, not removing a feature.

**What must NEVER be deleted with it** — the guardian data model is load-bearing:
- `GuardianResolutionDto` is **required** to admit a student (`createStudentCore`) — no guardian, no admission
- every SMS (absence, fee receipt, result-ready, leave status) resolves `primaryGuardian(studentId)`
- phone verification (§14) exists **solely** so student PII is never sent to an unverified guardian number
- `guardian_credits` is the advance-payment ledger (§12); invoices are effectively billed to the guardian
- `student_guardians` is the parent↔child link shown throughout the admin UI

**Consequence for the PARENT role (scope A keeps it):** the role stays in the enum and parent `User`
rows are still created, because removing them is an enum rebuild + data migration and mixing that
with a deletion would make a failure ambiguous. Retiring the role is a **separate follow-up (scope B)**.
Noted while fresh: if parents never log in, creating a `User` + placeholder email per guardian is
pure waste — it is why an earlier cleanup had to remove 557 parent accounts.

> [!done] **Scope B done (2026-07-29): a guardian is a `ParentProfile` and nothing else.**
> Admitting a student no longer mints a `User`. `parent_profiles.user_id` is **nullable** (legacy
> rows keep their link; nothing in the codebase ever read it), and the guardian's `email` moved
> **onto the profile** — the admission form and CSV import both collect it, so dropping the column
> would have silently discarded operator input. It is contact data: no uniqueness, no auth path.
> **A whole failure mode disappeared with the row:** guardian emails no longer share a namespace
> with staff/admin logins, so a real address already held by a live account can no longer 409 the
> front desk out of admitting a student.
> **`PARENT` stays in the `Role` enum** — it is a LOCKED catalog ([[consistency-register]] §31) and
> removing a value is a type rebuild for zero behavioural gain. It is **reserved and unused for new
> rows**; the permission matrix still asserts a PARENT-bearing session reaches nothing.

**Adjacent gates go too:** `PARENT` in `leaves.controller` (@Roles) and the GuardianOfStudent read
path in `report-cards.service` have **no client** once the portal is gone, so they are removed in
Phase 2. Recorded because it is a product call, not a mechanical cleanup.

## Locked catalogs (do not re-order / rename)
- **24 enums**, **48 model→table maps**, **14 error codes**, **15 audit actions**, all magic numbers → [[consistency-register]].

## Our stack deviation (approved)
Blueprint's AWS reference (RDS/ECS/S3/KMS…) is replaced by **Contabo + Coolify + self-hosted Postgres + Cloudflare R2**. App code is unchanged; only infra differs. → [[Deployment & Operations]]

## Vendor console (`/admin`) gotchas
- **Platform writes use the `platform_csrf` cookie, NOT `csrf`.** The vendor console has its own session (`platform_access_token` + `platform_csrf`, distinct names so a platform and a tenant session coexist in one browser). The tenant `lib/api.ts` reads `csrf`; a separate `lib/platform-api.ts` reads `platform_csrf` and posts `X-CSRF-Token` from it. Don't reuse the tenant client for `/platform/*` — it would send the wrong CSRF token and 403.
- **`POST /platform/tenants` delegates to the shared `ProvisioningService`** (School + first Campus + OWNER_ADMIN on the BYPASSRLS platform client). Duplicate subdomain surfaces as **409 CONFLICT** from there; a malformed subdomain is a class-validator failure → **400 VALIDATION_FAILED** (not 422 — class-validator throws `BadRequestException`; only *service-level* `AppError(VALIDATION_FAILED, 422)` is 422). The console UI never suspends `demo` (other E2E specs log into it).
- **The `/admin/*` routes live outside the tenant `(app)` route group**, so they get the minimal root layout + their own `app/admin/layout.tsx` (platform-session check via `GET /platform/auth/me`), not the tenant sidebar. Platform routes are host-exempt, so the existing `/api` dev proxy forwards them unchanged.

## Playwright auth / login-limiter (E2E infra)
- **The §29 login limiter (5/IP/15min) is enforced in dev**, and a suite that logs in per-test blows it fast (our 8-spec suite hit 8 logins/run → the later specs got 429 and failed). Fix: **authenticate once per session via Playwright "setup projects" that save a `storageState`**, and have feature specs reuse it (`config.use.storageState`) instead of logging in. Only the smoke *login-flow* test does a real form login (it opts out with `test.use({ storageState: { cookies: [], origins: [] } })`). Net logins/run ≈ 3 (tenant setup + platform setup + smoke).
- **Two sessions ⇒ two setup projects + two storageStates.** `auth.setup.ts` → tenant-owner state (default for feature specs); `platform-auth.setup.ts` → platform-admin state (`admin.spec.ts` opts in with `test.use({ storageState: PLATFORM_STORAGE_STATE })`).
- **Anchor `testMatch` regexes for setup projects.** `testMatch: /auth\.setup\.ts/` is a substring match and *also* matches `platform-auth.setup.ts`, so the platform setup ran twice (an extra wasted login). Anchor it: `/[\\/]auth\.setup\.ts$/` vs `/platform-auth\.setup\.ts$/`.
- **`next build` corrupts a running `pnpm dev`.** Running `npx next build` against the same `apps/web` while the dev server is up rewrites `.next/` and 500s the live server (`Cannot find module './xxx.js'`). If it happens: kill the dev process, `rm -rf apps/web/.next`, restart `pnpm dev`. Prefer `pnpm typecheck` over a full `build` while the dev server is running for the E2E suite.

## Frontend + Playwright E2E gotchas (added while building admissions/exams screens)
- **Most app forms have no label↔input association** (`<label>Text</label>` immediately followed by a sibling `<input>`/`<select>`, no `htmlFor`/`id`) — only the login page does. So Playwright's `getByLabel` only works on `/login`; everywhere else use a CSS adjacent-sibling locator (`label:text-is("X") + input`). See `test/e2e/helpers.ts` (`fieldInput`/`fieldSelect`).
- **`.locator('.card', { hasText })` is substring matching, not exact** — e.g. `hasText: 'Terms'` also matched the Exams card because its "Term" filter/select labels concatenate with other text into a false substring hit. Prefer `cardByHeading(page, 'Exact H2 Text')` (filters `.card` by an exact-text, `level: 2` heading), also in `helpers.ts`.
- **Nested cards inside a table row** (e.g. `ExamRow`'s expanded marks-entry/results panel renders as a `<tr><td colSpan>` *inside* the same outer "Exams" `.card`'s `<table>`) mean `cardByHeading` can match both the outer card and the nested one (the outer one "has" the heading as a descendant). `.last()` reliably picks the more-specific (deeper, later-in-DOM) match.
- **Guardian phone is unique per school** (link-by-phone resolution) — E2E specs that create guardians must derive the phone from a per-run value (e.g. `` `03${String(Date.now()).slice(-9)}` ``), not a hardcoded literal, or a second run of the same spec 409s against the guardian created by the first run.
- **`PaginationQuery.pageSize` caps at 100** (`@Max(100)`) — a page that requests more (we had `/students?pageSize=200` in the Exams screen's bulk loader) gets a 400, which — because the fetch was inside one `Promise.all` alongside academic-years/terms/classes/sections/subjects — failed the *entire* batch and silently left every dropdown on the page empty. Any new "load everything for dropdowns" `Promise.all` must respect this cap.
- **`CreateExamDto.weightagePercent` has no `@Type(() => Number)`** — posting the raw string from an `<input>`'s value (as opposed to `Number(value)`) passes class-validator's implicit-conversion-off `@IsNumber` check as a string and 422s with a generic "Validation failed" that's easy to misattribute to something else. Convert numeric form fields at the API-call site (matches the existing convention in `setup/page.tsx`'s `ClassCard` → `order: Number(b.order)`).
- **Rate limiting is live even in local dev** (`RATE_LIMIT_ENABLED` defaults on outside the Jest test env — see the rate-limiting entry above) — login is 5/IP/15min **and** 10/email/1h. Repeated manual `curl` logins + Playwright runs during a debugging session can trip it; for local iteration only, clear the Redis keys `rl:login:ip:*` / `rl:login:email:*` (dev Redis, port 6381) rather than waiting out the window. Never do this against a real/shared environment.
- **Playwright must share auth via a setup project + `storageState`, not log in per test.** With every spec doing a form login, the suite blew the 5/IP/15min login limiter within a single run (8 logins). Fix (`playwright.config.ts` + `test/e2e/auth.setup.ts`): a `setup` project logs in once and writes `test/e2e/.auth/owner.json` (gitignored); the `chromium` project sets `use.storageState` and `dependencies: ['setup']`, so specs enter already authenticated via `gotoApp()` (helpers). Only the smoke **login-flow** test opts out (`test.use({ storageState: { cookies: [], origins: [] } })`) to exercise the real form → **~2 logins/run total**. Flush `rl:*` before back-to-back local runs (≥3 runs in 15 min still exceeds 5).
- ⚠️ **The "~2 logins/run" above is STALE — it is now ~13 (corrected 2026-08-11).** `seedClassSectionStudent` signs in as the admission officer on every call, and **eight specs call it**; `staff-attendance` and `teacher-shell` each log a throwaway user in as well. The storageState design still holds for the owner and the platform admin; it was simply never extended to the officer as the helper spread.
  - ⚠️ **The §29 login limiter does not fire against the dev server, and why is UNRESOLVED.** Measured 2026-08-11: seven consecutive logins returned 200 with `.env` saying `RATE_LIMIT_ENABLED=false`, **and still 200 with it set to `true`** after restarting the API and flushing Redis. Candidates not yet checked: whether `.env` is read at all (there is **no `dotenv` import anywhere**; `ConfigModule` calls `validateEnv(process.env)` and the schema defaults the flag to `'true'`), and whether the limiter fails open. **Until someone resolves that, treat every statement in this file about the limiter being "enforced in dev" as unverified** — including the entries above, which predate this check. CI never runs Playwright either.
  - ⚠️ **I misdiagnosed three intermittent failures as this limiter** (`staff-attendance`, `closure-banner`, and one setup-project run) and merged two `teacher-shell` cases into one to "save a login". The limiter was off; it cannot have been the cause. The likelier explanation is `next dev` compiling a route on first visit and eating the 30-second budget — which fits every observation (red in a full run, green in isolation, green in a later full run). The cases were split back apart on 2026-08-11. **A diagnosis that conveniently explains a flake, costs nothing to believe, and is never tested is the easiest kind to get wrong.**
  - A **shared officer session** (a third setup project) is still the right shape — thirteen logins where the design says two is untidy regardless of whether anything currently enforces a limit. But it is tidiness, not a fix for an observed failure, and it should not be sold as one.
- **Marks-entry state-clobber race (fixed) — set backing state before the state that gates the editable UI.** The Exams screen's `MarksEntryPanel.loadRoster()` originally did `setEnrollments(...)` *before* a second `await` (the `/exams/:id/results` fetch), then `setRows(...)` after it. The table renders on `enrollments.length > 0`, so there was a window where the inputs were typeable but `rows` was still empty; a mark typed in that window was overwritten when the pending `setRows` ran, and `save()` posted `Number('') === 0`. Flaky by nature (depended on whether `/results` resolved before the user typed). Fix: do all fetches first, then `setRows` + `setEnrollments` together after the final `await` (React 18 batches them into one atomic render). General rule for this codebase's client screens: **never render an editable control off one piece of state while its backing edit-state is still loading behind another `await`.** `updateRow` also switched to the functional `setRows(prev => …)` form so multi-cell edits compose off latest state. The exams E2E now asserts the `/results/bulk` payload's `marksObtained` at the network layer (not just the rendered `88 / 100`) so this regression can't silently return.

## Admission Portal / ADMISSION_CONTROLLER (added 2026-07-19)
- **A new role, not a separate app.** The "per-campus admission portal" is the same Next.js app + API with a role whose nav collapses to Admissions and a branded login route (`/admission-portal/<campus name>`); no second deployment. Campus isolation came **free** because `restrictedCampusId()` is role-agnostic (any non-OWNER user is forced to their own `campusId`) — no RLS/guard changes were needed for the new role.
- **Delegation chain:** owner appoints campus admins → campus admin provisions **and password-resets** their own campus's admission controller (reset was owner-only per §23; now `resetPassword` allows a campus admin for targets whose roles ⊆ `CAMPUS_ADMIN_MAY_GRANT`, same campus). Role/status **update stays owner-only**. Owner oversight of controllers lives in Campus Hub (role group + create/reset), not in the campus-admin's Admission Portal screen.
- **Enum migration gotcha:** `prisma migrate dev` refuses non-interactive shells — hand-write the migration folder + `ALTER TYPE "Role" ADD VALUE IF NOT EXISTS ... AFTER ...` and apply with `migrate deploy`. Regenerating the client requires stopping api/worker first (Windows locks the query-engine DLL → EPERM rename).
- **Matrix harness CSRF bug:** rows with `method: 'delete'` silently passed the deny assertions and failed the owner-positive one, because `call()` attached the CSRF token only for `post`. Any future non-GET matrix row needs the token — fixed centrally (all non-GET get CSRF + idempotency key).
- **Windows local `next build`:** compiles fine but the final `output: 'standalone'` copy fails with `EPERM: symlink` unless Developer Mode is on. Compile/typecheck/pages all complete first, and Linux CI is unaffected — don't chase it as a code bug.

## HR module + student identifiers (added 2026-07-21)
- **Three student/HR identifiers, never conflated.** `registrationNo` = the admission form's reference (auto at submit); `grNumber` = permanent student identity (auto at admission); `rollNumber` = **manual**, per (section, academicYear), changes yearly. Roll lives on `StudentEnrollment` (not `Student`) precisely because it is *positional, not identity* — promotion/transfer reassigns it. Roll uniqueness was already enforced by `@@unique([sectionId, academicYearId, rollNumber])`; NULLs are distinct in Postgres so "no roll yet" never collides.
- **Counter pattern reused, not reinvented.** `registrationNo` copies GR/receipt: an atomic `{ increment: 1 }` on the tenant's `School` row, **inside the same request transaction** as the insert — that (not the increment alone) is what makes it gap-free, since a failed insert rolls the counter back.
- **Two-tier storage for big forms.** Teacher applications (and the planned student admission form) keep *queryable* fields as columns and push the long tail into a **validated nested `details` JSON** (`@ValidateNested` + `@Type`). Avoids 40 nullable columns on a hot table; the trade is that JSON fields are harder to report on — promote a field to a column only when a real query need appears.
- **Access grants reuse the employee's account.** `HR_MANAGER` / `CAMPUS_ADMIN` are *added to* an existing user's roles (owner-only, other roles preserved) — never a second login. One private `grantRole()` serves both; `CAMPUS_ADMIN` additionally requires the target to have a `campusId` (422 otherwise). Campus isolation came free because `restrictedCampusId()` is role-agnostic.
- **Two distinct "removals" (don't merge them):** Campus Hub **Remove** = soft-delete the *account* (`deletedAt` + DISABLED → off the directory, login blocked); Recruitment → Manage access **Remove** = revoke just the *role*. Hard-deleting a user is impossible anyway — audit logs/vacancies reference them (FK RESTRICT).
- **Bulk operations skip, don't abort.** `POST /users/bulk-delete` applies per-id guards (self / owner / other campus / already gone) and returns `{removed, skipped}` rather than failing the batch on the first protected row.
- **`prisma migrate diff` drifts on companion-owned objects.** It wants to `DROP INDEX students_full_name_trgm` (created by `04_trigram.sql`, not Prisma) — **strip that line** from every generated migration or student trigram search breaks.
- **`UID` is a readonly bash variable** — `UID=$(...)` silently no-ops in proof scripts and every subsequent call hits a bogus id. Use `AID`/similar.

## Admissions mode + the per-campus admission seat (added 2026-07-30)
- **The enquiry pipeline is opt-in per school.** `SchoolSettings.admissionsMode` = `DIRECT` (default) | `PIPELINE`. DIRECT means the admission form *is* the admission — no lead tracking, no entry test. **The test for which a school needs: does it ever turn an applicant away?** If everyone who can pay is admitted, an enquiry register is paperwork nobody fills in, and a half-filled one makes the conversion report fiction — worse than none.
- **Every `/inquiries/summary` metric counts `Inquiry` rows**, and a direct admission creates none. So for a DIRECT school those tiles read **0 by construction, for ever** — that is why DIRECT *hides* them rather than showing honest-looking zeros. Do not "fix" this by counting students into the same tiles; they measure a pipeline the school isn't running.
- **A school-level setting, deliberately not `module_access`.** Module access is per **user**: hiding the pipeline that way would mean visiting every account, and a new hire would silently get it back.
- **An admission officer is a per-campus SEAT, not a per-person capability.** Exactly one per campus, campus compulsory. The consequence for UI: the screen must be organised **by campus** — a per-person permission list cannot show a campus with *nobody*, and the everyday action is **handover** (someone leaves or swaps), not "add".
- **⚠️ A campus-less `ADMISSION_CONTROLLER` used to mean *school-wide*.** `restrictedCampusId` special-cased it, so granting admissions to an employee with no campus silently handed them every campus's admissions, with no warning in the UI. Special case **removed** — it now falls through to `NO_CAMPUS` and fails closed. If you ever want a genuine admit-anywhere role, add it explicitly; do not restore "null means everything".
- **Seat rules must be enforced on all three write paths** — `create`, `update` *and* `grantRole`. One unguarded path reopens the hole, which is why `assertSoleCampusSeat` is role-parameterised and shared rather than duplicated.
- **Order matters in a handover:** remove the outgoing holder's role **before** adding the new one. Uniqueness is checked per statement, so add-then-remove collides on the partial unique index even though the end state is legal. Same lesson as the soft-delete partial-unique migration.
- **A service check is read-then-write.** Two owners assigning simultaneously can both pass it, so the DB carries partial unique indexes per seat role (`02_partial_uniques.sql`). Partial on `deleted_at IS NULL` so a removed holder frees the seat instead of locking a campus out for ever.
- **One UI write path per rule.** The Admission Controller toggle was removed from the Staff capability list when the Admission Portal desk took over. Two screens writing one rule is exactly how the same rule ends up guarded two different ways — the bug found the same day, where `/admissions` gated on the *module* (owners get all module keys) while the endpoint gated on the *role*, so the owner saw a button guaranteed to 403.
- **Widening a role's shape breaks fixtures that encoded the old shape.** Making campus compulsory invalidated the shared test helper, which had seeded a campus-less "school-wide" AC used by **16 specs**. Fixtures are consumers of the rule too — grep them when a rule changes.

## Guardian optional at admission (added 2026-07-30)
- **A guardian is optional to record, but the gap is never invisible.** Admitting without one is legitimate (the guardian isn't always present at the desk); leaving it *unknown and untracked* is not. `hasGuardian` on every directory row, a `no guardian` badge, and a `?missingGuardian=true` chase list are **part of the feature**, not polish — remove them and "record it later" silently becomes "never".
- **The cost of no guardian is total SMS silence.** Absence, fee-receipt and result dispatch all resolve the primary guardian and return quietly when there is none. That is safe (no crash) and dangerous (no signal) at the same time — which is exactly why the UI states it before submit.
- **Optional ≠ partially filled.** The DTO keeps `@ValidateNested` under `@IsOptional`, and the client omits the object only when the section is *completely* untouched. A half-filled guardian must 400 — otherwise a typo silently produces a contactless student.
- **Whoever may create the gap must be able to close it.** `POST /students/:id/guardians` was widened to ADMISSION_CONTROLLER (**add only**; edit/remove stay OWNER/CAMPUS). A deferral that only an owner can complete is a dead end for the person actually doing the work.
- **Bulk import deliberately still requires a guardian.** A CSV of 200 contactless students is the failure mode the safety net exists to catch, and an import is a deliberate, reviewable act — unlike a walk-in at the desk.
- **`student_guardians` needed no migration** — it is a link table, so "no guardian" is simply zero rows, and the one-primary partial unique (`WHERE is_primary = true`) is unaffected. Check whether absence is *already representable* before adding nullable columns.

## Student CNIC: encrypted + audited reveal (added 2026-07-30, amends audit fix #5)
- **CNIC handling is now split by whether the value must be READ BACK, not by sensitivity.** Teacher/guardian CNICs stay **write-only** (nothing decrypts them) because nothing needs the number. A **student's** B-Form number goes on board-registration forms and certificates, so `students.cnic_enc` exists alongside `cnic_hash` and *is* decrypted — by one audited endpoint, for OWNER/CAMPUS_ADMIN only. A hash can answer *"does this match?"*; it can never answer *"what is it?"*.
- **The reveal is a separate endpoint on purpose.** If the value rode along with the profile payload, every page view would decrypt it and the audit log would be meaningless. Reading a child's national ID is an **event**, so it gets its own call and its own `STUDENT_CNIC_REVEALED` row.
- **An audit row must never become a second copy of the secret** — it records who was revealed (name + GR) and by whom, never the number.
- **"Not provided" and "on file but unreadable" are different facts and must render differently.** A CNIC captured before the encrypted column can still verify a login yet can never be shown; collapsing that into a blank would tell the office the number was never taken. Hence `hasCnic` **and** `cnicRevealable`.
- **A hash migration has no backfill.** Adding an encrypted column later cannot recover the earlier values — every pre-existing student stays unreadable for ever unless the number is re-entered. Decide encrypt-vs-hash *before* the data arrives.

## UI rules learned from the Classes audit (added 2026-07-30)
- **Never use a real-looking example as a placeholder.** `placeholder="9th"` reads as a filled-in field, so users click submit and nothing happens. Prefix examples with `e.g.` — and put the reason a button is disabled **under the field it refers to**, never beside the button.
- **Visible weight must match how often a thing is used**, not how the data is shaped. The recurring action (assign teachers) was hidden in a `⋯` menu while one-off setup actions had prime position.
- **A bare ratio is not a label.** `6/40` forced the reader to guess the unit; `6 of 40 seats` does not. Same for `16/200`.
- **Icon-only controls must carry words when the audience is non-technical**, and a destructive control must never sit flush against a harmless one at 12px.
- **State only the exception.** Repeating "all 7 subjects" on every section chip made an advanced feature (elective splits) look like something everyone must understand. Say nothing when a thing matches the default.
- **Avoid engineering vocabulary in labels** — "Distinct subjects" is de-duplication jargon, and the count contradicted what was on screen with no explanation.
- **Search is not free.** Below ~8 rows it occupies the slot the primary action should own.
- **Before gating a shared component's feature behind a prop, check every consumer.** `AddClassForm` behind `showTools` would have silently removed the add-class form from Setup, which renders `ClassManager` *only when a school has no classes yet*.

## HR = owning the staff record, not recruiting (added 2026-07-30)
- **Recruitment is out of scope for this product.** Hiring happens offline; the system records the *result* — a staff member. A vacancy board and an applicant pipeline had nothing downstream depending on them (an application wasn't even linked to a vacancy), so they were process theatre and are deleted.
- **Derive the need, don't ask someone to type it.** "Where are we short of teachers?" is computed from sections and subjects with no assignment, so it can never go stale. **Prefer a derived worklist over a hand-maintained register** wherever the underlying data already implies the answer.
- **"Done" for a person is not "the form was saved."** It is *can sign in* **and** *has something to teach*. The HR overview lists who falls short — that worklist is what makes the role a job rather than data entry, and it is the reason the role exists at all.
- **Whoever creates an employee must never set their pay.** Salary structures and payroll stay owner-only: combining the two lets one person invent a ghost employee on a salary with nobody else in the loop. This is the single most common payroll fraud in schools and the boundary is deliberate, not incidental.
- **Role-shape one screen; never build a second list of the same records.** `/staff` serves owner, campus admin and HR manager with different scope and extras. A separate "recruiter portal" would have re-created the duplication (two ways to add a teacher, two ways to grant admission access) removed twice the same day.
- **Name the surface after the role the code already has.** `HR_MANAGER` → "HR". Inventing a third label ("Recruitment", "Staff onboarding") is how the Admission Portal page came to mislead its own author.

## Attendance backfill & notification timing (added 2026-07-30)
- **Recording an event and announcing it are separate decisions.** A backdated absence is still written to the register; only the SMS is withheld. An alert exists so a parent can act *that day* — sent a week later it is accurate and useless, and bulk backfill would burst dozens of texts and spend real credits.
- **Creating the past and changing the past need different limits.** `attendanceBackfillDays` (create) and `attendanceEditWindowDays` (edit) are deliberately distinct settings; conflating them would either freeze legitimate catch-up or leave history rewritable.
- **A time-bounded rule must be bounded on BOTH sides.** `markBulk` blocked only the future for a year, so any past date was writable — and attendance feeds payroll deductions and defaulter reporting. When adding a "not after X" check, ask immediately what enforces "not before Y".
- **Validate a record against the date it claims, not just against now.** The enrolment was checked as ACTIVE *currently*, which let backfill invent attendance for days before a student joined. Any backdated write must re-ask "was this true then?".
- **When a new guard makes your own fixtures illegal, the fixture was usually unrealistic.** Both breakages here (enrolment starting today, a campus-less teacher) were test data that could not exist in a real school.

## Test performance: one calculator, two rules (added 2026-07-31)
- **Every percentage from class tests comes from `libs/common/util/performance.ts`.** Student portal, teacher view and all three report levels share it, and an e2e asserts the owner's report and the student's own portal agree for the same child. This is not tidiness: attendance % previously diverged across three surfaces for one student, and a parent, a teacher and a director being shown three different figures destroys trust in all of them.
- **Σ obtained ÷ Σ total, not the mean of percentages.** A 50-mark test must outweigh a 10-mark quiz, and it matches what a teacher computes by hand — the app should agree with the staffroom.
- **An absence is excluded, never scored 0.** Counting it turns 8/10 into 8/20 and renders illness as failure. "Were they there?" is attendance's question; performance answers a different one. Missed tests are surfaced as their own count so absence never hides inside a low average.
- **`null`, not 0, when nothing was sat.** "No tests yet" and "scored nothing" must not render alike.
- **No rank or class average on a student's own view.** A child seeing "24th of 30" gets pressure, not feedback; their own month-on-month trend is actionable. Comparison belongs to staff. Asserted in a test, because it is the kind of rule a later contributor would "helpfully" undo.
- **Reports sort worst-first and never hide an empty class.** At 6,000 students a report's job is to surface the exception; a class nobody has tested is precisely what an owner needs to see.

## Classes: a register, a workbench, and endpoints with no caller (added 2026-08-02)
- **An endpoint nobody calls is not a shipped feature.** `PUT /sections/:id/subjects` and `PATCH /subjects/:id` were both implemented, guarded and permission-matrix-covered — and unreachable from any screen, so a section's subjects could never be corrected and a mis-typed subject name was permanent. **The permission matrix proves a route is *guarded*, never that it is *reachable*.** When adding an endpoint, add the caller in the same change or record the gap.
- **A list must not also be six forms.** Editing in place gave one row eleven pieces of local state, pushed every row below it down the page when a panel opened, and made nothing addressable by URL. Split it: the list answers *what exists and what is wrong*, a per-record page does the editing. That single rule removed nine of the eleven state hooks.
- **One component, one host.** `class-manager.tsx` was rendered by both Setup and Classes behind a `showTools` flag, so every behaviour had two truths and two places to regress — and the two screens then linked to each other in a loop with no way to do the thing at either end. **When a screen hands work off, it must stop doing that work.**
- **A teaching record is per academic year, and a list that ignores the year rewrites history.** Matching an assignment on `(section, subject)` alone showed last year's teacher as this year's and *deleted* the historical row on reassignment. Any query over a year-scoped fact must carry the year; defaulting it in the service beats trusting every caller.
- **Ask which campus, not just whether.** Assignments were scoped by the *teacher's* campus when the thing being protected is the *section's*, so a campus admin's own class read as unstaffed. **Where two entities each carry a tenant dimension, name which one the rule is about** — and scope reads and deletes identically, or you show a row that cannot be deleted.
- **Name the consequence before the click, and don't auto-repair.** Dropping a subject that has a teacher leaves that teacher assigned to nothing; the UI says so before saving. Silently deleting the assignment would destroy a teaching record to tidy a screen.
- **Empty means "follow the parent", and it must stay empty.** Writing the class's full subject list onto a section would freeze it — the section would silently stop tracking the class as subjects are added. Absence of rows is the inheritance signal (the same reason `section_subjects` needed no backfill).
- **Seed e2e fixtures through the API, never through the UI.** UI-driven seeding made every spec a hostage of whichever screen owned that data, which is why the Playwright suite had been unrunnable since the Setup rework. The UI is what the specs test, not what they are built from.
- **A test suite must not take a singleton seat.** Admitting is `ADMISSION_CONTROLLER`-only with one officer per campus, so an e2e helper that assigned itself the seat would displace the real holder on every run. It fails with an explanation and an env var instead — **a suite may not mutate production-shaped configuration to make itself pass.**

## Staff attendance: presence is self-service, absence never is (added 2026-08-03)
- **Whoever can record attendance can move a salary.** `payroll.absentDays()` counts `staff_attendance` rows straight into the deduction, so self-marking is a pay control, not a convenience feature. The rule: **a teacher may assert their own PRESENCE, never their own ABSENCE, and only for today.** Same family as "whoever creates an employee must never set their pay".
- **Make the dangerous thing unexpressible, not merely forbidden.** `POST /staff-attendance/check-in` takes **no body**: the person is the session, the date is today, the status comes from the clock. Marking a colleague or backdating are not permissions that could be misconfigured — there is no field to carry them. Prefer this over a guarded parameter whenever the shape allows it.
- **Derive what the actor would otherwise choose.** LATE vs PRESENT comes from the server clock. Letting someone self-declare "on time" would be the whole exploit in miniature.
- **Don't make a claim idempotent.** Check-in refuses a second press rather than overwriting: re-pressing must not move the original timestamp, nor turn an office-recorded ABSENT back into PRESENT. Idempotence is right for a *statement of fact*, wrong for a *claim about a moment*.
- **Record provenance on anything that moves money.** `source` (SELF/ADMIN/SYSTEM) + `markedById` paid for itself the day it shipped: an unexpected row on demo was attributed to its real author in one query instead of being guessed at, or wrongly deleted as test debris.
- **Audit the override, not the correction.** Replacing what somebody recorded about *themselves* is audited with their original claim (the row forgets); an ordinary admin-over-admin edit is not. Auditing every keystroke buries the entries that matter — the same reason renames are unaudited.
- **A number computed from a record must freeze when that record is paid.** Attendance for a month with an APPROVED payroll run is refused, or a paid payslip silently disagrees with the register it came from and neither figure can be trusted again.
- **"Nobody said" is not "absent", and the register must start from the PEOPLE.** A query over the attendance table can only return those already marked — the people worth chasing are exactly the ones it omits. `unmarked` is displayed beside `absent` everywhere, never inside it; an absent count over a half-kept register is a reassuring lie.
- **Do not automate a deduction before the data is trusted.** The day-close job that derives ABSENT is deliberately deferred: shipping it alongside the register would create salary deductions in week one from a habit nobody has formed yet.

## Configuration and self-consistent screens (added 2026-08-03)
- **A partial-update DTO is not partial.** class-validator materialises every declared property, so spreading it produces a key for each field the caller never sent — an overwrite wearing a patch's clothes. Strip `undefined` at every level *before* merging, or changing one setting silently resets the rest.
- **Merge settings, never replace them.** One JSON column shared by every feature means a `PUT` from a client that predates a newly-added key resets it to default. Merge, then validate the whole object as a unit so an invalid combination is rejected rather than half-applied.
- **Audit the diff, not the blob.** Record only the keys that moved, with before/after. A dump of the whole object is unreadable a year later, and a write that changed nothing is not an event.
- **A number on screen must BE its filter.** A "Present" tile that counted late arrivals sat beside a PRESENT filter that did not: the page said 1, you clicked, and got nothing. Bind the count and the filter to the same predicate so they cannot disagree; put roll-ups that span predicates in prose, where they cannot be clicked into a contradiction.
- **Name the rule, not the field.** Settings screens say *"a teacher may fill in a missed day up to 7 days later"*, not `attendanceBackfillDays`, and state the consequence (*"anyone checking in after 09:45 is marked late"*) rather than leaving the reader to derive it.
- **Don't expose a switch for behaviour that doesn't exist.** `autoMarkAbsent` is deliberately absent from the settings screen while the day-close job is unbuilt — a toggle that changes nothing is a defect, not a placeholder.

## Names, pages, and debris that grows teeth (added 2026-08-05)
- **A list must carry the names it displays.** Three screens resolved a student's name from a client-side map built out of `/students?pageSize=100`, falling back to `studentId.slice(0, 8)`. Past the first page — i.e. most of a real school — a teacher entering marks and a clerk taking money saw a UUID fragment where a child's name belongs. Fix the projection, not the page size: raising the limit only moves the cliff.
- **Bugs that scale with the customer are invisible in the demo.** This one cannot reproduce on a 40-pupil tenant and is certain on a 400-pupil one. When a screen resolves an id to a label, ask what happens at the size of a real customer, not the size of the seed data.
- **Test debris is harmless until a real metric counts it.** The e2e campus was filed Low and accepted — then G3 shipped and the head's dashboard read "71 registers not marked", 67 of them ours. Anything a suite creates on a shared tenant should be assumed to end up in a number somebody trusts.
- **Clean up by asserting the truth, not by deleting.** The API rightly refuses to delete a class with students, so the teardown *withdraws* the enrolments — which is both permitted and honest ("these students left"), and every polluted metric counts ACTIVE. A teardown that reaches past a product rule to tidy up is a teardown that will one day delete something real.

## Staff & teacher leave — the quota is a pay rule, so it has to be visible and countable (added 2026-08-07)
- **A nav stricter than the API deletes a capability, it does not restrict one.** `/my-leaves` was STAFF-only while `staff-leaves` had always permitted TEACHER, so a teacher could be marked absent but had no way to file the leave that would have made it ON_LEAVE. Third time this exact shape has bitten (CSV import, `/my-attendance`, now this) — when the API admits a role, check the nav does too.
- **Leave days are WORKING days, everywhere.** A Sunday inside a leave range was consuming entitlement and being deducted at `basic / workingDays` — a rate whose divisor already excludes Sundays. A Sat–Mon leave cost three days' pay for two days of absence. One `workingDaysBetween` from `@common` now serves the quota, the balance and payroll; payroll's private copy of the month calendar is gone. **Two calendars is two answers.**
- **`UNPAID` leave was paid.** The quota map has no `UNPAID` key, the lookup returned undefined, and "no quota configured" short-circuited to paid — so the one leave type whose name says it reduces pay was the one that did not. Type UNPAID is now always unpaid, which is what [[#Pay, silence, and settings that are really policies]] already said the rule was.
- **"Unset" is not "zero".** A leave type the school has configured no quota for stays paid and unlimited, and the UI says *No limit set* rather than showing 0 remaining. Reading unset as none-left would have turned every OTHER leave unpaid the day this shipped — a pay cut delivered by an upgrade, which is the same line G5 drew.
- **The quota is consumed in APPROVAL order, and re-decided at approve.** Stamping paid/unpaid only at create let a request filed first but approved second carry a stale answer into someone's salary. Create still stamps, but only so the applicant can be warned; approve is authoritative.
- **A rule that moves pay must be readable before it is applied.** `GET /staff-leaves/balance` exists because the quota was invisible: it silently flipped a request to unpaid and the person found out on their payslip. The same endpoint prices a *proposed* range, so the warning the applicant sees is produced by the same function that stamps the real thing — the browser deliberately owns no copy of the school calendar.
- **Approving now settles the register.** It used to change nothing payroll could see: a day already marked ABSENT stayed ABSENT and `absentDays()` counts exactly those rows, so the medical certificate that arrives next morning still cost a day's pay. Approval converts ABSENT → ON_LEAVE, and refuses three things — it never fabricates a row for a day nobody recorded, never overwrites PRESENT/LATE/HALF_DAY, and never touches a month whose payroll is APPROVED.
- **`> 0` is not a test of an amount.** The existing payroll test asserted `attendanceDeduction > 0`, which is equally true of the right answer and the wrong one; the working-day bug lived under it happily. The replacement asserts the day count and the rupee figure.

## Students do not apply for their own leave (added 2026-08-05)
- **Decision: there is no student-facing leave feature, and that is deliberate.** A parent tells the class teacher; the office writes it down. That is how a Pakistani school actually works, and the child is not the party making the request. Guardians have no logins either, so there is no self-service path for leave at all — by design, not omission. Filing is OWNER_ADMIN / CAMPUS_ADMIN / TEACHER; approving is admin-only, because a teacher who could approve the leave they filed would be approving their own request, and an approved leave LOCKS the attendance row.
- **The permission matrix cannot speak for STUDENT.** It seeds six roles and STUDENT is not one, so adding `'STUDENT'` to a `@Roles` list changes nothing there. Anything that must be denied to a student needs a real student session in `student-portal.e2e`. Worth knowing before trusting a matrix row to cover it.
- **Verify a guard by removing it.** Adding `'STUDENT'` to the leave decorator left all 461 tests green — the request got past the guard and was refused by the service's guardian check instead. The comment on that check ("the only thing standing between a non-admin caller and another student's record") turned out to be exactly right. **A test that passes when you break the thing it names is not testing that thing** — neuter it and watch it fail, or the coverage is a guess.
- **Pin the behaviour, not the decorator.** The surviving test asserts *a student cannot file leave*, which stays meaningful however the layers are arranged. It fails only when both layers are gone — which is the property actually worth protecting.
- **Assert the error CODE on a 403.** A CSRF failure and a role denial are both 403; a test accepting either proves nothing about roles.

## Pay, silence, and settings that are really policies (added 2026-08-05)
- **The time limit was never the hole — the silence was.** Staff attendance has no backfill floor and keeps none: schools genuinely correct last month's register. What was wrong is that an admin editing *another admin's* months-old row left no trace, while overwriting a self check-in was audited. Before adding a restriction, ask whether the real gap is a missing *record* rather than a missing *rule*.
- **Audit the reach, not the keystroke.** The new entry fires on edits into a **closed month** — coarse on purpose, because payroll is monthly. If the current month also logged, routine register-keeping would bury the entries that matter. A signal only means something if the ordinary case stays quiet.
- **A rule the code always applied is not a decision the school ever made.** Payroll always deducted for absence. That is a legitimate policy, and so is not deducting — but it was invisible and unchangeable. When you find behaviour that a customer would reasonably want to differ on, the fix is a setting with a default that preserves today's behaviour, not an argument about which is right.
- **Record the rule on the artefact, not just in the config.** `deductForAbsence` is written into the payslip breakdown. A payslip showing 3 absent days and no deduction is otherwise indistinguishable from a bug six months later.
- **Say what a setting does NOT do.** This one governs absence, not unpaid leave, and it applies only to payroll generated afterwards. Both would otherwise be discovered as "the setting is broken".
- **Test around idempotence, not through it.** Payroll runs are idempotent per (campus, month, year), so flipping a setting and re-running the same month returns the cached run and proves nothing. Two campuses, same month, one flip — the shape of the fixture had to change to make the property observable at all.
- **A nested settings group has a cost.** Adding a third `z.object({...})` to the settings schema pushed the Prisma client past its type-instantiation depth and broke an unrelated file. Flat keys where the grouping is only cosmetic.

## Clocks (added 2026-08-05)
- **"What time is it" is a question about the SCHOOL, not the server.** Every timing rule compared a stored `HH:MM` against `Date#getHours()`, which is right only while the whole fleet sits in the server's zone — and wrong *silently* otherwise, with nothing in the output hinting which clock was used. One setting, one helper, four call sites.
- **Format, never arithmetic on offsets.** `Intl.DateTimeFormat` with a `timeZone` makes DST the runtime's problem. A hand-rolled `+05:00` is wrong half the year in any zone that observes it — pinned by a test that checks Europe/London in both January and August.
- **`hour12: false` is not `hourCycle: 'h23'`.** The former yields `"24"` at midnight in some locales, which sorts *above* every deadline and makes a just-past-midnight tick look like the end of the day.
- **Split the migration-shaped half out rather than half-doing it.** The clock comparisons were a helper swap; the *day boundary* (every `@db.Date` built as UTC midnight) touches every date column, every `startOfDay` and every report that groups by day. Fixing it badly would silently re-date existing records, so it is now G4b with its own entry — a partial fix that says what it did not do beats a whole one nobody can review.
- **Tests that read the wall clock pass or fail by when they run.** Both the timezone unit tests and the day-close block pin a fixed instant or an explicit setting. The integration test proves the *wiring* differently: same moment, same setting, two zones, two answers.

## Surfacing vs policing (added 2026-08-04)
- **Some rules are enforced socially, and the software's job is to make the gap visible — not to block or punish.** A class register has no deadline the system should enforce: the head chases the teacher. So the mark-by time changes *when the head is shown the gap* and nothing else. Say so on the settings screen, too — a setting that looks like enforcement but only moves a dashboard is worse than no setting.
- **Don't complain before the thing is late.** Nagging at 08:05 about a register for a lesson that hasn't happened is how a warning becomes wallpaper and gets ignored on the day it matters.
- **Never invent the missing record.** Auto-marking present manufactures attendance nobody witnessed, and it feeds report cards; auto-marking absent texts parents whose children were in class. An unmarked day stays an honest gap — the same conclusion the staff register reached from the payroll side.
- **A metric over partial data is a lie in the reassuring direction.** `todayAttendancePercent` read **100%** on a live tenant with 9 of 17 students marked. Coverage now travels beside it, never folded in: folding makes a different lie (a half-marked school is not "50% attendance"), hiding leaves the flattering one. **This is the second time this exact rule had to be applied — it is a checklist item for any average, not a one-off fix.**
- **A chip must land somewhere you can act.** "5 registers not marked" links to the page that *names* the five and puts each one click from being marked. Pointing at a screen where you still have to go looking is barely better than not telling anyone.

## Receipts, and seams that refuse (added 2026-08-04)
- **A receipt is a view, not a file.** Rendered on demand from the payment and the invoice around it, because both move afterwards — a later instalment changes "still outstanding", a reversal voids the thing entirely. A PDF frozen at the moment of payment quietly starts disagreeing with the ledger it came from.
- **Refuse a receipt for reversed money.** Handing someone a clean-looking document for a payment that has been reversed is how a receipt stops meaning anything. The refusal names the receipt number so the conversation at the counter is possible.
- **Show what is still owed, not just what was received.** A receipt that states only the amount taken leaves the payer to work out whether they are square, and they will assume they are.
- **A bill without its receipts is half an answer** — and the half that starts the phone call. `/portal/fees` returns payments alongside each invoice, and a reversed one stays visible saying so rather than vanishing from a family's history.
- **A stub must refuse, not half-work.** The aggregator seam verifies its signature, resolves the tenant and guards replays — then returns **501**, because writing the payment needs an actor that does not exist yet. An endpoint that silently accepts and does nothing is worse than one that says no: somebody will believe it works.
- **Never let an unauthenticated caller choose the actor.** The obvious way to finish that seam is to read `collectedById` from the webhook body. That is a stranger naming who collected money. The same instinct that kept a fabricated actor out of the audit log applies here — and both point at the same real answer, a service account, which is a product decision rather than something to invent under deadline.
- **Fail closed on missing configuration.** No aggregator secret means no school is integrated, so every call is refused. The alternative — treating "unsigned" as acceptable when unconfigured — is how a seam becomes a hole the day it ships half-configured.

## A public write surface: the guardian fee link (added 2026-08-04)
- **When there is no session, the token has to carry every check a session would have.** Bound to one invoice, signed, expiring, tenant-resolved from the Host rather than from the token itself. The narrow authority is the feature: a link that could name its own invoice would be a link to every invoice in the school.
- **One error for every rejection.** Bad signature, expired, wrong tenant, feature switched off — all the same 404. Helpful distinctions on a public endpoint are an oracle, and the legitimate reader does the same thing in every case (ring the office).
- **Reuse the hardened path for the surface strangers reach; never build it a simpler one.** The guardian upload goes through the same MIME allowlist, quarantine prefix, magic-byte check and virus scan as every authenticated upload, and the object is promoted *as part of* the write, so no row can point at an unscanned file.
- **Rate-limit on both axes or neither works.** Per-token alone is beaten by collecting tokens; per-IP alone by spreading across addresses.
- **Don't invent an actor to satisfy an audit column.** `AuditLog.userId` is non-null because that table answers "who did this"; for a tokenised submission there is no who. The claim row is the record, and the step that matters — verification — is audited against the real person. **A fabricated actor is worse than an absent one.**
- **Neither the config nor the request knows the whole URL.** The tenant host comes from the request; the browser-facing port only the deployment knows. Composing a user-facing link from one source alone produced, in turn, the wrong port and then the API's own origin.
- **A page that compiles is not a page that renders.** `params` typed as a `Promise` and read with `use()` — the Next 15 shape — passed `tsc` and crashed on Next 14 the moment a browser loaded it. Framework-version mismatches live exactly in the gap that types do not cover.

## Deadlines, and who the machine speaks for (added 2026-08-04)
- **A time that governs every tenant governs none of them correctly.** One fleet-wide 20:00 day-close meant a morning school waited seven hours and a teacher who arrived late could not check in at all. The shape that works: the rule is per school, and the job becomes a frequent tick that asks *"is it this school's hour yet?"* — which is only safe because the job never touches a row that exists. **Idempotence is what buys you the right to run something often.**
- **Say who decided.** *"You are already marked ABSENT today"* is an accusation when a cron wrote the row. Any message about a machine-made record should name the machine and the remedy — the person cannot fix it by pressing harder, only by talking to the office. Provenance (`source`) had already been recorded for this exact reason; the message simply wasn't reading it.
- **A status colour is a claim.** An absence rendered as a green `badge ok` because the badge was chosen by "we have a row" rather than by what the row says. Bind the colour to the meaning, not to the presence of data.
- **State a deadline while it can still be met.** The close time is returned to the check-in screen so it can say *"check in before 20:00"*. A rule the user meets by accident and discovers by failing is not a rule they were ever given.
- **A test whose result depends on the wall clock is not a test.** The day-close block had to pin `closeAtTime: '00:00'` — without it, the same code passes in the evening and fails in the morning. When behaviour becomes time-dependent, every existing test of it acquires a hidden input that must be made explicit.

## Authorization: the read is the half that leaks (added 2026-08-04)
- **A guarded write does not imply a guarded read.** Four fee reads shipped with no `@Roles` beside writes that were all correctly `OWNER_ADMIN` — and that is precisely what hid them, because the module *looked* guarded. When adding an endpoint, decide the read's audience explicitly; it is never "whoever can see the write, minus the risk".
- **Severity belongs to the hole, not to the endpoint someone happened to notice.** F8 was filed Low-Med as "fee prices are readable" and closed as High: the same unguarded batch included `GET /discounts?studentId=`, which returns a named child's hardship/staff/sibling concessions to any authenticated session, classmates included. **Re-rate a gap when you open it, rather than inheriting the reporter's guess.**
- **The permission matrix only covers what has a row.** It is the merge-blocking proof and it proved nothing here, because the rows tracked the writes. A route with no row is not "assumed safe", it is unmeasured — the same lesson as *an endpoint nobody calls is not a shipped feature*, one layer down.
- **A stale test is a broken gate.** `classes-ux` had been red because the demo tenant grew a second campus, making "Choose a campus first." the *correct* answer to a spec that never picked one. A suite carrying a known red cannot be used to judge the next change — which is exactly when a real regression walks in unnoticed.

## Test infrastructure: the shared queue (added 2026-08-04)
- **Three copies of a helper is three copies of every bug in it.** `drainSms` was hand-copied into the attendance, exams and fees specs. The same two defects were then fixed *one copy at a time*, over separate sessions, each fix looking like it had solved the problem until the next spec's turn came round. Now one function: `test/integration/support/sms.ts`.
- **The `sms` queue is shared across the whole Redis instance, so a test helper does not own what it reads.** Draining "all jobs" and forcing the calling spec's `schoolId` onto each re-attributes another tenant's message to this school, corrupts both specs' log assertions, and deletes the job out from under whoever queued it. Filter to your own jobs; dispatch each under **its own** `schoolId`, the way `sms.processor.ts` does.
- **Distinguish a fact about the product from a fact about the machine.** A job locked by another worker made three suites red while nothing was wrong with attendance, exams or fees. Cleanup of state you don't own is best-effort — assert on the product, tolerate the environment. (The real guard against a live worker double-dispatching is `support/no-worker.js`.)

## Cover: the same NULL rule is a feature and a bug (added 2026-08-10)
- **`@@unique([sectionId, date, periodNo])` does not do what it reads like.** `period_no` is NULL for whole-day cover, and **Postgres treats NULLs as distinct in a unique index** — so both rows insert and two people quietly hold the same register. Two partial indexes (`WHERE period_no IS NOT NULL` / `IS NULL`) are what actually make it unique. The *same* behaviour is deliberately relied on for `fee_invoices.psid`, where distinct NULLs are the point. **The rule is not "NULLs are fine" or "NULLs are dangerous" — it is that a nullable column in a unique key always needs the question asked.**
- **Adding cover changed the shape of an authorization question, not just its answer.** `assertCanMark` had no `date` parameter because a `TeacherAssignment` is not dated. Cover is dated by nature, so "may this person mark 9-A?" became "may this person mark 9-A **on the 10th**". When a new concept is dated and the check it feeds is not, the check is the thing that has to move.
- **A permission grant is not a scheduling record.** Recording cover hands one teacher write access to another class's register, backdatable, on data that feeds pay. That is why it is audited with *names*, refused into an APPROVED payroll month, and kept away from TEACHER entirely — if the person who benefits could issue it, the boundary would not exist.

## The teacher shell: role decides the shell, width decides the layout (added 2026-08-11)
- **A rule that matters should be written down, not implied by an array's order.** Whether someone got the teacher app was `primaryRole(roles)?.role === 'TEACHER'` — the answer fell out of the ordering of `ROLE_INFO`, a list written for a different purpose, in which TEACHER sits **7th**. Every teacher who also kept the books, ran admissions or did HR was silently excluded from the app built for them, on a phone as well as a laptop. Nobody chose that; it was a side effect of a sort order. → [[Teacher App Shell Plan]]
- **A breakpoint is not a role.** Deciding the navigation by screen width handed one person two different products: four destinations on a phone, the administrator's eight in three groups on a laptop, with **`/home` in neither the sidebar nor reach** — a teacher landed there and could only get back with the browser's back button. Ask *who is this* once; let width decide only the arrangement.
- **"More room" is a reason to make things bigger, not to invent a second information architecture.** Both attempts to enrich the desktop — hoisting secondary screens into the sidebar, adding desktop-only cards — were rejected on the same ground. Width changes the arrangement; it never changes the content.
- **A UI that says "something needs doing" while the system knows exactly what is a UI that has thrown the answer away.** The home read *"A register needs marking"* over *"No timetable has been set for you yet"* — while the code one line earlier had computed the list of registers and reduced it to a count. Check whether the caller is discarding the specific thing before writing the vague sentence.
- **Distinguish "nothing to do" from "nothing assigned" — they arrive identically as an empty list.** Deriving "does this teacher have classes" from a list of *unmarked* ones made the good-news branch unreachable: a teacher who had just finished marking was told *"No timetable has been set for you yet."* Both branches type-checked and both rendered; only a browser found it.
- **Cleanup must never be the loudest thing in a failure.** A `finally` that throws after a test has already failed gets reported *instead of* the assertion — `browserContext.cookies: Target page has been closed` while the real cause sat one line above. Likewise `waitForURL` burns the whole timeout and says only "timeout"; `toHaveURL` fails in seconds with **"Expected /home, Received /dashboard"**. When a test breaks, the failure has to name the thing that is wrong.

## Campus guards asked about the caller, never about the pair (added 2026-08-11)
- **Every campus check in this codebase answers "may *you* touch this?" — and an owner always may.** `assertCampusAccess` takes the *caller*, so on a write that links two campus-bound things (a teacher and a section) it validated each end against the person clicking and never against **each other**. An owner could assign a campus-A teacher to a campus-B class, put them on that timetable, or hand them cover there. It saved; the teacher's home then said *"Mark 9-A"*; and attendance refused them with *"Resource belongs to another campus"* — **the system instructing somebody to do a thing it would then block.**
- **A permission check and an integrity check are different questions, and one does not imply the other.** `assertSameCampus(personCampus, resourceCampus, label)` is now a separate rule used by `/teacher-assignments`, `/timetable/slots` and `/cover`. It returns **422, not 403**: nobody's permissions are at fault, the *pair* is invalid — the same category as "Section does not belong to class".
- ⚠️ **A teacher belongs to ONE campus and may only teach there — operator decision, 2026-08-11, and it REVERSES an earlier one.** `class-structure.e2e` carried a case asserting *"a campus admin sees an assignment on their OWN section even when the teacher sits in another campus"*, written when scoping by the *teacher's* campus was hiding rows from the admin who owned the section. That fix was right about the scoping and wrong about the premise. With cross-campus assignment now refused, teacher campus and section campus are always equal, the two scopings are indistinguishable, and that case can no longer be constructed — so it was rewritten to the half that still has meaning rather than deleted quietly. **A test that encodes a decision is evidence, not an obstacle: when a change breaks one, find out which way the decision should go before touching either.**
- ⚠️ **A test fixture that only works because of a bug is a bug in the test.** The Cover C4 campus fixture assigned the away teacher to a section at the *far* campus so the away-list filter had something to leak. That assignment only ever succeeded because this hole existed; fixing it broke four tests. The fixture now uses a teacher **of** that campus, which tests the same filter legally. **When a fix breaks a fixture, check whether the fixture was exercising the defect before you weaken the fix.**

## The e2e suite was writing to the product it was testing (added 2026-08-12)
- **A test fixture that is never removed is a feature the operator did not ask for.** Every Playwright run minted `Cls<timestamp>` — the demo tenant reached **185 fixture classes against 3 real ones**, plus **64 fee heads of which 33 were `Tuition <timestamp>`**. It was tolerated for months on the grounds that it sat "in a campus nobody looks at", which stopped being true the moment Cover and student-Move began listing every class in the school: the operator's class picker was 98% debris. **Nothing enforced a ceiling because nothing could — the count grew with how often the suite ran, not with how much was built.**
- ⚠️ **Freshness was doing the isolation work, silently, and reuse removed it.** Switching to one reused class turned four green specs red at once: the exam roster loaded a neighbour's child, the move spec found its old section still occupied, and the fee specs read totals and batches their neighbours had left. None of those specs *said* they needed a private class; they got one for free every run and were written against it. **Before making a fixture shared, ask what each test would assert if somebody else had used it first.** The shape that works is one stable class **per spec** — isolation kept, count fixed at nine instead of growing by one per run.
- **Reuse and destructive mutation cannot share a fixture.** `classes.spec` renames the subject, adds another and rewrites what a section studies, then deletes the class in a `finally`; `fee-plan.spec` deletes its class outright. Those two keep a per-run `scratch` class — which is fine *precisely because it is deleted*. **The 185 leaked classes came from timestamped names that nothing ever removed, not from timestamps as such.**
- ⚠️ **Some records must not be swept away, and that is the constraint the design has to bend around.** There is no DELETE for an invoice or a batch, by design, and `createBatch` returns early for a (class, month, year) it has already billed — so a reused class re-billing the current month leaves that run's child with **no invoice at all**. Both fee specs now walk forward to a month the class has never billed. Student removal follows the same rule the product enforces: the teardown mirrors `softDelete` and **refuses to touch a child carrying payment or certificate history**, so ~2 per run legitimately remain.
- **Assert about your own subject, not about the population around it.** `expect(old.data).toHaveLength(0)` was a statement about the tenant; it held only while every run got a brand-new section. Three specs had this shape — the worst was `fee-guardian-link`, which picked *the first unpaid invoice in the whole month* and could mint a guardian link for a child it never created, then assert that the page hid that stranger's name.
- **Read the response, not the toast.** A loop that decided "did this generate?" from `.toast.ok` matched the toast still on screen from the previous iteration, so a month that had just been billed still looked unbilled — it silently billed **three** months in one run. `waitForResponse` on the POST answers exactly the question asked.
- ⚠️ **"Wait for the spinner to go" does not close a loading race — it also passes before the spinner appears.** `expect(getByText('Loading…')).toHaveCount(0)` was added as the fix for exactly this race and did not fix it: a fetch that has not started reads as a finished empty one. Wait for the settled outcome (`rows.first().or(emptyNote)`). It only surfaced once the tenant grew big enough to make the request slow — **the debris was hiding a real race, then revealing it.**
- **Two consecutive green runs is the acceptance test for a reusable fixture, not one.** Every defect above except the first survived a green run and appeared on the second. Classes, sections and fee heads now hold flat across runs.
- ⚠️ **A test that breaks because the app said the right thing twice is the test's bug.** The class row menu hides "Move earlier" for a class with no neighbour — correct — and the spec had only ever passed because the tenant was full of fixture classes so the first card always had siblings. Likewise the closure banner now legitimately renders in both the shell and the "Staff today" card.

## The rate limiter was off, and nothing said so (added 2026-08-12)
- **"No `dotenv` import anywhere" was literally true and completely misleading.** It was read for three days as "`.env` is probably never applied". The project ships **its own** loader — `loadDotenv()`, called on the first line of `bootstrap()` in both `main.ts` files — so `.env` is read deliberately, and it sets `RATE_LIMIT_ENABLED=false`. (Requiring `@prisma/client` populates `.env` too, which is worth knowing and was *not* the path here.) **Searching for a package name answers a question about wiring; the question was about a value. Print the value.**
- **"It isn't denying" and "it never ran" are different failures, and Redis distinguished them for free.** The sliding window writes a key per request it counts. **Zero `rl:*` keys after six hours of traffic** proved the guard was short-circuiting on its first line, which ruled out every theory about Lua, windows, IP resolution and policy selection at once. **Look for the cheap observation that partitions the hypotheses before testing any of them.**
- **Measure both directions on the same build.** Flag off: 8 bad logins → 8 × 401. Flag on: 1–5 → 401, **6–8 → 429**, both rules keyed. That is what turns "the limiter does not fire" into "the limiter is correct and disabled" — two very different bug reports.
- **Closed by making the unsafe state unbootable, not by documenting it.** `validateEnv` now refuses to start when `NODE_ENV=production` and the limiter is off, naming the variable and the remedy in the crash message; `docker-compose.prod.yml` pins `RATE_LIMIT_ENABLED: 'true'` in its `x-app-env` anchor (which wins over `env_file`), so the server is protected whatever `.env` says; `.env.example` documents the flag. **Local dev keeps `false` — the point was never to force it on everywhere, it was that a server should not be able to run without it by accident.**
- ⚠️ **A schema default only protects the case where the key is missing.** `RATE_LIMIT_ENABLED: z.string().default('true')` reads as a safe default, and `docker-compose.prod.yml` then passes `env_file: .env` with an anchor that never sets the variable. A dev `.env` copied to a server makes the key **present and false**, the default never applies, and the deployment silently serves unlimited login attempts. `.env.example` does not mention the variable at all. **A security control that can be switched off by a file nobody is prompted to fill in is off by default in practice, whatever the schema says.**


## The accountant became a campus seat (added 2026-08-12)
- **An accountant was already per-campus and could never have been school-wide** — `UsersService` refuses one without a campus, and `restrictedCampusId()` returns `null` only for `OWNER_ADMIN`, everyone else falling back to `NO_CAMPUS` (the nil UUID) which matches nothing. **The question "should accountants be per-campus?" was already answered by the code; what was missing was "how many per campus".** Operator's call: one. → [[Finance Roles Plan]]
- ⚠️ **A rule with two enforcement layers is under-scoped if you only plan one.** The comment above `SOLE_CAMPUS_SEAT_ROLES` says the seat is enforced *"in the service on every write path AND by a partial unique index per role"*. The plan called F0 a one-line list change; it needed a third index too. **When the code documents its own belt and braces, read it before estimating.**
- **The probe showed the layers do different jobs.** With `ACCOUNTANT` removed from the seat list the second accountant still did not get in — the case failed with **500** rather than 201, because the index refuses the row alone. **The index is the safety, since a service check is read-then-write and two owners assigning at once both pass it; the service check is what turns a constraint violation into a 409 naming the incumbent.** Neither is redundant, and a probe that only asked "does it still fail?" would have missed the distinction.
- ⚠️ **A one-per-campus seat costs something real at the counter, and it was priced before shipping.** Only `OWNER_ADMIN` and `ACCOUNTANT` may take a payment, so a campus now has exactly one non-owner cashier and a single queue in the first days of a fee month. Accepted deliberately: the point is that a drawer shortfall has one name against it. If it bites, the answer is a collect-only `CASHIER` seat, **not** a second accountant — which would remove the accountability the rule exists for.
- **The index is stricter than the check, and that is the right way round.** `assertSoleCampusSeat` runs only on writes, so an existing tenant with two accountants keeps them until someone edits one — but `CREATE UNIQUE INDEX` fails outright while both rows live, taking `db:setup` with it. **A duplicate seat should be resolved deliberately by a human, not silently by a migration picking a winner.**
- **The absence of a row was carrying information nobody could see.** The campuses screen hid a role group with no members, so an unfilled seat rendered as *nothing*. Making empty seats render — *"Not assigned. Nobody but an owner can take a fee payment here."* — revealed that **neither campus on the operator's own tenant has an accountant**. A blank space cannot be read as a gap; **if an empty state means something is wrong, it has to say so.**
- ⚠️ **A backend change that moves an invariant needs the browser suite run, not just the API one.** Making the accountant a seat invalidated the premise of a Playwright spec that had picked `ACCOUNTANT` precisely *because* it was not a seat — and only jest was re-run, so nothing said so. It would have kept passing until a cleanup failed. **A comment that justifies a choice by a rule living elsewhere goes stale silently when that rule moves.**
- **A role nobody has asked for is not a feature.** `FINANCE_VIEWER` — a school-wide read-only finance seat — was planned and then dropped on the operator's call: *"the data is already being seen by owner admin on his dashboard."* The gap it addressed (delegation of the 36 owner-only endpoints is all-or-nothing) is real but **unfelt**, and building a role, migration, matrix rows and a read-only UI for nobody would have been the same mistake as *an endpoint nobody calls is not a shipped feature*. The signal to revisit is an operator granting `OWNER_ADMIN` purely so somebody can *see* both campuses.

## `next build` could not run on Windows at all (added 2026-08-12)
- **The web app could not be built on the machine it is developed on**, and had been in that state long enough that nobody noticed the deploy artifact was untested locally. `output: 'standalone'` traces dependencies by creating **symlinks**, which Windows permits only to an administrator or with Developer Mode on — so `next build` died with `EPERM: operation not permitted, symlink` **after** compiling, type-checking and generating all 42 pages. Everything that matters had already succeeded; only the copy step failed.
- **Skipped on win32 rather than solved, because there is nothing to solve.** The standalone bundle is consumed *only* by the Linux container image (`apps/web/Dockerfile` copies `.next/standalone`), so a Windows developer producing one has no use for it. CI and Docker are unaffected — they are Linux, and the flag stays on. `NEXT_STANDALONE=1` forces it for anyone who does want it. **Verified in both directions rather than assumed: the config reports `undefined` by default here and `'standalone'` when forced.**
- ⚠️ **`next build` breaks a running `next dev`, full stop — and the "only a FAILED build does" refinement was WRONG.** Both write `.next`. The first symptom was an EPERM crash leaving it half-written and the dev server serving 500s; a clean build afterwards appeared harmless, so the rule was narrowed to "the hazard is a half-written build". **A later successful build broke it again**, this time as `404` on **every** `_next/static` chunk (`main-app.js`, `app-pages-internals.js`, `layout.css`): pages still server-rendered, so they *looked* fine, but no client JS loaded and every button was inert. The whole Playwright suite failed at sign-in — including the platform setup on a page that had not been touched, which is the clue that said "not your refactor". The earlier survival was luck (the dev server had recompiled on demand), not a rule. **Never run `next build` against the `.next` a live `next dev` is using; the fix is stop, delete `.next`, restart.**
- **The symptom pointed away from the truth twice, and only evidence resolved it.** A filled login form that does nothing on click reads as "my login refactor broke", then as "cold compile after a build" — both plausible, both wrong. `curl` through the same proxy returned **200 in 0.13s**, which cleared the backend; capturing the browser's console and network showed the 404s and ended it in one run. **When a UI does nothing, ask what the page actually loaded before theorising about the code.**

## ⚠️ Account lockout had never fired — the request transaction rolled it back (found AND fixed 2026-08-12)
- **`TenantTransactionInterceptor` opens ONE `$transaction` per request, and a failed login throws — so `registerFailure()`'s write is rolled back with everything else.** `failedLoginCount` never rises and **§22.3 lockout (10 attempts → 15-minute lock) has never once fired in a running system.** Proven by a control test on the untouched `/auth/login` path, not inferred: a wrong password leaves the counter at 0. → [[Owner Login Plan]]
- **This is the second inert security control found in two days**, after the §29 rate limiter. Both were implemented, both read correctly, neither had ever run. **The common cause is not carelessness — it is that both were tested for their logic and never for their effect.** The limiter had unit tests for the sliding window; lockout has *no* test at all, which is why nothing said so.
- ⚠️ **"Write, then throw" is a rollback in disguise, everywhere — not just here.** Any code that records something *about* a failure and then raises will lose the record if a transaction wraps the request. The pattern needs a connection outside the request transaction, and the audit of a refused action has exactly the same problem.
- **Fixed by giving failure-path writes a transaction of their own** — `TenantPrismaService.outsideRequestTransaction()`. ⚠️ **A plain non-transactional client is not a substitute:** outside a transaction there is no `set_config('app.current_school_id')`, so RLS matches nothing and the write silently affects **zero rows** — failing closed, and just as invisible as the rollback it replaced. The helper opens a real tenant transaction on its own connection, GUC and all, and because `AuditService` resolves its client from CLS, running the audit inside the helper puts that row in the durable transaction too.
- ⚠️ **The lock self-heal had to move with it, or the fix deadlocks itself.** That branch writes the user row in the OUTER transaction; `registerFailure()` then waits on that row from its own transaction while the outer waits for the handler to return — a self-deadlock that unwinds only when the 20s budget expires. **Never write a row out-of-band that the request transaction has already written.**
- **The missing test is the actual lesson.** §22.3 lockout had **no test at all** — not a weak one, none — which is exactly how a rolled-back write survived in `main`. There is one now: ten wrong passwords must leave the account `LOCKED` and refuse an otherwise-correct password. Probing it (putting the write back inside the request transaction) fails it along with the two door tests.
- **The discovery came from a control test, not from the feature.** The owner-door work asserted "a wrong-door attempt increments the counter", it failed, and **the tempting read was "my new code is wrong"**. Running the same assertion against the *existing* wrong-password path is what turned a suspected local bug into a systemic one. *When a new test fails, check whether the old path passes it before assuming the new code broke something.*

## Two sign-in doors, and what it cost to close the second one (added 2026-08-12)
- **A "separate" door the owner need not use is a label, not a boundary.** O0/O1 gave the owner an entrance nobody else could use; only O2 — closing `/login` to owners — made the two mutually exclusive. The half that is easy to ship is the half that proves nothing. → [[Owner Login Plan]]
- ⚠️ **34 of 36 integration suites failed the moment the staff door closed** — 868 of 910 tests — because every one of them signed in as the provisioned owner through a hand-rolled `login()` wrapper. **Flipping the rule first and reading the failures was faster and safer than grepping for call sites**: the compiler and the suite between them named every one, and a missed edit fails loudly.
- **The fallback in the test helper is a deliberate trade, not laziness.** `loginAs(…, 'auto')` tries the staff door and falls back to the owner's, so ~34 suites did not each need a hand-edited door argument — whose failure mode is *silent* (a wrongly-edited call site keeps passing while exercising the wrong door). The objection — a fallback would mask a regression that reopened the staff door to owners — is answered by asserting the boundary in **exactly one place** (`auth.e2e-spec.ts`) rather than relying on 34 incidental ones. **Infrastructure in the helper; assertion in the spec that owns it.**
- ⚠️ **A conformance harness can only measure what it can drive.** O3 called for permission-matrix rows on both doors, citing *"a route with no row is unmeasured"*. It was wrong here: the harness drives rows with a **session cookie** and asserts 403, while a login route is `@Public()`, takes credentials, and refuses with **401 indistinguishable from a wrong password**. A row would have asserted nothing while looking like coverage — **worse than the gap it closes**. The rule survives, the instrument changes: measured directly in `auth.e2e-spec.ts`, with a note in `permission-matrix.ts` where a reader would look for the missing rows.
- **The blast radius reached beyond the tests, which is the part a grep of `test/` would have missed.** `scripts/load-fees.mjs` defaults to `owner@demo.pk` and would have failed at sign-in on its next run; the Playwright helper's default session had to move to the owner door; and the dev prefill on `/login` was handing every developer the one credential that door now refuses.

## `/login` cannot be a door once the doors are exclusive (added 2026-08-12)
- ⚠️ **The redirect target and a sign-in form cannot be the same page.** `/login` is where every 401 and every logout sends people, and where the per-campus links point — and at that moment the visitor is **signed out, so nothing knows their role**. With mutually exclusive doors (O2), whichever form sat there would refuse somebody on every session expiry: a signed-out owner, bounced onto the staff form, refused by a message that deliberately explains nothing. `/login` is now a **chooser**; the doors are `/staff-login`, `/owner-login`, `/student-login`. → [[Owner Login Plan]]
- **A route name that is one word from another route's meaning is a hazard, not a style question.** `/school-admin/login` was proposed for the owner and dropped: `/admin/login` is the **vendor console** — a separate `PlatformUser` table with no RLS, its own cookies, its own JWT type. The two would be confused in a runbook or a firewall rule, and the blast radius is a different identity system.
- **Keep one grammar across sibling routes.** `/x-login` and `/x/login` in the same set invites a guess and a 404.
- **Name a door for everyone who uses it.** "Management" excluded the teachers and office staff who are most of that door's traffic; `/staff-login` says who it is for.
- ⚠️ **Renaming silently weakened three test guards, and only reading caught it.** They waited with `!pathname.startsWith('/login')` — true immediately at `/staff-login`, so the wait would have passed **before the form was submitted**. A prefix check against a route family breaks the moment a sibling stops sharing the prefix.

## An offset is not an ordering (added 2026-08-13)
- ⚠️ **"Karachi is five hours ahead, so its clock reads later" is false for five hours a day.** After 19:00 UTC, Asia/Karachi has rolled past midnight and reads **00:xx — earlier in the day than UTC's 19:xx**. A test that placed an attendance deadline just past the UTC clock and expected the Karachi tenant to be "already past" therefore inverted every evening. **Once a date boundary sits between two zones, the offset tells you nothing about which wall clock is larger.** The fix sorts the two zones by their actual `HH:MM` and places the deadline between them, whichever way round they happen to be.
- ⚠️ **A test asserting timezone correctness must not compute its own dates in UTC.** The closure case created a holiday for `new Date().toISOString().slice(0,10)` — the SERVER's date — while `closureNotice()` resolves "today" in the school's zone, correctly. After 19:00 UTC the holiday was yesterday's from the tenant's point of view, the endpoint returned `closure: null`, and **the failure read as "the closure notice is broken" when the test was the thing on the wrong clock.** It now reads the timezone from the tenant's own settings rather than hard-coding it, so it cannot drift from the fixture.
- **Both were tests, not product — and that was established before touching anything**, by reading `closureNotice()` and `isPastLocalTime()` (both correct) and by stashing every local change to confirm the same two failed on a clean tree. ⚠️ **I had already told the operator this was "a real latent bug in the closure/deadline handling". It was not**, and the correction mattered: the product had the harder half right all along.
- **Green at one hour is not green.** The corrected test only exercises the ordering the current clock produces. It was proved general by swapping the zone pair for one that reads *later* than UTC right now (`Europe/Moscow`) and re-running — **both branches pass at the same instant**, which is the closest thing to time travel the suite allows.

## A token is not a colour, it is every pair sitting on it (added 2026-08-15)
- ⚠️ **Changing one background token broke contrast on every screen at once.** `--muted` `#6b7280`
  measured **4.51** on the old `--bg` `#f6f7f9` — it cleared the 4.5 floor by one hundredth. The
  retheme moved `--bg` to `#eef2f8` and the same pair fell to **4.30**. Nothing else changed.
  **A background token change is a contrast change to every pair painted on it**, and a value
  sitting on the threshold is not passing, it is waiting. Replacements are now chosen with headroom.
- **On a dark fill the grey ramp inverts.** `#64748b` is a muted colour *for light backgrounds*;
  on the navy sidebar it measured **3.28** and had never been legible. Pick from the light end.
- ⚠️ **`--brand` lives in four places and only one of them is CSS.** `globals.css`, `layout.tsx`
  `themeColor`, and `app/manifest.ts` `theme_color`/`background_color` — the manifest is generated
  in TypeScript and **cannot read a custom property**. U0 moved the token and left the manifest, so
  the *installed* app wore the previous identity on the Android status bar and splash: the single
  most framing surface in the product, behind by one version, with a green suite.
- **Audit contrast by computing rendered pairs off the live DOM**, walking up to the first opaque
  background and compositing alpha on the way — not by reading the token table. The token table
  cannot see `.chip.active .badge`, which is white on 25% white over navy.
- **A stylesheet class vocabulary that tests assert against is a public API.** 71 Playwright
  references decided this was a retheme rather than a Tailwind migration. New classes go *alongside*.

## A test can be wrong about the world, not just about the code (added 2026-08-15)
- ⚠️ **Three separate attendance tests encoded assumptions the tenant never satisfied**, and each
  one failed in a way that read as a product defect. A guard matched copy the app had deliberately
  improved away from; a helper hard-coded "weekly off is SUNDAY" for a tenant that keeps Saturday
  too; the same helper then dismissed holidays as a remote edge case and landed on **14 August**.
  **"Rare" and "every year on a fixed date" are not the same thing.**
- **Read the configuration, do not assume it.** The fixed helper asks the school for its own
  `weeklyOffDays` and closures. A test that hard-codes policy is asserting a second, invisible
  fixture that nothing keeps in step.
- ⚠️ **A skip is not a pass, and a green suite full of skips is not evidence.** Both fixes were
  proved by temporarily making today a working day and confirming each **body** runs to completion —
  the same non-vacuity discipline as probing a rule by breaking it.
- **Sometimes there is genuinely no legal input, and saying so beats manufacturing one.**
  `StudentEnrollment.startedAt` is `@default(now())` with no override, and the register refuses any
  date the enrolment was not active on. So a freshly seeded student can only be marked **today**,
  and on a weekly off no date exists. The spec skips saying exactly that; reaching for
  `allowHolidayOverride` would have kept it green while quietly testing a different claim.

## An emoji is not an icon (added 2026-08-15)
- ⚠️ **An emoji cannot participate in a design system, and no amount of token work changes that.**
  It is a text glyph the operating system paints in its own fixed, multi-colour way: it cannot
  inherit `currentColor`, so it cannot be brand-tinted, cannot go white on a navy header, cannot
  dim when disabled, and renders as a different picture on every platform. The product shipped
  **zero SVG** and 23 emoji in `NAV`; against a deliberate palette they read as random, correctly.
- **Type the icon slot.** `NavItem.icon` moved from `string` to a union of icon names, so a future
  entry cannot quietly reintroduce a glyph — and the compiler found four more the eye had missed.
- **One `<svg>` wrapper for the whole set**, paths only per icon: the box, stroke and colour
  behaviour cannot then drift between icons, which is what makes a set look like a set.

## Charts: the medium and the palette are both engineering decisions (added 2026-08-15)
- ⚠️ **A `viewBox` scales its own text.** The first version of the dashboard charts was SVG and
  looked correct on a laptop; at 375px the peak label measured **7px tall**, because 21 units of a
  1000-unit box is 6.6px once the box is 314px wide. **For rectangular forms — a stacked bar is a
  row of widths, a column chart a row of heights — plain HTML is the better medium**, because the
  type stays real CSS pixels at every width.
- ⚠️ **The intuitive status palette is unreadable, and it is the one the competitor uses.**
  Measured under Machado–Oliveira–Fernandes: absent-red ↔ present-green is **ΔE 5.3 (deuteranopia)**
  and late-orange ↔ absent-red is **ΔE 8.8 (normal vision)**. Present-versus-absent is the most
  important distinction on a school register and it was invisible to a deuteranope.
- **Segment ORDER is an accessibility control, not a style choice.** Only neighbouring bands touch,
  so putting blue `leave` between red and green fixed the worst pair without changing any hue.
- **Chart fills are a different slot from badge status tokens.** `--ok`/`--warn`/`--danger` are
  text-on-tint pairs solving a 4.5:1 *text* problem; chart fills solve a mark-*separation* problem.
  Same meanings, different constraints — merging them breaks one of the two.
- **Plot the remainder or the chart is false.** A part-to-whole chart *claims* its parts sum to the
  whole, so "not yet marked" has to be a band. Omitting it renders a register with one child marked
  and sixteen blank as "100% present" — the same reassuring lie the coverage line already exists to
  defuse, but this time built into the geometry.
- **Zero must render as zero.** A `min-height` added so a small month stays visible was also
  drawing true zeros as 2px stubs, i.e. "a little" where there was nothing.

## A failure path that renders nothing is a crash (added 2026-08-17)
- ⚠️ **The app shell answered "the API is unreachable" with a WHITE PAGE.** `(app)/layout.tsx`
  caught the `me()` rejection but handled **only 401**; every other outcome — 500, proxy failure,
  dropped connection — fell through to `setReady(true)` with `me` still null, and `if (!me) return
  null` rendered an empty document. No message, no retry, no route out, nothing logged.
- **The trigger was environmental; the defect was ours.** A DNS failure exposed it, but any API
  outage would blank the entire product for every user of a school, and the screen would give an
  administrator nothing to report beyond "it's white".
- **A caught error that only handles the expected status is not error handling.** The 401 branch is
  the *ordinary* case (go and sign in). The branch that needed writing was the one nobody expected,
  which is precisely the one that reaches a user during an incident.
- **Now names the fault and offers a way forward** — status, a Try again, and a Sign in link. The
  same shape as the guard that refused ADMISSION fee structures: **saying no loudly beats failing
  silently**, because a silent failure is indistinguishable from a crash.

## ⚠️ An implicit Prisma many-to-many is a hole in tenancy the CI gate cannot see (added 2026-08-17)

- ✅ **Gate fixed and proven the same day** (bell-schedule P0). `check-rls-coverage.mjs` now also
  asserts that no `public` table outside a four-name allowlist lacks `school_id`. Demonstrated in both
  directions: a bare `_BellScheduleToClass` table made `✔ RLS coverage` print while it sat there
  unprotected, and made the new check exit 1.
- **Never write `classes Class[]` on both sides of a relation in this schema.** Prisma creates an
  *implicit* join table with only `A`/`B` uuid columns and **no `school_id`** — so `05_rls.sql`, which
  loops tables that carry `school_id`, gives it no policy, and the Prisma extension, which merges
  `schoolId` into every operation, has nothing to merge into. A table holding tenant data, unprotected.
- ⚠️ **And `scripts/check-rls-coverage.mjs` passes it green.** The query starts
  `WHERE c.column_name = 'school_id'`, so a table without that column is never a candidate. **The gate
  can only police tables that already opted in** — it detects a forgotten policy, never a forgotten
  column. All three isolation layers share one assumption and fail together when it does not hold.
- **Every many-to-many here is an explicit tenant-chained model** — `SectionSubject`,
  `StudentGuardian`, `TeacherAssignment` — each with `schoolId` and composite `(id, schoolId)` FKs.
  Verified while auditing the timetable plan: **0** implicit join tables exist across 37 migrations.
  The convention was universal and undocumented, which is how a plan reached for the shorthand.
- **Found by auditing a PLAN, not the product**, by asking what a piece of Prisma shorthand actually
  creates. The gate hardening (assert no `public` table outside a small allowlist lacks `school_id`)
  is scoped into [[Timetable & Bell Schedule Plan]] P0.

## Make the bad state inexpressible before you make it invalid (added 2026-08-17)

- The timetable plan's first draft required bell-schedule rows to be **contiguous** (no gaps, no
  overlaps) while offering **row-level** add/remove/reorder. A whole-day invariant cannot be checked on
  a single-row write: you either accept an edit that breaks the day or reject a legal intermediate one.
- **The fix was not better validation.** The day is written atomically, and **the client sends
  durations while the server computes every time from the day's start.** There is no input that
  expresses a gap or an overlap, so neither can be created, and `sequence` and `periodNo` are assigned
  rather than typed — which also removes the "period 7 that no bell rings for".
- Same shape as two rules already here: `Student.userId` makes cross-student portal access
  *structurally* impossible rather than guarded, and `/portal/*` takes no id from the client at all.
  **A constraint the API cannot violate beats one it must remember not to.**
- The general form: when a rule spans several rows, look for the write granularity that makes it a
  property of the input rather than a check on the output.

## A rule enforced per call site is a rule that decays (added 2026-08-17)

- A malformed `:id` answered **500** on 61 routes: the value reached Prisma unvalidated and died as
  `Inconsistent column data: Error creating UUID`. The first fix put `ParseUUIDPipe` on **81 call
  sites**. It worked, it shipped, and it was the wrong shape — **the next route anyone writes will
  not have it**, and nothing will say so.
- Replaced by one `UuidParamPipe` bound as `APP_PIPE`, matching `id` and any `<entity>Id`. The rule
  is now a property of the pipeline rather than a habit each author has to remember. Same family as
  the RLS `tenant_isolation` policy and the Prisma tenant extension: **enforce once, centrally, or
  discover the gap later from a user.**
- ⚠️ **Version-agnostic, not `ParseUUIDPipe`'s v4.** `test/matrix` drives most rows against the nil
  UUID as a deliberately-absent id, and the nil UUID is not v4 — a v4-strict pipe collapses *not
  found* (404) into *malformed* (400), destroying the distinction it exists to draw. Format belongs
  to the edge; existence belongs to the service.
- ⚠️ **Bound in `AppModule`, never `main.ts`.** Every integration spec builds from `AppModule` and
  re-declares only the `ValidationPipe`; a pipe in the bootstrap file is present in production and
  absent from all 38 suites.
- **Where the better design came from:** an older branch that was about to be deleted as stale
  debris. Its diff was unmergeable — 10k lines behind — but its *reasoning* was worth more than the
  code on `main`. **Read a branch before deleting it; the diff can be worthless while the design is
  not.**

## A REVOKE in a migration is undone by the grants companion (added 2026-08-24)
- ⚠️ **The tenant runtime role could read every vendor table — operator emails, argon2 password
  hashes, encrypted MFA secrets, recovery-code hashes and the whole platform audit trail.**
  Measured on the live dev database, not inferred: `psql -U app_user` returned rows from
  `platform_users`, `platform_audit_logs` and `platform_mfa_recovery_codes`.
- **Cause: order of operations inside one command.** `db:setup` is
  `prisma migrate deploy && pnpm db:sql`. The SA0 migration ends with
  `REVOKE ALL ... FROM app_user`, and `06_grants.sql` — which runs *next* — opens with
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user`. The revoke
  was handed straight back, seconds later, by the same command that performed it.
- ⚠️ **A one-shot REVOKE cannot defend against a repeated blanket GRANT.** A migration runs once;
  the companions re-run on every setup. **Whatever runs last wins**, so the revoke belongs at the
  END of `06_grants.sql`, not in the migration that first needed it.
- ⚠️ **RLS is no help here and that is the point.** These four tables carry no `school_id`, so
  they are on the NON_TENANT allowlist and no policy applies — **grants are their only access
  control.** Both existing checks pass on them by design, which is exactly why the hole was
  invisible: the guard that would have caught it did not exist.
- **Now guarded**: `check-rls-coverage.mjs` gained a third check asserting `app_user` holds no
  privilege on any `platform_*` table, with `VENDOR_TABLES` derived from the allowlist so the two
  cannot drift. Probed by re-granting `SELECT` on one table — the check exits **1** and names the
  table and privilege; `pnpm db:sql` restores it and it exits 0.
- ⚠️ `schools` is deliberately excluded from the revoke: it also has no `school_id`, but tenant
  resolution must read it from the request Host.
- **Not caused by SA0** — the same hole already existed for `platform_users` and
  `platform_refresh_tokens`, which the brain had recorded as "revoked from app_user". They were
  revoked; the grant put them back. **A control that is written, runs, and is then silently undone
  is the sixth inert security control found in this codebase.**

**Source:** [[consistency-register]] · [[school-management-master-blueprint]] §2–§34

## Never run `next build` in a live `next dev` directory (added 2026-08-18)

- `apps/web` was serving 500s (`Cannot find module './2422.js'`, production `BUILD_ID` against a
  `development` runtime) after a `next build` was run as a merge gate while `next dev` was still
  running on :3001. A production build rewrites `.next/` in production layout; the dev server watches
  the same `.next/` and 500s on its next recompile when its chunk map no longer matches.
- The live browser had worked minutes earlier — the corruption only surfaced on the dev server's
  next recompile, so it looked like a code regression and was not. The code compiled cleanly in that
  very build.
- **Gate the web build without touching the dev server's `.next`:** stop `next dev` first, or build
  into a throwaway dir (`next build` with a separate `distDir`), or rely on tsc + lint + Playwright
  and run the production build only when no dev server is up. Recovery: stop dev, `rm -rf .next`,
  restart dev.
- Same family as the timebox rule: an environment failure that mimics a code regression wastes turns
  if chased as code. Confirm the build/lint are green first — if they are, suspect the environment.

## The route-coverage gate, and the SMS routes it found world-readable (added 2026-08-18)

- **A route with no UI is invisible to every reviewer.** The IA audit tried to hand-count them and
  was wrong three ways: a per-file `@Controller` prefix bug (fees.controller has six prefixes), and a
  substring heuristic that both over- and under-counted. **`route-coverage.e2e-spec.ts` removes the
  guessing** — it reads the live Express router (the real, fully-prefixed table) and checks each
  route against a scan of `apps/web`, failing on anything neither called nor listed. Same family as
  the `check-rls-coverage.mjs` enrolment assertion: a gate that only inspects what opted in cannot
  see what never did.
- ⚠️ **The matcher must allow a literal segment to also match a `${...}` template hole**, because the
  client builds some paths dynamically — `apiGet(`/reports/${key}`)` reaches every `/reports/<name>`
  route. Without it, seven real report routes read as uncovered (false positive). But the FIRST
  segment must stay a literal anchor, or a stray `/${id}` anywhere makes every short route match
  (false negative). Both directions were found by running the gate, not by reasoning.
- ⚠️ **Building the SMS screen surfaced a real over-exposure:** `GET /sms/templates|credits|logs` had
  **no `@Roles`** — any authenticated user (teacher, accountant) could read the SMS logs, which carry
  parents' phone numbers and message bodies, plus the credit balance. Latent precisely because there
  was no screen, so nobody looked. Now `@Controller('sms')` is admin-only. **A route with no UI is
  also a route whose authz nobody has eyeballed** — the gate is a security check as much as a UX one.

## Production hosting: subdomain-per-tenant, never port-per-role (operator, 2026-08-29)

- **The operator proposed hosting each role on its own port** (marketing :3000, superadmin :3001, owner
  :3002, campus :3003, staff :3004). **Rejected — wrong boundary.** (1) **Ports are not a security
  boundary: cookies are scoped to the hostname, not the port**, so `localhost:3001` and `:3002` *share*
  cookies — role-per-port would let sessions collide, the opposite of isolation. (2) A port encodes a
  role but not *which school*, so multi-tenancy still needs subdomains on top. (3) Real users never see
  ports — prod is HTTPS on 443 behind a reverse proxy; 3000–3004 are a dev-only convenience.
- **The rule: a subdomain = a SCHOOL (tenant), not a role.** Owner/campus-admin/staff/student are *roles
  inside one school*, resolved by the role guards + `landingPath`, and they all sign in on their school's
  subdomain (`<school>.schoolworks.com/{owner,staff,student}-login`). A global `admin.`/`student.`
  role-subdomain would re-merge every school onto one cookie domain (a regression). The **one** legitimate
  global-subdomain split is the **vendor console** (`superadmin.` / the reserved `admin.`) — different app,
  different `platform_users`, different cookies.
- **The system is already built this way** (subdomain tenancy via `TenantResolutionMiddleware`, reserved
  subdomains, `admin` for the console), so hosting under `schoolworks.com` is **infra, not a re-architecture**:
  wildcard DNS `*.schoolworks.com`, a wildcard TLS cert (DNS-01), Traefik host-preserving path-split, and
  `APP_APEX_DOMAIN`/`RESERVED_SUBDOMAINS` env. Checklist in [[Deployment & Operations]] (⏳ TODO: the VPS deploy).

## Operations Admin: a one-directional role hierarchy, not an authz sweep (2026-08-29)

- **Problem.** The owner wanted a near-owner **deputy** (`OPERATIONS_ADMIN`, "Ops Admin") that runs the
  school operationally but can't become a second root. The obvious build — visit every `@Roles` decorator
  and add `OPERATIONS_ADMIN` beside `OWNER_ADMIN` for the operational ones — is a **large, error-prone
  sweep**: miss one route and the deputy silently can't do part of its job; add it to the wrong one and it
  breaches the ceiling. The failure mode is invisible until someone hits that route.
- **Decision — give the role a hierarchy instead of editing the routes.** `RolesGuard` was a flat "holds
  one of the required roles" check. A new `libs/common/authz/role-hierarchy.ts` `rolesSatisfying(held)`
  **expands** a held `OPERATIONS_ADMIN` into the set of roles it covers (Campus Admin, Admission
  Controller, HR, Accountant, Teacher, Staff) — **never `OWNER_ADMIN`** — and the guard matches on the
  expanded set. Consequence, **by construction, with zero per-route edits**:
  - routes gated `@Roles('OWNER_ADMIN', <lower>)` **admit Ops** (via the lower role it now satisfies);
  - routes gated **`@Roles('OWNER_ADMIN')` ALONE stay owner-reserved** (Ops never satisfies owner).
  So the *existing shape* of the decorators already encodes the ceiling — owner-only routes are exactly
  the reserved set. The one-directional inheritance is the **only** hierarchy in the system; every other
  role still satisfies only itself.
- **The guard is coarse; the ceiling is fine-grained — so it lives in the service.** The guard answers
  "may you reach this route type?" It **cannot** express "you may grant roles *below* you but not your own
  level, and may not touch a user who outranks you" — that reads tenant rows and depends on the *target*.
  Per the §22.8 rule (ownership checks that read tenant data go in the service, not a guard), the
  grant-ceiling (`grantableRoles` + `assertMayManageTarget` on create/update/setAccess/resetPassword) is
  **service-level**: OP-1 (only the owner grants/revokes a deputy) and OP-2 (a deputy can't grant its own
  level-or-above, nor modify/reset/re-role an owner or another deputy). Owner-only roots of trust
  (module-access toggles, user removal) simply keep `@Roles('OWNER_ADMIN')` and are unreachable by Ops.
- **The web mirrors the same hierarchy, in one place.** `apps/web/lib/roles.ts` gets a matching
  `effectiveRoles()` so the sidebar/route-gate shows Ops exactly the screens the API will allow — no
  second enumeration of "screens Ops can see" to drift from the backend. Owner-only screens (Campus Hub,
  module access) stay hidden (OP-7: hide, don't show-then-403).
- **Why this is safer than the sweep.** A missed route in the sweep is a silent capability hole or a
  silent breach; here the hierarchy is **one function with one rule**, proven by `matrix-conformance` +
  the dedicated `ops-admin-authz` e2e rather than by having eyeballed 100 decorators. Same lesson as the
  nav-stricter-than-API bugs: **a permission that falls out of a list's contents is one that drifts;
  state the rule once and derive from it.** See [[Operations Admin Role Plan]].

## Front-end split into one app per audience — but still one API, still tenant-in-host (operator, 2026-08-29)

- **Decision.** Split the single `apps/web` into **four front-end apps by audience — SuperAdmin, Owner,
  Staff, Student** (plus marketing), each its own build/origin/subdomain, **all sharing the one unchanged
  NestJS API**. Aligns to the existing **login doors** (`login-door.ts`): owner door → Owner app, staff
  door → Staff app, portal → Student app, platform console → SuperAdmin app. Driver: **security /
  blast-radius isolation** (origin isolation so a student-page XSS can't reach owner/superadmin cookies or
  code). Full plan: [[Front-End Instance Separation Plan]].
- **This is NOT a reversal of "subdomain = school, NOT role."** That earlier decision rejected *global
  role subdomains that DROP the tenant* (e.g. one `student.schoolworks.com` for every school, re-merging
  tenants). The new hosts keep the school in the host — **`<role>.<school>.schoolworks.com`** — so the
  tenant is still the school; the role prefix only selects which *app/origin* loads. Tenant is resolved
  from the school label pre-auth and from `JWT.sid` post-auth, exactly as now. And it is still **not
  role-per-port** (ports were rejected as a boundary because they share cookies and don't encode a tenant;
  per-app dev ports are a dev convenience only, prod is subdomains on 443).
- **Same-origin BFF, not cross-origin API.** Each app proxies `/api` to the internal API on its own
  origin, so cookies stay **first-party + SameSite=Strict** and the API keeps `origin: false`. A shared
  cross-origin `api.schoolworks.com` was rejected: it would force `SameSite=None` + a CORS allow-list,
  reopening the cross-site cookie exposure the split exists to reduce.
- **The split is defence-in-depth on the CLIENT, not the authorization boundary.** The API's RLS +
  `@Roles` remain the one enforcement point; a direct API call is bounded by them regardless of which
  front-end exists. No security check may move out of the API into "that app isn't shipped to them."
- **Owner vs Staff overlap (~90%) is the main cost** and is mitigated by a shared `school-ui` package —
  never by duplicating screens (two truths for one screen is the failure the Classes refactor + permission
  matrix exist to prevent). Open question in the plan: 4 apps now, or ship Owner+Staff as one `school-web`
  (3 apps) and split later.

## E2E suite re-homing after the split: origin = door, and dev cookies are host-scoped (2026-09-01)

Recorded because two facts, non-obvious until you hit them, are what made re-homing the Playwright suite
onto the five split apps tractable — and one of them is a **dev-only** property that must not be mistaken
for a security guarantee. Fix 2 of [[Front-End Split QA & Test Cases]]; commit `6fd606b`.

- **Origin = door.** Post-split there is no single-origin login form to branch by path. Each app serves
  *its own* door at `/login` (owner-web:3005/login = owner form, staff-web:3006/login = staff form,
  student-web:3003/login = reg-no+CNIC form, superadmin-web:3004/login = console). So a test selects the
  door by the **origin it runs on** (`baseURL`), and `login()` collapsed from `goto('/owner-login' | '/staff-login')`
  to a bare `goto('/login')`. The old `/login` chooser survives only on the apex marketing app (:3001),
  now linking **cross-origin** to each door (:3005/:3006/:3003) — which is exactly what `owner-login.spec`
  asserts, and it was live-verified.
- **Dev cookies are host-scoped (port-agnostic).** A cookie for host `localhost` is sent to *every* port
  on localhost (RFC 6265 does not scope cookies by port). So the shared owner `storageState` obtained on
  owner-web:3005 is also sent to staff-web:3006 — which is why a staff/officer spec can still do its
  owner-only seeding (create the officer, the class) through the shared session before the officer login
  overwrites it. ⚠️ **This is a dev-only convenience, NOT the isolation boundary.** In prod the apps live
  on different subdomains (real, distinct hosts), so their cookies *are* isolated — that isolation is the
  whole point of the split. Never reason from "the test shared a cookie across ports" to "the apps share a
  session in prod"; they do not.
- **Consequence for the suite layout.** Default `baseURL` = owner-web (it serves the whole school app +
  the owner door + the `/api` proxy). Officer specs `test.use` :3006; teacher specs keep the owner `page`
  at :3005 and put the *teacher* `browser.newContext` on :3006; student-portal :3003; console via the
  absolute-origin helpers. Kept the "no `webServer`, run against the live stack" model — the required apps
  are documented in the config header (API :4000, owner :3005, staff :3006, console :3004, apex :3001).

## The teacher panel is the school's work; Profile is the person (operator, 2026-09-01 → 09-06)

Three related calls, all front-end, all made by the operator watching the live teacher shell. Recorded
because each one **reverses an earlier deliberate design**, and the reasoning for the original is still
in the code comments — a later reader will otherwise "fix" this back.

- **The desktop panel lists everything; "More" is gone.** The Teacher App Shell Plan (T0) gave a teacher
  the SAME four destinations at every width — phone bar and desktop rail — on the argument that "the
  phone's structure IS the product's structure". The operator wanted the full menu on a laptop, so
  `teacherSidebarNav()` now flattens `groupedNav`. ⚠️ **The phone bar is unchanged and still four** (a
  bar past four is unreadable at thumb size), with `me-more` as its overflow — so nothing reachable on a
  laptop became unreachable on a phone.
- **`My Portal` moved out of the panel and into Profile**, pinned to the rail's footer. The line is the
  existing `NAV` **group**, not the words "My …": `My Classes` is `Teaching` (work she does for the
  school) and stays in the panel; her attendance, timetable, leaves and payslips are `My Portal` (the
  employee) and live behind Profile. Keying off the group means a `My Portal` screen added tomorrow
  lands in Profile on its own and cannot re-clutter the panel.
- **The brand names the PANEL; role chips name the PERSON.** The sidebar showed `panelLabel` — one role
  — so a TEACHER+ADMISSION_CONTROLLER+HR_MANAGER was branded plainly "Teacher" while the top bar printed
  raw enums (`TEACHER, ADMISSION_CONTROLLER, HR_MANAGER`), a database value rather than a job title.
  `roleLabels()` now renders every hat as chips in the shell, so they are on every screen.
  ⚠️ **Held roles only, never `effectiveRoles`** — an Ops Admin satisfies six lower roles by hierarchy,
  and listing those would tell a deputy she is a Teacher, which is a claim about her job rather than her
  permissions. ⚠️ `ADMISSION_CONTROLLER` needed a separate `title`: its `label` names the *screen*
  ("Admission Portal"), and a chip reading that would tell her that her job is a page.

Profile itself stays **read-only** — the operator asked only to *see* details related to her — so it adds
no capability, just re-homes what already existed (Security, Sign out) plus the self-service list. Richer
HR fields (designation, employee code, join date) would need a read-only self endpoint and were NOT added.

## Seeding staff in tests: some roles are GRANTED, and two of them are seats (2026-09-06)

Both learned the hard way from a live e2e run, both times the **product was right and the test was
wrong**. Worth recording because the next person writing a staff fixture will reach for
`POST /users { roles: [...] }` and get a 403 or a 409 that reads like a bug.

- **`HR_MANAGER` cannot be created with an account.** `POST /users` accepts only `MANAGEABLE_ROLES`
  (owner, ops, campus admin, admission controller, accountant, teacher, staff). HR lives in
  `ACCESS_GRANTABLE_ROLES` and is conferred on an **existing** employee via
  `PATCH /users/:id/access { role, grant }` — deliberately, because HR access is a hat you give
  someone who already works here, not a new set of credentials (the same reasoning that consolidated
  the grant endpoints). Fixtures must **create-then-grant**; `apiSetupPatch` in the e2e helpers
  exists for this.
- **`ACCOUNTANT` is a per-campus seat, exactly like `ADMISSION_CONTROLLER`.** A stale comment in
  `teacher-shell.spec` claimed the opposite ("ACCOUNTANT rather than ADMISSION_CONTROLLER because
  the API refuses a second admission officer per campus") and seeded onto the school's first campus.
  That was a time bomb: it passed only while that campus happened to have no accountant, and went
  off the day the operator appointed one — `409 This campus already has an accountant`. Anything
  needing a **seat** role must seed into the suite's own `E2E Automation` campus (`e2eCampusId`),
  which exists for precisely this reason and has its own free seat.

✅ **Related, FIXED same day: the Playwright `globalTeardown` was broken.** It imports `destroyTenant`
from `test/integration/support/tenant.ts`, which pulls in `@database` — and Playwright's TS loader
cannot parse NestJS **parameter decorators** (`constructor(@Inject(ENV) env: Env)`), so the teardown
dies with a `SyntaxError` on every run. Playwright reports it as *"1 error was not a part of any
test"*, which is easy to miss, and the consequence is that the cleanup written to stop test debris
accumulating in the operator's demo tenant **is not running at all** — the exact failure that let the
G3 unmarked-register count reach 71, 67 of them ours. **Fixed** by importing `@database/tenant-purge` **directly instead of through the `@database`
barrel** — `tenant-purge.ts` has no imports at all, so it parses fine outside Nest, and the single
shared copy of the FK-graph walk is preserved (no duplicated delete order, which is what rotted
last time and left 251 dead schools). ts-jest is unaffected; isolation stayed 7/7. The teardown now
reports its work on every run — *“removed 1 suite-provisioned tenant(s) · withdrew 9 test
enrolment(s) · removed 7 seeded student record(s)”* — so the cleanup is visible rather than silent.
⚠️ Do not “tidy” that deep import back to the barrel: the comment on it explains why.

## The split moved a capability and left its assets behind (2026-09-06)

**PWA installability was silently lost for eight days and nothing failed.** Installability shipped
with the Teacher Mobile Home Plan (M4) and lived in `apps/web`. When the front-end split moved the
school screens onto their own origins, `manifest.webmanifest` and the icons **stayed on the marketing
app** — so the site nobody installs remained installable, while the **phone-first staff app the
feature was built for** could not be added to a home screen at all.

Worth recording because of *why the gates missed it*:
- `route-coverage` guards API routes having a caller. Nothing guards a **static asset** following the
  screens that need it.
- `installable.spec` kept passing — it was still pointed at `apps/web`, the one app that kept the
  manifest. It only surfaced when the suite was re-homed onto the split origins and the spec started
  asking `owner-web` for a manifest.

**The general rule this argues for: when a capability moves apps, its assets and its test's target
move in the same change.** The spec now runs against **the apps that are supposed to be installable**
(staff + student, parameterised), so "which app is this asserting?" cannot drift from "which app do
people install?" again.

⚠️ **A second bug fell out of fixing it: `staff-web` had no root page, so its bare origin 404'd** —
meaning `staff.<school>.schoolworks.com` returned "This page could not be found" in production, and an
installed PWA (whose `start_url` is `/`) would have cold-started onto that 404. Invisible because every
link in the product is deep: you only meet it by typing the domain, which is exactly what someone does
with a newly installed app. Fixed with a root page that resolves to `landingPath(me.roles)` — the same
rule the sign-in form uses, so the front door and the door after login cannot disagree — and a new
`start_url actually resolves` assertion, because a manifest can be perfectly valid and point at nothing.

✅ **`owner-web` had the identical `/` 404 — fixed same day**, with the same root page resolving to
`landingPath(me.roles)`. **The bug shipping twice is the point:** the split turned one front door into
five, and a 404 on one of them is invisible from inside any of the others, because every link in the
product is deep. So it is now a gate rather than a memory — `test/e2e/app-roots.spec.ts` asks all five
apps for their bare origin, one request each, no session. It asserts **not-404 rather than content**:
each root legitimately differs (marketing paints a page, the portal a dashboard, owner/staff redirect),
and pinning content would duplicate the specs that own those screens and break whenever a landing page
moved — which is a decision, not a regression.

## A soft-deleted bell schedule made every class it touched undeletable (2026-09-07)

Chased down from an unrelated symptom: the `timings` e2e spec had been failing intermittently, and
the demo tenant had reached **18 leftover `TmCls…` test classes out of 28** — 64% debris in a screen
a human actually looks at.

**The chain, because every link is worth knowing:**
1. `BellScheduleService.remove` only stamps `deletedAt`. The `bell_schedule_classes` join rows
   survive a deletion the user believes has happened.
2. That join's class foreign key is **RESTRICT** (`confdeltype = 'r'`).
3. `SetupService.deleteClass` blocked on sections, fee structures, exams and batches — but knew
   nothing about bell schedules. So the request sailed past every friendly "this class is in use"
   message and died on a raw constraint violation.
4. The only thing exercising that path was an e2e cleanup whose `catch` was `/* ignore */`. It
   failed on every run, silently, for months.

**Fixed on the product side, not the test side**, because this is not a test problem: an operator who
creates a bell schedule, deletes it, and then tries to delete one of its classes gets an opaque 500.
`deleteClass` now (a) counts links to **live** schedules and names them as a blocker, and (b) deletes
links belonging to **soft-deleted** schedules, which are unreachable anyway since every read filters
`deletedAt: null`. Regression tests in `bell-schedule.e2e-spec.ts` cover both halves.

⚠️ **The lesson is the silent `catch`.** "Cleanup must never be the loudest thing in a failure" is
right, but inaudible is not the same as quiet — the timings cleanup now **warns** on a failed delete.
A best-effort teardown that cannot report its own failure is indistinguishable from one that works.

### The timings spec had three separate defects behind the same red

Worth listing, because each failed in a way that blamed the product:

- **`getByLabel('Minutes, row 1')` matches a SUBSTRING.** It also resolves "row 10", "row 11",
  "row 12", so the spec died with a strict-mode violation the moment a day had ten or more rows. It
  had passed for months only because the day under test happened to be short. Now `exact: true`.
- **`selectOption` raced the page's own data load.** Both `/timings` and `/timetable` fetch their
  options after first paint and re-render, silently resetting the select. On an idle machine the
  fetch usually won; in a full suite run it did not, and the test then failed further down as a
  *content* mismatch that read like a timetable bug. Now set-and-verify under `toPass`.
- **The section picker was addressed as "the first `<select>` on the page"**, which it stops being
  as soon as a cell is opened for editing. Given a real `id="tt-section"` (and a proper
  `htmlFor` label, which it never had — an accessibility gap too).

### …and the "short Friday" chase found a fourth, in the product again

Following it properly paid off. The spec was reading the school's **real "Regular"** schedule, and the
reason was `/timetable`'s own mount effect:

```ts
api.timetable.coverage().then((c) => {
  if (c.sections.length && !sectionId) setSectionId(c.sections[0].sectionId);  // ← stale closure
});
```

The effect runs once, so `sectionId` there is forever `''` — meaning a **late `coverage()` response
overwrote whatever section the user had already picked**. For a person on a slow connection that is
choosing a section and watching it jump back to the first one; for the spec it meant asserting clock
times that belonged to another schedule and blaming the timetable. Fixed with the functional form,
`setSectionId((cur) => cur || …)`, so the default only ever fills an empty selection.

Two lessons worth keeping:
- **A test that reads the wrong thing must say so.** The spec asserted only that the sentence
  *"Periods and times come from …"* existed, never **which** schedule it named — so a grid rendered
  from the campus default looked perfectly healthy and failed three lines later as a clock mismatch.
  It now names the schedule, which turns "the timetable is broken" into "you are looking at the wrong
  one".
- **A stale `.next` hid the fix for two runs.** Next's watcher for files outside the app dir
  (`experimental.externalDir`, i.e. all of `@sw/school-ui`) has been unreliable throughout this work:
  clearing `.next` and restarting the app was needed to see any of it. Worth reaching for early
  rather than doubting the change.

### Resolved — and the tempting fix was the wrong one

The obvious remedy was to seed that day through the API, like the Friday test. **That would have made
the spec stable and pointless.** The preview duplicates `composeBellDay` because the browser cannot
import `libs/common`, so *typing the durations IS the test* — it is the only thing checking that the
duplicate still agrees with the original. Seeding the day would have left it rendering server-stored
times and quietly guarding nothing: precisely the "looks fine, tests nothing" failure this file keeps
finding elsewhere.

**The flake was never caused by typing. It was caused by UNVERIFIED typing.** Six clicks fired in a
row race the re-render each one triggers, so a click can be swallowed; a `fill` that lands mid-render
is discarded silently. Either way the only symptom was a wrong total three assertions later, reading
as though the arithmetic were broken. Now each click waits for its row to appear, and each `fill` is
read back — so a lost interaction fails on the row that lost it.

Result: three consecutive file runs and two full-suite runs green (56/0), with the composition
coverage intact.

⚠️ **Separate observation, not chased:** under heavy load (five Next dev servers + API + worker, with
a full run stretching from 2.5 to 3.8 minutes) other interaction-heavy specs can flake the same way —
`classes-ux` "seats cannot be cut below…" failed once on `toBeEnabled` and passes in isolation. The
same verify-each-interaction treatment would fix it; the deeper remedy is not running the whole dev
stack while the suite runs.

## The deploy config had never been executed, and it showed (2026-09-11)

The system is live on a free Oracle Cloud box at `140-245-39-243.sslip.io`. Getting there surfaced
**four** defects in `deploy/`, none of which any test could have caught, because nothing had ever run
those files. Their own header said so: *"templates validated against the app layout, not run in this
environment."* That sentence was accurate and should have read as a warning.

Three of the four share one root cause worth internalising:

> **Compose resolves relative paths against the PROJECT directory --- the dir of the FIRST `-f` file ---
> not against the file that declares them.**

`deploy/docker-compose.prod.yml` was written as though `..` meant "up from deploy/". Run from the repo
root it means "up from the repo", i.e. outside it entirely.

| Defect | Symptom |
|---|---|
| `env_file: [../.env]` | `env file /home/ubuntu/.env not found` --- stack refuses to start |
| `context: ..` | `lstat /home/ubuntu/deploy: no such file` --- build dies instantly |
| `NEXT_PUBLIC_*` not build args | silent: the apex chooser would ship links pointing at `localhost` |
| `host_regexp` in both Caddyfiles | `module not registered` --- Caddy crash-loops, serves nothing |

⚠️ **`host_regexp` is not a Caddy matcher and never was.** Caddy 2 has `host` and `header_regexp`; an
unknown matcher is a hard startup failure. This was in the PRODUCTION Caddyfile too, so the real
go-live would have failed identically --- the proxy up, every request unanswered.

**The third one is the instructive one.** The other three fail loudly on the first attempt. That one
fails *silently and later*: the app builds, deploys, serves, and only a human clicking a cross-app
link discovers it points at `localhost`. `NEXT_PUBLIC_*` values are inlined into the client bundle at
**build** time, so they cannot be supplied at runtime --- they must be build args or they are wrong.

### On-demand TLS on a shared domain: the gate is what makes it safe

`sslip.io` resolves any labels in front of an embedded IP, which satisfies the two-label-deep
requirement (`owner.demo.<ip>.sslip.io`) with no DNS provider. Verified live: real tenant, role host
and reserved console all 200; **unknown host 404 and no certificate issued**. Without that gate,
on-demand TLS on a shared domain is an invitation to burn Let's Encrypt rate limits shared with every
other sslip.io user.

The label arithmetic differs from production and is the one thing that fails quietly: Caddy indexes
host labels from the RIGHT, so an sslip apex (3 labels) rebuilds the school Host at a different offset
than `schoolworks.com` (2 labels). Get it wrong and tenant resolution simply never finds the school.
Verified by posting a DELIBERATELY WRONG password to the login endpoint on both host shapes: `401
INVALID_CREDENTIALS` proves the tenant resolved and the user was found, without using a real secret.

### Two firewalls, and only one of them is yours

An OCI instance drops traffic at the host `iptables` (Oracle images ship a `REJECT all` rule that 80
and 443 must be inserted ABOVE) *and* at the console-side security list. Each produces an identical
silent timeout that reads exactly like a broken app. ⚠️ Note also that Compose writes its own DOCKER
chain which **bypasses** INPUT --- so publishing a database port would have exposed it to the internet
with the host firewall still looking closed. The test override stops publishing postgres/redis/minio
entirely; verified that only Caddy binds 80/443.

## Presigned storage needs TWO endpoints, not one (2026-09-12)

Uploads failed on the live box with nothing in any log explaining why. The cause is structural, not
a typo, and it will recur on every self-hosted deployment.

`StorageService` had ONE `S3_ENDPOINT` serving two callers with incompatible needs:

| Caller | Needs |
|---|---|
| API → storage (generated PDFs) | internal, fast, no public hop — `http://minio:9000` |
| **Browser** → storage (presigned PUT/GET) | publicly resolvable, HTTPS |

Uploads are presigned and go **browser → storage directly**, never through the API — the right
design, since a 20 MB upload should not occupy a Node process. But it means the browser must reach
the storage host itself, and `minio` resolves only inside the docker network (and `http://` would be
blocked as mixed content from an HTTPS page besides).

⚠️ **The URL cannot be rewritten after signing.** A SigV4 signature covers the host, so it must be
SIGNED for the host the browser will call. Hence `S3_PUBLIC_ENDPOINT` and a second S3 client used
only for presigning. It defaults to `S3_ENDPOINT`, so managed storage (R2/S3), local dev and CI —
where one host serves both callers — need no configuration and behave exactly as before.

### The gate refuses hosts you forgot to tell it about

Adding `s3.<apex>` was not just a Caddy route. On-demand TLS asks
`GET /platform/public/host-allowed` before minting, and that allow-list is **hardcoded**
(`superadmin, admin, www`). An unknown label → 404 → Caddy **silently declines to issue a
certificate**, so the host is unreachable over HTTPS with no error anywhere saying why.

⚠️ **It is deliberately NOT derived from `RESERVED_SUBDOMAINS`**, which answers a different question:
that list is "labels that must never resolve to a school" and includes the ROLE labels, which are
only valid two-deep. Deriving would mint certificates for `owner.<apex>`, a host that routes nowhere.
The two lists are separate by design, so a test pins the invariant that binds them: **anything the
platform serves at `<label>.<apex>` must also be reserved**, or a school could register `s3` and take
over the host every presigned URL points at.

### ⚠️ A bind-mounted FILE does not follow `tar -x`

The config was correct on the host and stale inside the container, and Caddy had been up 23 hours.
Docker bind-mounts a single file **by inode**; `tar -x` writes a NEW file, so the container keeps
serving the old inode's content. The symptom was maximally confusing: `s3.<host>` returned a Next.js
404 page, i.e. the storage host being proxied to the marketing app by a config that no longer existed
on disk. `--force-recreate` on that one service is the fix. **Editing a bind-mounted file in place
(`sed -i` without `--follow-symlinks`, or a heredoc) preserves the inode; extracting over it does
not.** Worth knowing for every future deploy that ships config by archive.

### Verified end to end, not by status code

Login → presigned PUT (signed host asserted to be the public one) → 128 bytes uploaded **from outside
the network** → confirm (`quarantine/` → `uploads/`, tenant-scoped) → object listed at exactly 128 B
with the quarantine copy gone. Then the negative half: an unsigned GET **403**, a bucket listing
**403**, and a CORS preflight from the owner origin returning `Access-Control-Allow-Origin` for that
exact origin (MinIO answers it correctly by default — no configuration was needed). Test object
deleted afterwards.

**Public storage is not a weakening.** Access rests on the SIGNATURE, not on network position — which
is how S3 works everywhere. The bucket is private and the MinIO console (9001) is not exposed; only
the S3 API (9000) is routed.

## Admission Tier 3, and the part of the plan I threw away (2026-09-12)

The documents checklist, the student photograph and the parent declaration — the last real gap
between this system and a school actually using it. An admission in a Pakistani private school IS
largely a document process, and until now none of it could be recorded.

### The reversal is the interesting part

The plan said missing documents should join `recordGaps`, so the chase list would surface them.
**Built it, and three existing specs failed — correctly.** Folding documents into `recordComplete`
silently redefines what "complete" has always meant (those specs assert the list empties once the
TEXT fields are filled), and on a live school it would mark **every already-admitted student
incomplete overnight**. That is precisely the "a list nobody can empty is a list nobody reads"
failure the original chase-list design warns about, reintroduced by the person who wrote the warning.

⚠️ **A failing older test is evidence about the design, not an obstacle to it.** The tempting move —
update the three specs to tick documents first — would have buried a product decision inside a test
edit. Documents got their own signal instead: `documentsComplete` on the directory row, and their own
card on the profile. Verified live: a student with both mandatory documents in hand but no address
reads `recordComplete=false, documentsComplete=true` — the distinction is the point.

### Why a new table, not `Document`

`Document` records what the school **ISSUES**: `issuedById`/`issuedAt`, and every `DocumentType` is a
school-produced artifact (leaving certificate, report card, payslip). Receipt runs the other way,
with a different actor and a different question. Folding both through one table would make either
side lie.

### Decisions that will look arbitrary later, and are not

- **`fileKey` is nullable and must stay so.** These arrive as photocopies across a counter far more
  often than as scans. Requiring an upload to tick the box would push the office into ticking things
  that are not true.
- **Only B-Form and Guardian CNIC are mandatory.** The leaving certificate applies to TRANSFERS only
  — a child starting in KG has none, and flagging them forever flags the truth as an error. The
  photograph's canonical home is `students.photoKey`.
- **`receivedAt` is stamped on the transition into received, never rewritten.** The date the school
  took delivery is a fact about the past; editing a note must not move it.
- **The declaration is VERSIONED and server-stamped.** "The parent agreed" is close to worthless
  without "agreed to WHAT", and a client-supplied date on a legal record is a date the client can
  choose.
- **ADMISSION_CONTROLLER reaches both checklist routes.** A route stricter than the job has silently
  DELETED capability three times in this codebase (CSV import, `/my-attendance`, `/my-leaves`).

### RLS came free, and that is the system working

No hand-written policy: `05_rls.sql` loops over every table carrying `school_id`, and `06_grants.sql`
grants DML to the runtime roles. Both re-run on every `db:setup`. Verified on a real database —
`relrowsecurity` and `relforcerowsecurity` both true, `tenant_isolation` present — and the
merge-blocking coverage gate would have failed the build otherwise.

⚠️ **Deployment gotcha, again:** killing local SSH processes also kills an in-flight remote deploy
started through that connection. `setsid` detaches it properly. Related to the bind-mount inode trap
from the storage work — shipping by archive and driving by SSH has sharp edges worth knowing.

## CI went green for the first time in this project's life (2026-09-13)

Not a regression fixed — a gate that had **never once worked**. Five defects, each hiding the next.

| # | Defect | Age |
|---|---|---|
| 1 | `frontend` job installed `--frozen-lockfile` inside apps/web against a lockfile deleted by the workspace split | since a84d19d |
| 2 | Root tsconfig compiled four Next apps (1011 errors, ~1005 meaningless) | since the split |
| 3 | **`psql "$MIGRATION_DATABASE_URL"` with `?schema=public`** | **since commit one** |
| 4 | Worker guard matched its own `pgrep` shell | latent forever (POSIX-only) |
| 5 | `maintenance.e2e-spec` providers drifted from `worker.module.ts` | since PlatformBillingService landed |

⚠️ **#3 is the one that matters.** `?schema=public` is a PRISMA parameter; libpq rejects the URI and
exits 2. It sat at step 6, so **lint, typecheck, unit, integration, the merge-blocking tenant-isolation
suite and the build had never run in CI at all.** The job was decorative for the life of the project,
and #4 and #5 were free to rot behind it — which is precisely what they did.

### What actually found it

Not the clever hypotheses. I spent two pushes on a Docker Hub rate-limit theory for MinIO that was
**wrong**. What found it was boring: **naming every step and splitting the three-command database
step**, so the job list itself said where it broke. One screenshot then answered in seconds what
inference had failed at twice.

> A compound step is a diagnosis you have to earn. A named step is one you are handed.

### ⚠️ The expensive lesson: rule out your own tooling before believing a red

Five times a failure turned out to be my environment, not the code:

1. a database I had **already migrated**, so the fresh-DB path was never exercised
2. `ci-local.sh` calling `psql -U postgres -d school`, bypassing the URL — it passed while CI failed
   on identical SQL, hiding #3 at exactly the step under test
3. `node:22-slim` without `openssl` → Prisma loaded a `debian-openssl-1.1.x` engine → **all 51 suites
   failed identically**, pure noise
4. `pnpm test:integration -- --testPathPattern x` → jest took `--` as a pattern, ran 0 tests
5. `cat > file` combined with a backgrounded `docker run` in one SSH call → the background job ate
   stdin, the file landed **empty**, and the suite "contained no tests"

**The rule:** before believing a failure, confirm the thing under test actually RAN. A 0.2-second
suite and a 0-line file both said plainly that it had not. Every layer between you and the assertion
— pnpm, jest args, docker, ssh, stdin — can manufacture its own red.

**And the corollary:** a reproduction that takes a different route to the same place is not a
reproduction. Item 2 above is the whole lesson in one line.

### Nine of ten failures were a cascade

`maintenance.e2e-spec` reported `Cannot read properties of undefined (reading 'school')` nine times —
because `platform` was never assigned when the module failed to compile. The real error, the missing
provider, appeared **once**, second in the list. Reading the first failure would have sent someone
hunting a null-safety bug that does not exist.

### What is now protected that was not

`pnpm verify` (the static gates, runnable locally), `pnpm ci:local` (the whole workflow against
throwaway services), `packages/` linted at all for the first time (74 files), every CI step named,
and the worker guard covered by a test of its own.

## Newness is about when you found out, not about the day being described (2026-09-15)

Shipping closure notifications (N3, [[Notifications Plan]]) exposed a badge that could never be
cleared. The unread count compared each item's `at` to `User.notificationsSeenAt`; a closure's `at`
is **the day it describes**, so "shut tomorrow" is a future timestamp and `at > seenAt` stayed true
no matter how often the bell was opened.

The fix was a column, not a condition: `holidays.created_at` records when a closure was *declared*,
and a notification item may carry an internal `knownAt` that newness is judged on while `at` remains
what is displayed.

⚠️ **The shape, again:** it presented as a UI annoyance and was a missing fact in the data model.
Any derived "unread" needs two timestamps whenever the thing described is not the thing that
happened — and every feed item about the future has that property.

## Opt-in is a cost control, and a default-on checkbox is not opt-in (2026-09-15)

Closure SMS had been deferred on the grounds that there is no SMS budget. It shipped as an explicit
per-closure tick, defaulting to off and **never remembered between closures**, because one click
fans out one message per enrolled student: 400 students × 2 segments of Urdu = 800 of a BASIC plan's
1,000 monthly segments.

A checkbox that remembers "yes" spends the next school's credits without being asked. And the
failure mode is not only money: a school that texts every half-day teaches families to ignore the
messages just as surely as silence does.

## The vendor console's session is host-only; the tenant session is not (2026-09-15)

Two cookie families, two different answers, and the difference is not an inconsistency to tidy up.

**Tenant** (`access_token` / `refresh_token` / `csrf`) carries `Domain=<apex>` because a staff
session must survive the move between `demo.<apex>` and `owner.demo.<apex>`. Sharing is the feature.

**Platform** (`platform_access_token` / …) now sends **no `Domain`**. The console lives at exactly
one host and `@sw/api-client` calls `/api/v1` relative to the page, so the cookie was never needed
elsewhere — but with a Domain the browser attached it to **every request to every tenant
subdomain**, including hosts whose content a school controls. Nothing could spend it there (the
tenant guards read different names, which is why the two families have distinct names at all), yet
the account that provisions and suspends tenants should not hold the widest transmission scope in
the system. Least exposure, not least effort.

⚠️ **Consequence to remember:** `admin.<apex>` is an alias for the console, and a session opened at
`superadmin.<apex>` does not carry over to it. Pick one host.

⚠️ **The test for this had to be a UNIT test.** Every integration spec runs with
`COOKIE_DOMAIN=localhost` — a single-label domain browsers reject as a `Domain` attribute — so the
cookie is host-only there whatever the code says, and an assertion made in that environment would
have passed identically before the change. A real apex is the only configuration where the two
families differ. `platform.cookies.spec.ts` pins both halves, including that the tenant cookie
still shares, so a future "consistency" fix cannot quietly break staff navigation.

### Correction to something recorded earlier in conversation

Superadmin and a tenant role **can** be signed in simultaneously in one browser profile — the
distinct cookie names were designed for exactly that. What cannot coexist is **two tenant roles**
(staff and student): same cookie names, same domain, so the second login evicts the first.

## The session belongs to the door, not to the apex (2026-09-15)

Operator need: sign in as staff, student and owner **at the same time in one browser**. They could
not — all three go through `issueSession()` and got the same cookie names under `Domain=<apex>`, so
the second login silently evicted the first. An office computer could not hold the fee screen and a
parent's portal view open at once.

Fixed by dropping `Domain` from the tenant cookies, making them host-only like the platform ones.

⚠️ **What made this safe is a fact about the front-end split, and it was worth checking rather than
assuming:** every door now has its **own login page on its own origin** (`staff-web/app/login`,
`owner-web/app/login`, `student-web/app/login`), and the apex `/login` is only a *chooser* reached
while signed out. So a session is always issued on, and read back from, the same host. Nothing
depended on the sharing any more — it was a leftover from when the doors were paths in one app.

### Two things that were ALREADY broken, found by looking

1. **The apex landing page** redirected a signed-in visitor with `router.replace(landingPath(roles))`
   — a path the marketing app does not serve. Since the split that was a 404, not a dashboard. The
   effect is now removed rather than repaired: with host-only cookies `api.me()` there can never see
   a session, and the apex is a public page whose way in is the door chooser.
2. **Break-glass opened `<school>.<apex>/break-glass`**, but that route is mounted only on owner-web
   and staff-web — so the vendor operator landed on the marketing app, which has no such page. Now
   points at the **owner** door, which is also where the token belongs: it is minted with
   `roles: ['OWNER_ADMIN']`.

### ⚠️ The integration test I planned and deliberately did NOT write

The plan called for "a session issued on one door host is not accepted on another". **That test
would have been a lie.** Supertest sends whatever cookie you hand it regardless of the `Host`
header, and the server is right to accept it — which host presented a cookie is a *browser*
concern, enforced by the browser. The assertion would have failed, and "fixing" it would have meant
teaching the server to distrust its own valid tokens.

Scope is pinned where it is actually decided, in `platform.cookies.spec.ts`, as a unit test — and it
has to be a unit test, because every integration spec runs `COOKIE_DOMAIN=localhost`, a single-label
domain browsers reject as a `Domain` attribute, so cookies are host-only there whatever the code
says.

### Consequence to remember

**Signing out is now per-door.** Logging out of staff does not end a student session in the same
browser. That is the honest price of separate sessions.

## Cross-door links are derived from the host, never built from "this origin" (2026-09-16)

Two links handed out from the owner door were broken, both silently, both since the front-end split:
Campus Hub's **campus login** pointed campus admins at the owner door (which refuses anyone but
OWNER_ADMIN with the same "invalid credentials" as a wrong password), and the **Admission Portal**
link pointed at `/admission-portal`, which only staff-web serves — a 404. Each was
`${window.location.origin}/…`, correct when every door was a path in one app, wrong once
`packages/school-ui` rendered on more than one door.

**Fixed with `doorOrigin(door, location)` in `@sw/roles`**: swap the leading door label in prod
(`owner.<school>.<apex>` → `staff.<school>.<apex>`), swap the port in dev (`demo.localhost:3005` →
`:3006`).

⚠️ **The `NEXT_PUBLIC_*_URL` build variables were rejected on purpose.** The test deploy sets them to
`staff.demo.<apex>` — the DEMO school — and one image serves every tenant, so a build-time URL sends
the second school's owner to the first school's door. The school is knowable only from the host.

⚠️ **`owner`/`staff`/`student` are NOT reserved subdomains** — I first assumed they were. The helper
is correct anyway because door hosts are always two-deep with the door label first, so a school
named `staff` gets `owner.staff.<apex>`; pinned by a test.

Guarded by `packages/school-ui/src/cross-door-links.spec.ts`, which fails on any
`window.location.origin` in that package (comments stripped, so explaining the rule cannot trip it).

## An override flag in a request body needs its own role check (2026-09-16)

`PromoteDto.overridePreconditions` was documented *"OWNER_ADMIN: bypass fee-clearance"*, and
`WithdrawDto.overrideFeeClearance` carried the same intent. **Neither was enforced.** Both routes
admit CAMPUS_ADMIN, and `@Roles` gates the ROUTE — it cannot see a flag inside the body. So a campus
admin could promote or withdraw a student past the school's own fee-clearance rule.

Both services also found their target **by id alone**, which RLS scopes to the school but not the
campus: a campus admin could promote another campus's section, or withdraw another campus's
student — disabling their login and issuing their leaving certificate.

**Fixed:** `assertOwnerOverride(user, flag, what)` in `libs/common/src/authz/owner-override.ts`, called
first in both services, plus `assertCampusAccess` on the section's / student's campus.

⚠️ **OPERATIONS_ADMIN cannot override, deliberately.** `user.roles` holds granted roles, and the only
hierarchy (`rolesSatisfying`) never adds OWNER_ADMIN. An override bypasses a financial control, and
the deputy is exactly the role that control is meant to hold.

⚠️ **Proven, not assumed:** with the service changes stashed, all four refusal tests FAIL (the owner
case passes either way, as it should) — so the tests detect the defect rather than merely agreeing
with the fix. Found while verifying a permission matrix row against the service instead of the
comment above the DTO field; comments describing an authorization rule are not the rule.

## Two-factor is enforced on corrections and disclosures, not on routine work (2026-09-16, D1)

"Two-factor authentication is required for your role" had been a red banner with **no enforcement
anywhere**. Decision D1: enforce it, on sensitive actions only, for the mandatory roles
(OWNER_ADMIN, OPERATIONS_ADMIN, ACCOUNTANT).

**The line is "undoes or discloses", not "touches money".** Gated (`@RequiresMfa`, 11 routes):
reverse a payment, waive an invoice, reveal a CNIC, approve payroll, mark a payslip paid, and every
change to who holds what access — update, access grant, module toggle, delete, bulk delete, and
resetting another user's password (an account-takeover vector). **Not gated:** collecting a fee,
recording an advance (a deposit, not a correction), creating a user. Gating the counter would stop an
unenrolled accountant taking money the morning this ships.

⚠️ **The flag rides on the access token (`mfa` claim), not a DB read in the guard**, because guards
run before the tenant transaction and RLS returns nothing there. The cost is staleness, so **setup,
verify and disable each re-sign the access cookie** — otherwise an owner who has just enrolled is told
to enrol for up to 15 minutes, and one who disabled it keeps a token vouching for a factor that is gone.
A pre-existing token has no claim and is treated as unenrolled; it self-heals at the next refresh.

⚠️ **A trap found while repairing the suites:** `ops-admin-authz` asserts 403 from the deputy's grant
CEILING. An unenrolled deputy gets 403 from the two-factor guard first — same status — so those cases
would have kept passing while no longer testing the ceiling. The deputy is now enrolled before them.
Any test asserting a bare 403 on a gated route has this hazard; the guard runs after `RolesGuard`, so
role refusals still win, but a service-level refusal does not.

`test/integration/support/login.ts` now completes the MFA challenge for accounts enrolled via
`support/mfa.ts`, so specs signing an enrolled owner in repeatedly need no per-call change.

Proven: with the guard unregistered, the two enforcement cases in `mfa-enforcement.e2e-spec.ts` fail
and the three "must not over-block" cases pass. Full integration 52/52 (1177), isolation 7/7.

⚠️ **Noticed, not fixed (out of scope):** TOTP codes are not single-use — only recovery codes are. A
code seen alongside a stolen password can be replayed inside its ~30s window.

## The owner's money corrections live on the rows where the money is (2026-09-16, GAP-01)

Reverse, waive and record-advance were built, tested and role-restricted — and had no screen, so the
only person allowed to correct a mis-posted payment could not. They now sit on the student profile's
fee card: **Reverse** on each receipt, **Waive** on each invoice still owing, **Record advance** beside
the balance. Built on `ReasonedActionDialog` (plan foundation F1), which the later corrections reuse.

**Three defects found on the way, each on the path the buttons use:**

1. **The fee card fetched the SCHOOL's latest 100 payments and filtered in the browser.** Once a school
   passed a page of payments, a student's older receipts vanished from their own profile with no error.
   `GET /fees/payments` now takes `studentId`. ⚠️ Student and campus both constrain the payment's
   invoice, so they are built as ONE `invoice` filter — two assignments to `where.invoice` would let the
   second discard the first and lift the campus restriction; pinned in campus-scope.
2. **A double-clicked reversal returned 500.** The "already reversed?" read cannot see a concurrent
   request's insert; the UNIQUE on `payment_id` refused the second as a raw P2002. Now a clean 409.
   The receipt counter is a row update inside the request transaction, so the rollback returns the
   number — and the row lock serialises the two requests. Proven: without the mapping, `[201, 500]`.
3. **`idemKey()` mints a fresh key per call**, so using it for the advance would make a double click two
   deposits. The key is created once when the advance dialog opens and reused on retry.

⚠️ **A reversed payment stays visible**, struck through and linked to its `RV-` receipt. The list now
returns the reversal on the payment instead of the row being hidden: hiding it would make a corrected
mistake look as though it never happened.

⚠️ **I nearly shipped wrong copy.** The waiver dialog said "the totals are never edited". `waive()` adds
a negative WAIVER line AND sets `totalAmount` to match, which is what keeps `total = Σ items` true for
the integrity check. Read the method, not the docstring.

The UI role sets are exported from `@sw/roles` (`FEE_REVERSE_WAIVE_ROLES`, `FEE_ADVANCE_ROLES`) and
`fee-permissions.spec.ts` pins them for every role against values copied from the API's `@Roles`,
including the deputy reaching advances through the hierarchy.

## Guardians are editable after admission, and "primary" is treated as routing (2026-09-16, GAP-07)

The many-guardian model existed from the start and was write-once through the admission form. The
student profile now carries a guardians card: add, edit contact, change relation, make primary,
remove, and verify a phone inline.

**Three defects found building it, each proven by a test that fails with the fix reverted:**

1. **`PATCH /students/:id/guardians/:gid` accepted `relation` and ignored it** — 204, nothing changed.
   Same shape as the earlier `PATCH /students/:id` that accepted record fields and wrote none of them.
2. **A student's only guardian could be non-primary**, because `link()` took `isPrimary` literally.
   Every receipt and SMS resolves the primary, so that family was contacted by nobody while the profile
   showed a guardian on record. The first guardian is now primary regardless.
3. **A concurrent primary change surfaced as a 500.** The partial UNIQUE index
   `student_guardians_one_primary_per_student` correctly refuses a second primary; the refusal is now a
   409. ⚠️ The test accepts either serialised outcome (both 204, later wins) or a collision (204 + 409):
   the invariant is "never a 500, exactly one primary", not a particular winner.

**New: `PATCH …/guardians/:gid/contact`** (name, phone, email, occupation). Nothing could edit a
guardian's own record before — the register's exact case, "a father's number changes".

⚠️ **It edits the PARENT, so it applies to every child they are guardian of.** The response returns
`childCount` and the form warns before saving when that is more than one.

⚠️ **A changed number is unverified again, which stops SMS to it.** Verification proves control of a
number and does not carry to a different one; every dispatcher skips unverified phones. The screen says
so on save and offers "Verify now", rather than letting the next absence notice go nowhere.

⚠️ **A number another guardian already holds is refused**, exactly as on CREATE, with that record's id,
so the office links them instead. Two records sharing a phone would text a household twice.

CNIC deliberately stays out of the contact edit: it is encrypted and read back only through the
audited reveal. OTP routes were checked for campus scope before building on them — `loadScopedParent`
already enforces it.

## Withdrawal and issued documents: a UI job that turned out to be a security fix (2026-09-16, GAP-04/14)

The plan called withdrawal "almost entirely a UI job" because the backend workflow existed. Reading the
documents module before building on it found **an access-control hole and three integrity defects**.
Every one was shown failing against the old code before being fixed.

**Security (proven with live responses before the fix):**
- `GET /documents?studentId=` and `GET /documents/:id/url` had **no `@Roles` and no ownership check** —
  `getUrl` was DOCUMENTED "after an ownership check" and performed none. An accountant on campus A got
  **200** listing a campus-B student's documents and **200** minting a download link. Now issuer roles
  only, and campus-scoped by the student's most recent enrolment (a withdrawn student has no active one,
  and the admin who withdrew them must still reach the certificate).
- `issueCertificate` honoured `overrideFeeClearance` for campus admins (**201**) and had no campus check —
  the B12 class, on a third route that 0.3 missed. ⚠️ Lesson: fix a defect CLASS by searching for every
  instance (`grep overrideFeeClearance`), not only the instances named in the plan.

**Integrity:**
- **A FEE CLEARANCE certificate — "has cleared all outstanding fee dues" — was issued with no fee check at
  all** (owner got **201** for a student who owed). Now refused while anything is owed, and no override
  applies: no permission makes that sentence true.
- **Withdrawal issued that same certificate even when the owner overrode because money WAS owed.** Now
  issued only when fees are actually clear; the response says `leftOwing`.
- **Invoices already raised for months after leaving stayed owed**, aged into OVERDUE, and put a family
  that left owing nothing on the defaulter list (which does not look at enrolment). Withdrawal now closes
  them with a WAIVER line naming the leaving date. Anything for a month that had BEGUN stays owed —
  withdrawal is not a write-off (D6).
- **B6:** `feeCleared` counted an invoice for a month that had not begun, blocking withdrawal for money not
  yet owed. Now judged against the period's first day.

**Also:** an office-set `leavingDate` (not in the future) drives both `endedAt` and which months are
"after leaving"; every withdrawal is audited `STUDENT_WITHDRAWN`, with `WITHDRAWAL_FEE_OVERRIDE` only when
fees were really owed (previously every withdrawal was logged as an override).

⚠️ **Transactional ordering is load-bearing.** Future invoices are waived BEFORE the fee check, so a refused
withdrawal must roll them back — and it does, because the whole request is one transaction and
`AuditService` writes through the same client, so no phantom `FEE_WAIVED` row survives. Pinned by a test.

⚠️ **A weak test caught in review:** the "not a defaulter after withdrawal" case passed against the OLD code
for the wrong reason — the withdrawal was refused, so the student never left. It now asserts the 201
first. Running new tests against the old code is what exposed it.

UI: `WithdrawalCard` computes owed / after-leaving with the server's own period rule so the outcome is
visible before confirming; only the owner sees "let them leave owing it". `IssuedDocumentsCard` offers a
leaving certificate only for a student who has left.

## Sweep, don't spot-fix: a cross-campus salary leak found by looking for the class (2026-09-16)

After the documents hole I swept the API for the two defect classes found that day instead of trusting
the plan's list:

- **Override flags honoured without a role check** — clean. Every other override is either enforced
  (student attendance checks `isAdmin`), sits on an admin-only route (staff attendance), is a documented
  soft-warn for the one role that performs the action (`ageOverride`), or is derived rather than sent
  (`overrideAdmit`).
- **Routes that mint presigned download URLs** — six call sites. Claims proof, payment proof, the receipt
  PDF and the student photo were already scoped. **`payslipPdf` was not**: it treated ANY campus admin as
  an admin, so a campus-A admin downloaded a campus-B teacher's salary slip (**200**, shown before the
  fix). Now campus-checked against the run's campus; a staff member's own payslip is always theirs.

⚠️ The shape to remember: `caller.roles.some(r => r === 'CAMPUS_ADMIN')` answers "is this an admin", never
"is this THEIR admin". Any hand-rolled admin check needs `assertCampusAccess` beside it.

## The activity log: readable, campus-scoped, and cursor-paged (2026-09-17, GAP-06 / B8 / F3)

Every sensitive action was audited and none could be read without database access. `/activity` now
shows who did what, when, and the reason given, filterable by action and date, with before/after
values on demand, and deep-linkable per record (`/activity?entityId=…`, linked from the student profile).

⚠️ **A cross-campus leak came first.** CAMPUS_ADMIN may read `/audit-logs`, and `list()` applied no
campus filter: a campus-A admin read the whole school's log — campus-B reversals, withdrawals, reasons,
and before/after values carrying guardians' phone numbers. An audit row has no campus, so campus-bound
readers now see entries whose ACTOR is on their campus; those people can only act on that campus. The
owner's and deputy's entries are the owner's log. ⚠️ Honesty note: the before-run for this case failed on
a 500 (the old service cannot read the new query shape), not on the leak itself — the leak is established
by reading `list()`, which had no filter at all.

**Keyset paging (plan foundation F3, `libs/common/src/dto/keyset.ts`)** replaces `skip/take + count()`.
Offset on an append-only table is not just slower each month; it is wrong — an entry written mid-read
shifts every later page, so rows repeat or vanish. The cursor is `(createdAt, id)` with `id` as tiebreak,
because `createdAt` alone is not a total order; `take: limit + 1` answers "is there more?" without a
count. A tampered cursor is a 400, never a silent restart from the top. `audit-log.e2e-spec` walks seven
entries sharing ONE timestamp while a newer entry is written mid-browse, and asserts no duplicate and no
skip — which fails against the old offset code.

The UI says "Load older", never page numbers, and states that campus admins see their own campus's
people, so an owner's action missing from their view reads as scope rather than a gap in the record.

## Reports ask for things by name and answer in names (2026-09-17, GAP-09 / F2)

The Reports screen labelled every parameter with its field name and made each a text box, so three of
seven reports (fee ledger, attendance register, exam summary) needed a UUID no screen ever shows. And
the outputs had the same disease: **class strength — the report an owner reads every term — returned
bare `classId`/`sectionId`**; attendance register and exam summary returned `enrollmentId`; fee ledger
returned `invoiceId`. Both sides are now names: student, GR number, class and section, period, balance.

- **Pickers** — `StudentPicker` (plan foundation F2): server typeahead over the existing
  `students_full_name_trgm` GIN index, 2-character minimum, 250 ms debounce, AND an `AbortController`.
  ⚠️ Debounce alone does not stop a slow response for "Al" landing after "Ali" and overwriting it;
  cancellation does. `apiGet` gained an optional `signal` for this.
- ⚠️ **The lookups live under the REPORTS roles** (`/reports/lookups/{students,sections,exams}`), not on
  `/students`, because the general routes do not admit ACCOUNTANT — a picker built on them would work for
  the owner and silently return nothing to the person who runs the fee ledger most. Campus-scoped;
  student lookup includes pupils who have left, since a ledger is most often wanted for exactly them.
- **Validation** — ids are `@IsUUID`, dates `@IsDateString`. They were `@IsString`, so a missing id reached
  Prisma as `''` and came back as a 500. A required parameter now returns 400 "Choose a student…", and
  the screen disables View and Download until it is chosen.

⚠️ **Known, not fixed (separate item):** the Fees screen resolves student names from
`/students?pageSize=100` — refused to ACCOUNTANT and truncated past 100 students. Same shape as the
fee-card bug fixed in GAP-01.

## Defaulters: a working list, a campus leak, and a reminder nothing could send (2026-09-17, GAP-13)

**Leak first, proven before the fix.** `/fees/defaulters` admits CAMPUS_ADMIN and ACCOUNTANT, and
`invoicing.defaulters()` used the client's `campusId` as-is. A campus-A accountant who sent none
received campus B's defaulters — names, GR numbers, amounts owed (the test got both students). Now
`effectiveCampusFilter`. ⚠️ The reports copy of this same query already forced the campus: two
implementations of one question, one of them safe. Third instance today of "a campus-bound role on a
route whose service trusts the client or checks nothing" (documents, payslips, audit log, defaulters).

**`/defaulters` screen.** Each row carries the primary guardian, a `tel:` number, days overdue since
the oldest due date, and **`canText`** (verified AND not opted out), resolved in the same query as the
invoices — not one guardian lookup per row. Rows that cannot be texted cannot be ticked and say "call
instead", because a reminder queued to them is silently dropped while the office believes the family
was told. Dashboard tile and bell notification now point here, not at a report dropdown.

**Fee reminders — the `FEE_REMINDER` template existed and NOTHING sent it.** Built the pipeline:
job type, producer, dispatcher, `POST /fees/defaulters/reminders`.
- ⚠️ **Ids in, never amounts.** Each balance is re-read from the defaulter query at queue time, so a list
  left open all morning texts today's figure, and scope comes from that same query.
- **Once per family per day**: the queue job id and the dispatcher dedupe key both carry the date.
- **Not transactional**: a reminder honours opt-out and never overdrafts credits, unlike a receipt.
- ⚠️ The default wording said "is due on {dueDate}" — to a DEFAULTER, whose due date is weeks past. Now
  "is outstanding since {dueDate}".

Also: `/students?student=<id>` opens a profile directly, so other screens can link to one.

## Campus comparison, and the dashboard counted reversed money (2026-09-17, GAP-11)

Campus Hub now opens with one row per campus — active students, today's attendance WITH how much of the
register is marked, collected this month, overdue, defaulters — for the owner and deputy; hidden for a
single-campus school. `GET /campuses/summary` is five Prisma queries whatever the campus count, grouped
in memory. Raw SQL was avoided on purpose: the dashboard records that raw reads bypass the tenant
extension, the first of the three isolation layers.

⚠️ **Found while matching figures:** the dashboard's "Collections (month)" and its six-month trend
**counted reversed payments as collected**, overstating every month by the corrections made in it.
Both now filter `reversal: null`, so the dashboard and the comparison agree; pinned in `fees.e2e-spec`.

⚠️ **Tooling lesson:** the route first landed on the ACADEMIC-YEARS controller. The edit anchored on
`@Roles(...STAFF_ROLES) @Get()`, which occurs in more than one controller, and it compiled because that
controller also injects `SetupService`. Only the route-level test (404) caught it. Anchor edits on text
that is unique, e.g. include the `@Controller(...)` line.

⚠️ **Environment:** a `pnpm start:worker` shell with no living parent keeps relaunching the dev worker,
which `no-worker.js` then reports as "started DURING this run". Kill the `sh.exe` root, not the node child.

## "Setup complete" now means the school can bill (2026-09-17, GAP-12)

The wizard ended at classes and said "Setup complete — you can admit students". A new owner did, then
could not invoice anyone: fee heads and prices live on the Fees screen the wizard never mentioned. Fees
are now **step 4**, done when every class has an ACTIVE price for the CURRENT year — a class priced only
for last year bills nothing this year, which is exactly when a school finds out.

The rule is a pure function (`packages/school-ui/src/lib/setup-readiness.ts`) with a unit spec, not logic
inside a component nothing tests. Owner and deputy get a link to Fees; a campus admin — who can read
prices but not set them — is told the owner sets fees.

⚠️ Caught in my own wiring: blocked classes were first matched by NAME. Two campuses can each have a
"Grade 1", so a blocker on one would have flagged both. Matched by id.

## Year-end promotion: preview, exceptions, one atomic commit (2026-09-17, GAP-03)

The largest operation in a school year had an endpoint and no screen, and the endpoint could not have
survived one. Rebuilt backend-first; `/promotion` is the screen.

**Rules live in a pure planner** (`promotion-planner.ts`, 16 unit tests); the service only loads inputs
and writes the result.
- **B2** — the top class had no destination and errored every year. It now COMPLETES, using
  `EnrollmentStatus.COMPLETED`, which already existed and nothing wrote — so no migration; this replaces the
  `GRADUATED` status proposed in Decision D2. Completed and leaving students become `isActive: false`.
- **B3** — "next class" was `order + 1`; deleting a class broke promotion out of the one below. Now the
  next HIGHER order in the same campus.
- **B4** — the fallback section ignored HARD capacity. Seats are counted as students are placed, shared
  across sections (1-A and 1-B both fill Grade 2), and a student with no seat is blocked by name.
- **B6** — fee clearance (on by default) counted invoices for months not yet begun.
- **B1** — ~4 queries per student became a fixed nine to load, one `updateMany` per outcome and one
  `createMany` to write. ⚠️ Not asserted by a query counter — Prisma query events need logging configured
  at client construction, which the shared test app does not do. The bound is structural: no per-student
  await remains.

**B5/F4 — preview then commit with a fingerprint** of the decisions (not names, so a spelling fix does not
invalidate a review). Commit recomputes and returns 409 if anything changed — pinned by admitting a
student between preview and commit.

⚠️ **Deviation from the plan, deliberately:** the plan said "commit per section, resumable". With batched
writes a whole campus is a handful of statements, so the commit is ONE transaction over the campus —
all-or-nothing is safer than a half-promoted campus, and a re-run skips anyone already placed. A
concurrent double commit hits the one-ACTIVE-enrolment-per-year index and returns 409.

⚠️ **The re-run trap:** a RETAINED student's new-year enrolment is ACTIVE in the same section. The source
query must exclude the target year, or a second run moves them again.

The screen lists blocked students first, and Promote stays disabled while any choice differs from the
last preview, so the fingerprint is always of the list on screen. The original `POST /promotions` still
works, re-implemented over the planner.

## Payroll gets a screen (GAP-05, 2026-09-17)
- `/payroll` (owner door only — OWNER_ADMIN): draft a campus-month, review each payslip WITH its arithmetic (working days, unpaid leave, absences, whether the school deducts absence), discard a draft to recompute, approve (MFA, final), mark paid once per payslip, PDF.
- Staff who were left out (no salary structure) are named on the run, not silently skipped.
- Salary is set on the Staff screen (💰 Salary, OWNER_ADMIN + CAMPUS_ADMIN). A raise is a NEW structure from a date, never an edit — past months stay as computed. HR does not set pay (separation of duties; D3 withdrawn).
- Security fix shipped with it: `GET /staff/:id/salary-structures` had no `@Roles`, so teachers could read colleagues' salaries.
- Draft runs block their month until discarded; approved runs cannot be discarded; mark-paid refuses a second time (409); concurrent drafts of one month → one run, 409 not 500.
- My Payslips empty state now explains payslips appear once the school approves a month.

## SMS broadcast by audience (GAP-15, 2026-09-17)
- `POST /sms/broadcast/preview` + `POST /sms/broadcast` (OWNER_ADMIN, CAMPUS_ADMIN). Audience = active students in campus/class/section → primary guardian → one phone per family; verified and NOT opted out. The client never sends phone numbers.
- Campus is forced for campus-bound callers; class/section only narrow within it.
- Send carries `expectedRecipients` from the preview; a changed audience → 409. Credits short → 409 INSUFFICIENT_SMS_CREDITS and nothing queued (no half-sent broadcasts). Audited as SMS_BROADCAST_SENT with body and counts. Queued in chunks of 100.
- Counting rules are a pure function (`comms/broadcast/broadcast-audience.ts`, unit-tested).
- ✅ Fixed (item 9, same day): opt-out is enforced AT SEND TIME in `SmsService` for MANUAL (hand-typed /sms/send, broadcast, retry) and FEE_REMINDER — per blueprint §14 "honored for MANUAL sends; transactional sends always allowed". ABSENCE, FEE_RECEIPT, LEAVE_STATUS, RESULT_READY and SCHOOL_CLOSED are treated as transactional and still reach opted-out parents (pending owner decision). Withheld sends log FAILED `SMS_OPTED_OUT`, 0 segments, no credit. The FEE_REMINDER doc comment claimed `sendOne` honoured opt-out — it never did.
- Retrying a withheld log (SMS_OPTED_OUT / PHONE_UNVERIFIED) is refused 409: its stored body is the placeholder "(withheld: …)", which a retry used to text to the parent. The SMS screen labels these reasons and hides Retry for them.

## Browser click-through for the owner gaps (item 8, 2026-09-17)
- `test/e2e/owner-gaps.spec.ts` (Playwright, live dev stack): owner sees Reverse on a paid receipt while the accountant door offers it nowhere; all 7 reports run with pickers and no id typing; the Campus Hub login link opens the staff door and a campus admin signs in through it; /payroll, /defaulters, /activity, /promotion open, and the broadcast audience check returns a count with no 5xx.
- ⚠️ Gotchas: Next.js mounts an empty `role=alert` route announcer, and the two-factor banner uses `.toast.err`, so "no error" must be asserted by the result rendering, not by the absence of those selectors. A `<select>`'s options are `role=option` too — scope picker options to their listbox.
- ⚠️ The dev API on :4000 was running a stale `dist` build (new routes 404'd). Rebuild with `nest build api` before browser runs.

## Cash payroll (2026-09-17) — agreed with the product owner
- **Model:** one fixed monthly salary (no allowances/bonuses/advances/fines/tax); paid in **cash**; full month for mid-month joiners/leavers. Deductions: approved unpaid leave always; absence only if the school's `payrollDeductsAbsence` setting is on. Day rate = salary ÷ working days.
- **Roles:** owner / campus admin set salaries. The **campus ACCOUNTANT** drafts, discards and marks paid for their own campus; the **owner** does the same for any campus (covers a campus with no accountant) and is the only approver. The accountant never sees salary history — only amounts inside a run.
- **Self-payment refused** (`SELF_PAYMENT_FORBIDDEN`, 403, by user id): the owner records the accountant's own salary.
- **`payslips.paid_by_id`** (nullable, no FK so a departed accountant never blocks history) records who handed the cash over; `PAYSLIP_MARKED_PAID` audit row per payment. Method optional → CASH.
- **Staff see APPROVED payslips only** (`/payslips/mine` and the PDF). A draft PDF is 404 to anyone but the owner and the campus accountant; campus scope is checked first so another campus's slip stays a 403.
- ⚠️ Opening `/payroll-runs` to a campus-bound role exposed that `run/getRun/discard/markPaid` found records by id alone — safe only while the owner (school-wide) was the sole caller. `assertCampusAccess` added in the same change.
- `SALARIES_TO_PAY` notification for OWNER_ADMIN/ACCOUNTANT (approved + unpaid, excluding the caller's own payslip).
- PDF lines come from pure `payslipLines()`: Monthly salary, Unpaid leave (n days), Absence (n days), legacy allowance/fixed lines only when present.
- The attendance-lock message no longer tells people to "reverse the payroll run" — no such action exists.

## Dashboard campus lens & money scoping (#7, 2026-09-22) — decision with the product owner
- **Canonical money-scoping rule = the invoice's enrolment campus (Option A).** Every rupee (collections, month total, defaulters, trend) is attributed to `invoice.enrollment.campusId` — the campus the invoice was raised against — never the student's *current* enrolment. Historic money never moves campuses when a student transfers, and an audited receipt stays put. Headcount/attendance follow the *current* active enrolment campus; that is a different question and is fine to differ.
- This rule was already applied consistently in every money query (insights, reports.defaulters, invoicing.defaulters/invoices, claims, payments, reconciliation). No divergent query existed. The gap was that the **owner dashboard ignored the campus lens**: `DashboardService.get()` scoped only by `restrictedCampusId(user)` (null for the owner), so the owner's headline numbers were always school-wide.
- **Fix:** `DashboardService.get(campusId?)` now uses `effectiveCampusFilter(user, campusId)` — a campus-bound user is still forced to their own campus (fail-closed `NO_CAMPUS` preserved), the owner gets the selected lens (undefined = whole school). Controller accepts `?campusId=` (UUID DTO declared *above* the controller — a DTO referenced by `@Query()` below its class hits a TDZ `ReferenceError` at boot). api-client `dashboard(campusId?)` forwards it; owner-web dashboard passes `useCampusLens().campusId` and re-fetches on lens change.
- Verified live: Falcon lens → 21 students / Rs 0 / 0 defaulters; E2E lens → 0 students / Rs 170,000 / 1 defaulter; campus enrolments sum to the whole-school 21.
- ⚠️ **Known follow-up (belongs to B1 owner-home redesign):** the *Needs attention* strip + bell come from `notifications.list()` and stay **school-wide**, so with a campus lens the strip can say "1 fee defaulter" while the Collections card (lens-scoped) says "0 defaulters". Not a bug in either — different scope — but the two need a scope label side by side.

## Verifying a payment stays un-gated by MFA (#17, 2026-09-22) — decision with the product owner
- The 2FA gate sits on the *harmful/irreversible* money actions only: `waive` and payment `reversals` carry `@RequiresMfa()`. **Verifying a payment does not, and will not.** Verifying is the routine, high-frequency counter action and it only *creates* a record — any mistake is itself reversible, and reversing is gated. Gating the everyday forward action would block normal work (and block it entirely until the owner enrols) for no real security gain. No code change; recorded so it is not "added for completeness" later.

## SMS `WITHHELD` is now a first-class status (A1, 2026-09-22)
- A message the school withholds on purpose (parent opted out, or number unverified) was stored as `FAILED` with a `(withheld: …)` placeholder body. That conflated a deliberate non-send with a real gateway failure, so the dashboard "failed SMS" count, the SMS-log filter and the reports usage table each had to special-case the message TEXT — and any row whose body did not start with that exact string leaked back into the failure count (the #4 dashboard bug).
- **Now:** `SmsStatus` gains `WITHHELD`. `logOptedOut`/`logUnverified` set it; the retry endpoint refuses it by **status** (409, with the opt-out / unverified-specific message) instead of by `failReason`; the dashboard failed-SMS count is a plain `status:'FAILED'` (no message-text NOT-filter); the reports usage table groups WITHHELD on its own; the SMS screen shows a "Withheld" badge (warn tone) with the reason beneath and offers no Retry, and has a Withheld filter option.
- **Migration:** two files — `20260922120000_add_sms_withheld_status` (`ALTER TYPE … ADD VALUE`) then `20260922120100_backfill_sms_withheld` (`UPDATE … WHERE status='FAILED' AND fail_reason IN ('SMS_OPTED_OUT','PHONE_UNVERIFIED')`). **Split on purpose:** Postgres forbids USING a new enum value in the same transaction that added it (each Prisma migration is one transaction). Backfill keys on `fail_reason`, not the placeholder text.
- ⚠️ **Windows:** stop the API dev server before `prisma migrate deploy` + `pnpm db:regen` — the running query engine holds `query_engine-windows.dll` and generate EPERMs (see CLAUDE.md).
- Verified: migrations applied; `db:regen` clean; typecheck (root + fe + e2e) green; on the demo tenant the backfill moved **25** rows FAILED→WITHHELD leaving **FAILED=0** (its "failures" were all withheld all along). Verified live in the browser: /sms shows the Withheld badge + "Number not verified" + no Retry, the Withheld filter works, and the header "Recent failures" reads 0. Integration assertion updated (`sms-broadcast.e2e-spec.ts`: opted-out send → `status:'WITHHELD'`); QA SMS-04 spec already asserts reason-text + body + absent Retry, which still hold.

## Subject-name drift merge (A4, 2026-09-22)
- **Not a schema migration — a reviewable admin action.** The plan called A4 a "merge migration", but which spelling is canonical (`Math` vs `Mathematics` vs `Maths`) is a per-school judgement, so a blind SQL `UPDATE` guessing spellings would be wrong for some tenants. Instead: `POST /subjects/merge` (OWNER_ADMIN, CAMPUS_ADMIN), body `{ fromNames[], toName, dryRun? }`.
- A `Subject` is per class (`@@unique([classId, name])`), so drift is inconsistent NAMES across classes, never two rows in one class. The merge, per class: if the target name is absent it **renames** the drifted row; if present it **merges** — repoints the drifted row's exam results, teacher assignments, timetable slots, section links and class tests onto the canonical row, then deletes it. Two drifted rows in one class: the first is renamed and becomes the winner the second merges into.
- **Collision-safe repoint** (`repointSubjectRelations`): the two spellings share a class, so a section/exam/enrolment can appear under BOTH → a naive `updateMany(subjectId)` would violate a unique key. For ExamResult `(examId,enrollmentId)`, TeacherAssignment `(staffId,yr,sectionId)` and SectionSubject `(sectionId)` the drifted row's colliding children are deleted first (the canonical row's copy survives), then the rest moved. TimetableSlot (unique on section/day/period) and ClassTest carry no subject-based unique, so they move wholesale. ⚠️ `deleteSubject` only blocks on results/assignments/slots — merge also repoints **sectionSubject and classTest**, which delete never considered.
- Runs inside the request `withTenant` transaction (like `deleteClass`) → atomic. Audited `SUBJECT_MERGED` (new action) with fromNames + counts; `entityId` is a representative canonical row (the column is `@db.Uuid`, so the name can't go there — it lives in `newValue`). `dryRun` returns identical counts and writes nothing.
- **Frontend** (`/subjects`): near-duplicate detection is client-side (case/prefix/edit-distance ≤2 over the catalogue names — detection needs no API), shown as a "Possible duplicates" card. Default canonical = the **most-used** spelling (highest `classCount`), then proper-case, then longest — so the rarer typo doesn't win. Two-step: pick name → **Preview** (server dry-run) → **Confirm**.
- Verified live in the browser: `Mathmetics`→`Math` (different classes → 1 renamed; catalogue 13→12, dupes card clears). And the collision path via API: a temp `Physicss` in 9th (which has `Physics`) with section A linked to both → merge returned `merged:1, sectionLinks:1`, **no 500**, `Physicss` gone, `Physics` intact. typecheck (root+fe+e2e) + lint (root+packages+fe) all green.
- Follow-up: an integration test for the repoint paths (the live check proved sectionSubject; exam-result/assignment collisions are the same code path but unseeded). `normalizeSubjectName` still only trims — a canonical-map auto-suggest on create (D2) remains open.

## Owner-home v2 behind a per-browser flag (B1, 2026-09-22)
- **Shipped dark behind a flag, not a cutover.** `useFeatureFlag('ownerHomeV2')` (`@school/lib/feature-flags`) reads `localStorage['ff:ownerHomeV2']`, opt-in via `?ff=ownerHomeV2` and cleared via `?ff=off` (or `?ff=-ownerHomeV2`). Off by default, so `/dashboard` is byte-for-byte unchanged for everyone until a reviewer turns it on in their own browser. This is the light pilot switch the deployment plan wants until real per-tenant flag infra exists — a convenience, never a boundary (the server still owns all scope/permission).
- The four B1 issues, all gated on `v2` in `dashboard/page.tsx`:
  - **#5 headline** — the H1 answers "what needs me?" (`"4 things need you today"` / `"You're all caught up"`) instead of `"Good evening"`; the greeting moves to the muted subline.
  - **#12 grey bar** — an all-unmarked day draws NO `RegisterBar` (the "0 of 21 · 21 not yet" statline already says it); a wall of grey is not an alert. Only drawn once ≥1 child is marked. v1 keeps the old bar.
  - **#13 context** — a "vs last month" line (▲/▼ %) from the six-month trend, shown only when the prior month had collections (guarded against divide-by-zero, so Aug=0 correctly shows nothing).
  - **#15 scope labels** — with a campus lens active, a pill names the campus on each metric panel and "Whole school" on the Needs-attention panel, so "0 defaulters" (this campus) beside "1 fee defaulter" (school-wide, from `notifications.list()`) reads as two scopes, not a contradiction. This closes the #7 follow-up.
- ⚠️ **Bug fixed unconditionally (not gated):** the collections trend was gated on `s.title === 'Finance'` after the section was renamed **'Collections'** (GAP-10), so `CollectionsTrend` had silently stopped rendering on every dashboard. Now `=== 'Collections'` — the six-month chart is back for v1 and v2 alike.
- Verified live in the browser: flag OFF → `"Good evening"`, grey bar present, no pills; `?ff=ownerHomeV2` → headline count, no grey bar, and with the Falcon lens the "Whole school" + "Falcon…" pills appear; `?ff=off` reverts. typecheck:fe + lint:packages green.
