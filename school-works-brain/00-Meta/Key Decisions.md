---
title: Key Decisions
type: meta
updated: 2026-07-14
---

# Key Decisions

The locked, cross-cutting decisions every note and every developer must respect.
Full ledger: [[consistency-register]] (LOCKED). This is the digest.

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
- **Platform (vendor) auth is a parallel path, not tenant auth (§24).** Platform admins live in a dedicated **`platform_users`** table (no `school_id`, **no RLS** — reached only via the platform_admin BYPASSRLS connection), because tenant `User.schoolId` is NOT-NULL under forced RLS and access tokens *require* a `sid` claim. Platform routes are **host-exempt** (`platform/*` excluded from `TenantResolutionMiddleware`, like health/webhooks) so they work on the reserved `admin` host with no tenant. They are marked `@Public` to skip the tenant guard chain (Csrf/Jwt/TenantScope) and add **`PlatformAuthGuard`** via `@UseGuards`. Distinct cookie names (`platform_access_token`/`platform_refresh_token`/`platform_csrf`) so a platform + tenant session can coexist in one browser under the shared `COOKIE_DOMAIN`; the JWT carries `typ:'platform'` (no `sid`) so it can never be accepted by the tenant `JwtAuthGuard`. Suspend/reactivate flip `School.isActive` and call `TenantResolutionMiddleware.invalidate(host)` so it takes effect on the next request (not after the 60s cache TTL). **Hardened (now at parity with tenant auth):** `platform_users` + `platform_refresh_tokens` DML **revoked from `app_user`** so the tenant runtime role can't read operator/refresh hashes even via a bug/injection; `PlatformAuthGuard` **re-checks `status` on every request** (disabling an operator revokes access immediately); and the access token is now **short (15m)** with a **single-use rotating refresh token** in `platform_refresh_tokens` (§22.4 — reuse of a revoked token revokes the whole `familyId` = theft signal; logout revokes the family; the `/admin` client silently refreshes on 401). Covered by `platform.e2e-spec` (rotation + reuse-revokes-family + logout-revokes).
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

## Authorization: the read is the half that leaks (added 2026-08-04)
- **A guarded write does not imply a guarded read.** Four fee reads shipped with no `@Roles` beside writes that were all correctly `OWNER_ADMIN` — and that is precisely what hid them, because the module *looked* guarded. When adding an endpoint, decide the read's audience explicitly; it is never "whoever can see the write, minus the risk".
- **Severity belongs to the hole, not to the endpoint someone happened to notice.** F8 was filed Low-Med as "fee prices are readable" and closed as High: the same unguarded batch included `GET /discounts?studentId=`, which returns a named child's hardship/staff/sibling concessions to any authenticated session, classmates included. **Re-rate a gap when you open it, rather than inheriting the reporter's guess.**
- **The permission matrix only covers what has a row.** It is the merge-blocking proof and it proved nothing here, because the rows tracked the writes. A route with no row is not "assumed safe", it is unmeasured — the same lesson as *an endpoint nobody calls is not a shipped feature*, one layer down.
- **A stale test is a broken gate.** `classes-ux` had been red because the demo tenant grew a second campus, making "Choose a campus first." the *correct* answer to a spec that never picked one. A suite carrying a known red cannot be used to judge the next change — which is exactly when a real regression walks in unnoticed.

## Test infrastructure: the shared queue (added 2026-08-04)
- **Three copies of a helper is three copies of every bug in it.** `drainSms` was hand-copied into the attendance, exams and fees specs. The same two defects were then fixed *one copy at a time*, over separate sessions, each fix looking like it had solved the problem until the next spec's turn came round. Now one function: `test/integration/support/sms.ts`.
- **The `sms` queue is shared across the whole Redis instance, so a test helper does not own what it reads.** Draining "all jobs" and forcing the calling spec's `schoolId` onto each re-attributes another tenant's message to this school, corrupts both specs' log assertions, and deletes the job out from under whoever queued it. Filter to your own jobs; dispatch each under **its own** `schoolId`, the way `sms.processor.ts` does.
- **Distinguish a fact about the product from a fact about the machine.** A job locked by another worker made three suites red while nothing was wrong with attendance, exams or fees. Cleanup of state you don't own is best-effort — assert on the product, tolerate the environment. (The real guard against a live worker double-dispatching is `support/no-worker.js`.)

**Source:** [[consistency-register]] · [[school-management-master-blueprint]] §2–§34
