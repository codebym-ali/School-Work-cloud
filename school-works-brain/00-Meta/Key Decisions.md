---
title: Key Decisions
type: meta
updated: 2026-07-08
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

## Frontend + Playwright E2E gotchas (added while building admissions/exams screens)
- **Most app forms have no label↔input association** (`<label>Text</label>` immediately followed by a sibling `<input>`/`<select>`, no `htmlFor`/`id`) — only the login page does. So Playwright's `getByLabel` only works on `/login`; everywhere else use a CSS adjacent-sibling locator (`label:text-is("X") + input`). See `test/e2e/helpers.ts` (`fieldInput`/`fieldSelect`).
- **`.locator('.card', { hasText })` is substring matching, not exact** — e.g. `hasText: 'Terms'` also matched the Exams card because its "Term" filter/select labels concatenate with other text into a false substring hit. Prefer `cardByHeading(page, 'Exact H2 Text')` (filters `.card` by an exact-text, `level: 2` heading), also in `helpers.ts`.
- **Nested cards inside a table row** (e.g. `ExamRow`'s expanded marks-entry/results panel renders as a `<tr><td colSpan>` *inside* the same outer "Exams" `.card`'s `<table>`) mean `cardByHeading` can match both the outer card and the nested one (the outer one "has" the heading as a descendant). `.last()` reliably picks the more-specific (deeper, later-in-DOM) match.
- **Guardian phone is unique per school** (link-by-phone resolution) — E2E specs that create guardians must derive the phone from a per-run value (e.g. `` `03${String(Date.now()).slice(-9)}` ``), not a hardcoded literal, or a second run of the same spec 409s against the guardian created by the first run.
- **`PaginationQuery.pageSize` caps at 100** (`@Max(100)`) — a page that requests more (we had `/students?pageSize=200` in the Exams screen's bulk loader) gets a 400, which — because the fetch was inside one `Promise.all` alongside academic-years/terms/classes/sections/subjects — failed the *entire* batch and silently left every dropdown on the page empty. Any new "load everything for dropdowns" `Promise.all` must respect this cap.
- **`CreateExamDto.weightagePercent` has no `@Type(() => Number)`** — posting the raw string from an `<input>`'s value (as opposed to `Number(value)`) passes class-validator's implicit-conversion-off `@IsNumber` check as a string and 422s with a generic "Validation failed" that's easy to misattribute to something else. Convert numeric form fields at the API-call site (matches the existing convention in `setup/page.tsx`'s `ClassCard` → `order: Number(b.order)`).
- **Rate limiting is live even in local dev** (`RATE_LIMIT_ENABLED` defaults on outside the Jest test env — see the rate-limiting entry above) — login is 5/IP/15min **and** 10/email/1h. Repeated manual `curl` logins + Playwright runs during a debugging session can trip it; for local iteration only, clear the Redis keys `rl:login:ip:*` / `rl:login:email:*` (dev Redis, port 6381) rather than waiting out the window. Never do this against a real/shared environment.
- **Marks-entry state-clobber race (fixed) — set backing state before the state that gates the editable UI.** The Exams screen's `MarksEntryPanel.loadRoster()` originally did `setEnrollments(...)` *before* a second `await` (the `/exams/:id/results` fetch), then `setRows(...)` after it. The table renders on `enrollments.length > 0`, so there was a window where the inputs were typeable but `rows` was still empty; a mark typed in that window was overwritten when the pending `setRows` ran, and `save()` posted `Number('') === 0`. Flaky by nature (depended on whether `/results` resolved before the user typed). Fix: do all fetches first, then `setRows` + `setEnrollments` together after the final `await` (React 18 batches them into one atomic render). General rule for this codebase's client screens: **never render an editable control off one piece of state while its backing edit-state is still loading behind another `await`.** `updateRow` also switched to the functional `setRows(prev => …)` form so multi-cell edits compose off latest state. The exams E2E now asserts the `/results/bulk` payload's `marksObtained` at the network layer (not just the rendered `88 / 100`) so this regression can't silently return.

**Source:** [[consistency-register]] · [[school-management-master-blueprint]] §2–§34
