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

## Sellable roadmap — "body over engine" (2026-07-19)
Backend is enterprise-grade but the **buyer-facing surface** lags. Decided sequencing (dependency +
sales impact), split into two releases:
- **R1 (sales demo):** #1 Parent portal → #2 WhatsApp integration → #3 Fee challan printing.
- **R2:** #4 Admin screens + SMS/comms center → #5 Homework/Diary + Timetable. Transport = v2 (roadmap slide only).

Design specs (frozen) live in `docs/superpowers/specs/2026-07-19-*.md` (one per feature + a
`sellable-roadmap-overview`). Each spec has an **Open Decisions** block at the top for choices the
product owner hasn't confirmed — read those before building; nothing there is assumed as final.

**Parent portal (#1) confirmed decisions:** phone+OTP self-service login (schema `ParentProfile`
already carries OTP columns); read-only mirror + downloads (no write-actions in v1); fee = printable
challan only, **no payment gateway** in v1; child-scoping via `StudentGuardian` links validated in the
**service** (§22.8), `:studentId` mismatch → 404. The portal's diary tab ships **dormant** until #5.

**Fold-in security fixes (from the 2026-07-19 audit) — bugs, not features:** SMS GET endpoints
(`/sms/templates|credits|logs`) are unguarded → fix + matrix rows in #4; `POST /student-leaves`
over-permissioned + teacher can file for any student (no section check, no `source`) → tighten in #4.

**Source:** [[consistency-register]] · [[school-management-master-blueprint]] §2–§34
