# Security Audit — School Management SaaS

**Date:** 2026-07-21
**Scope:** `apps/api`, `apps/worker`, `apps/web`, `libs/common`, `libs/database`, `prisma/`, `docker-compose*.yml`, CI config.
**Method:** static review of the actual implementation (auth, crypto, tenancy, rate limiting, logging, dependencies) — not a black-box pentest. Every finding below is anchored to a real file/line, not a generic checklist item. `pnpm audit` was run against production dependencies.

**Severity scale:** 🔴 High · 🟠 Medium · 🟡 Low · ⚪ Informational (already resolved / already correct).

---

## 1. Executive summary

| Severity | Count |
|---|---:|
| 🔴 High | 3 |
| 🟠 Medium | 3 |
| 🟡 Low | 1 |
| ⚪ Resolved / already correct | 8 |

The system's **core tenancy and request-layer security is genuinely strong** — three-layer tenant isolation, hardened cookies, double-submit CSRF, argon2id + breach-check passwords, encrypted PII columns, a properly reserve-then-run idempotency mechanism, and a timing-safe HMAC webhook. These are not superficial; they're implemented correctly and consistently.

The findings below are concentrated in **deployment/operational configuration and policy enforcement gaps** — places where a documented intent (MFA, TLS, per-tenant encryption) exists in the code or comments but isn't yet wired to actually block anything. That pattern — *declared but not enforced* — is the throughline of this report.

---

## 2. High-severity findings

### 🔴 2.1 — MFA is computed but never enforced
**Evidence:** [`auth.service.ts:162-167`](../apps/api/src/modules/auth/auth.service.ts#L162-L167)
```ts
const mfaEnrollmentRequired =
  !user.mfaEnabled && user.roles.some((r) => MANDATORY_MFA_ROLES.includes(r));
```
`MANDATORY_MFA_ROLES = ['OWNER_ADMIN', 'ACCOUNTANT']` ([`auth.service.ts:36`](../apps/api/src/modules/auth/auth.service.ts#L36)) — the two roles with full tenant access and the money. The flag is returned in the login response, but:
- **No guard, interceptor, or middleware anywhere in the codebase reads `mfaEnrollmentRequired`** to block a request (confirmed by grep across `apps/api/src`).
- **The frontend login page never reads it either** — it's silently dropped.

**Impact:** an owner or accountant account can be created, logged into, and used indefinitely with password-only auth. The "mandatory MFA" policy is decorative. If that account's password is phished or reused, there is no second factor standing in the way — for the single highest-value role in the tenant.

**Recommendation:** add a guard (or extend `JwtAuthGuard`) that 403s with a distinct `MFA_ENROLLMENT_REQUIRED` code on any non-MFA-setup route when the flag is true, and have the frontend redirect to MFA setup on login before rendering the app shell. This is a small, contained fix — the TOTP enroll/verify endpoints already exist ([`auth.service.ts:300-334`](../apps/api/src/modules/auth/auth.service.ts#L300-L334)); only the *enforcement* is missing.

### 🔴 2.2 — Production compose ships HTTP only; no TLS termination configured
**Evidence:** [`docker-compose.prod.yml:100-111`](../docker-compose.prod.yml#L100-L111)
```yaml
traefik:
  command:
    - --entrypoints.web.address=:80
  # For TLS in prod, add a websecure :443 entrypoint + a certresolver (Let's Encrypt).
  ports:
    - '80:80'
```
This is honestly flagged in a comment as a TODO — not a silent oversight — but as shipped, **there is no `:443` entrypoint and no certresolver**. If this compose file is deployed as-is:
- All traffic — login credentials, session cookies, CNIC/phone in request bodies — travels in **cleartext** over the public internet.
- `COOKIE_SECURE` must be `true` in production ([`.env.example`](../.env.example)) for the `Secure` cookie attribute — but a `Secure` cookie **cannot be sent by the browser over plain HTTP at all**. Deployed literally as shipped, either login cookies silently fail to set (broken login) or an operator "fixes" it by setting `COOKIE_SECURE=false`, which then ships session cookies in cleartext.

**Impact:** this is a pre-launch blocker, not a subtle bug — but it's real and someone could deploy this compose file directly and go live without noticing until cookies stop working (best case) or ship without TLS (worst case).

**Recommendation:** add the `websecure` entrypoint + Let's Encrypt (or Cloudflare-proxied) certresolver to `docker-compose.prod.yml` before any real deployment, redirect `:80 → :443`, and add a CI/deploy-checklist assertion that refuses to start with `NODE_ENV=production` and `COOKIE_SECURE=false`.

### 🔴 2.3 — `trust proxy` is not configured; IP-based controls are unreliable behind Traefik
**Evidence:** no `app.set('trust proxy', …)` anywhere in `apps/api/src` (confirmed by grep); production topology is client → Traefik → Nest ([`docker-compose.prod.yml`](../docker-compose.prod.yml)).

Express's `req.ip` — used directly for:
- Login rate limiting: `{ scope: 'ip', limit: 5, windowSec: 15*60 }` ([`rate-limit.policies.ts:34`](../libs/common/src/rate-limit/rate-limit.policies.ts#L34))
- Public-route rate limiting (`60/IP/min`)
- Rate-limit breach logging, which the code itself calls "a compromise indicator" ([`rate-limit.guard.ts:76`](../libs/common/src/rate-limit/rate-limit.guard.ts#L76))

— resolves to the **immediate TCP peer**, which behind a reverse proxy is Traefik's container address, **the same for every request regardless of client**, unless Express is told to trust the proxy and read `X-Forwarded-For`.

**Impact:** in production as configured, every visitor shares one IP-keyed rate-limit bucket. Concretely: the 5-attempts/15-min login limiter would either (a) lock out the *entire school* after 5 login attempts from anyone, or (b) if Traefik doesn't forward a consistent value, behave unpredictably. Either way the IP-scoped defenses (login brute-force limiter, public-route abuse limiter, the "repeated hits = compromise signal" log line) are not measuring what they're designed to measure.

**Recommendation:** `app.set('trust proxy', 1)` (trust exactly one hop — Traefik) in `main.ts`, and confirm Traefik forwards `X-Forwarded-For`/`X-Forwarded-Proto` (default Traefik behavior — verify, don't assume). Add an integration test asserting `req.ip` reflects a synthetic `X-Forwarded-For` header when running behind the configured proxy count.

---

## 3. Medium-severity findings

### 🟠 3.1 — Single tenant-wide encryption master key
**Evidence:** [`field-encryption.ts:9-14`](../libs/common/src/crypto/field-encryption.ts#L9-L14) — the file's own comment is exemplary honesty:
> "the blueprint scopes data keys per tenant via KMS. On R2/Coolify we start with one master key; per-tenant subkeys (HKDF over schoolId) are a follow-up before storing production PII — tracked, not silently skipped."

All tenants' CNIC, bank account, and MFA-secret ciphertext (`cnicEnc`, `bankAccountEnc`, `mfaSecretEnc`) are encrypted under **one shared `ENCRYPTION_MASTER_KEY`**. AES-256-GCM itself is correctly implemented (random 12-byte IV per call, auth tag verified, versioned wire format) — the algorithm isn't the issue.

**Impact:** a single key compromise (leaked env var, compromised Coolify secret store, insider with prod access) decrypts **every tenant's PII simultaneously**, not just one school's. In a multi-tenant SaaS this is the difference between a contained incident and a mass-breach disclosure event.

**Recommendation:** implement the already-planned HKDF-per-`schoolId` subkey derivation before onboarding any school with real (non-demo) PII. This is explicitly tracked as a pre-production gate in the code's own comment — treat it as one.

### 🟠 3.2 — Six high-severity transitive dependency CVEs (verified low exploitability, still worth patching)
**Evidence:** `pnpm audit --prod` → **18 vulnerabilities: 1 low, 11 moderate, 6 high**. The 6 high:
- 4× **multer** DoS (`GHSA-3p4h-7m6x-2hcm` and related) — pulled in transitively via `@nestjs/platform-express`. **Verified not directly reachable**: the application's own upload path never touches multer — [`uploads.service.ts`](../apps/api/src/modules/uploads/uploads.service.ts) uses **presigned S3 PUT** (client uploads directly to object storage; the API only issues/confirms the URL). No `FileInterceptor`/`MulterModule` usage exists anywhere in `apps/api/src`.
- 1× **lodash** `_.template` code injection (`GHSA-5528-5vmv-3xc2`, versions ≤4.17.23) — pulled in by `@nestjs/config` and `@nestjs/swagger`, not called with attacker-controlled input anywhere in app code.
- 1× **js-yaml** quadratic-CPU DoS via `@nestjs/swagger` — Swagger/`/api/docs` is explicitly **disabled in production** ([`main.ts:37`](../apps/api/src/main.ts#L37): `if (!isProd) { ... SwaggerModule.setup ... }`), so this path doesn't exist in a production deployment.

**Impact:** low *today* because the vulnerable code paths aren't reachable through the application's own routes — but this is fragile reasoning that erodes the moment someone adds a multipart upload route, enables Swagger in prod for support purposes, or a new transitive path opens. These are also free to fix.

**Recommendation:** run `pnpm audit fix` / add `pnpm.overrides` and re-lock; add `pnpm audit --prod --audit-level=high` as a CI gate so new highs can't merge silently (see §5).

### 🟠 3.3 — PII log-redaction allowlist hasn't kept pace with the schema
**Evidence:** [`logger.config.ts:28-40`](../libs/common/src/observability/logger.config.ts#L28-L40) redacts flat paths: `req.body.password`, `req.body.cnic`, `req.body.phone`, `req.body.guardianPhone`, `req.body.bankAccount`. But current DTOs nest PII under different shapes added since:
- Student creation: `guardian: { phone, relation, ... }` — **not** `req.body.phone`.
- Teacher application (this session's HR module): `details: { cnic, whatsapp, currentAddress, ... }` — none of these nested paths are covered.

**Verified current exposure:** pino-http's default `req` serializer does **not** include the request body at all (confirmed — no custom body serializer exists in `logger.config.ts`), so this is **latent, not active**: today, nothing actually logs `req.body`. But the module's own doc comment ("Sensitive fields ... in bodies are redacted") asserts a guarantee that is no longer true for the current schema shape — the day anyone adds a debug body-serializer, or another logger call touches these DTOs directly, plaintext CNIC/phone/address will land in logs uncensored, and the team will believe it's covered because the redact config exists.

**Recommendation:** either (a) extend the redact paths to the actual nested shapes (`req.body.guardian.phone`, `req.body.details.cnic`, `req.body.details.whatsapp`, etc., or pino's wildcard `req.body.*.cnic` where the library version supports it), or (b) — more robust against schema drift — redact by **key name** app-wide (walk the body object at log time and censor any key matching `/cnic|phone|password|bankAccount|whatsapp/i`) rather than by exact path. Add a unit test that fails when a new DTO field named `*cnic*`/`*phone*` isn't covered.

---

## 4. Low-severity findings

### 🟡 4.1 — CSRF token comparison is not constant-time
**Evidence:** [`csrf.guard.ts:33`](../apps/api/src/modules/auth/guards/csrf.guard.ts#L33) — `if (!header || !cookie || header !== cookie)`.

**Impact:** low in practice. Same-origin policy already prevents a cross-origin attacker from *reading* the `csrf` cookie value to forge the header in the first place (that's the entire point of double-submit CSRF); a timing side-channel would only matter if an attacker could already observe response timing with sub-millisecond precision over the network *and* somehow already had partial knowledge of the token, which largely defeats the purpose of attacking it this way. Worth fixing on principle (it's a one-line change), not worth losing sleep over.

**Recommendation:** swap to `crypto.timingSafeEqual` (already imported and used correctly for the SMS webhook — [`comms.service.ts:132`](../apps/api/src/modules/comms/comms.service.ts#L132) — just needs equal-length padding since the two strings may differ in length before comparison).

---

## 5. What's already correct (verified, not assumed)

These are not filler — they were specifically checked and are worth stating plainly so the real gaps above don't get lost in a wall of praise:

- **Tenant isolation is three-layer and fail-closed**: a Prisma extension that throws on missing tenant context ([`tenant.extension.ts`](../libs/database/src/tenant.extension.ts)), Postgres RLS with `FORCE` (so even the table owner path is policy-bound), and a merge-blocking isolation test suite. `app_user` has no `BYPASSRLS`.
- **IDOR / campus-scoping is a deliberate, fail-closed pattern**: `restrictedCampusId()` treats "no principal" and "misconfigured null campusId" identically — both map to a sentinel nil-UUID that matches nothing, rather than silently falling through to unrestricted access ([`campus-scope.ts:19-30`](../libs/common/src/authz/campus-scope.ts#L19-L30)).
- **Passwords**: argon2id at 64 MB / 3 iterations, plus a HaveIBeenPwned k-anonymity range check that soft-fails open (documented, deliberate trade-off) rather than hard-blocking sign-up if HIBP is unreachable.
- **Cookies**: httpOnly + `Secure` + `SameSite=Strict`, refresh token path-scoped to the refresh endpoint only, and the only non-httpOnly cookie is the CSRF token by design (double-submit pattern requires JS to read it).
- **CORS**: `origin: false` — same-origin only, credentials allowed only within that. No wildcard, no reflected origin.
- **Refresh tokens**: opaque random 48-byte tokens, stored **only as a SHA-256 hash** — the raw token never touches the database.
- **Raw SQL is fully parameterized**: every `$executeRaw`/`$queryRaw` in the codebase uses Prisma's tagged-template form (compiler-enforced parameterization), confirmed by grep across the entire repo — zero string-interpolated SQL.
- **File uploads**: presigned-PUT pattern (server never buffers user file bytes), magic-byte validation against an allowlist independent of the client-declared MIME type, then a real ClamAV `INSTREAM` scan before promotion out of quarantine — fails closed (`503 VIRUS_SCAN_UNAVAILABLE`) if the scanner is down.
- **Webhooks**: the SMS delivery-receipt webhook is HMAC-SHA256 verified using `crypto.timingSafeEqual` correctly ([`comms.service.ts:109-132`](../apps/api/src/modules/comms/comms.service.ts#L109-L132)) — the one place a cross-tenant (`BYPASSRLS`-equivalent) Prisma client is used outside the platform module, and it's narrowly scoped (lookup by a specific external message id, not an open cross-tenant query) with a legitimate reason (no tenant host header exists on an inbound gateway callback).
- **Idempotency**: a correct reserve-then-run design using `INSERT ... ON CONFLICT DO NOTHING` specifically to avoid a unique-violation poisoning the surrounding transaction under concurrency — a subtle correctness bug that's been proactively engineered around, not accidentally avoided.
- **Secrets hygiene**: `.env` has never been committed (verified via `git log --all --full-history -- .env` — no output), `.env.example` contains only placeholder/dev values, and no hardcoded API keys or private-key material were found anywhere in source (targeted regex scan across `apps`/`libs`).

---

## 6. Best & ideal security approaches for this system

Concrete, prioritized, specific to this codebase — not generic advice:

1. **Turn "declared" into "enforced" for every policy that currently isn't.** MFA (§2.1) is the clearest instance, but audit the codebase for the pattern generally: search for booleans computed-but-unused (`grep` for a field set in a service that's never read by a guard) — that's the exact shape of bug this report found twice (MFA flag, and effectively the redact-completeness gap).
2. **Ship a "go-live" checklist as an executable check, not a doc.** Several findings here (`COOKIE_SECURE`, TLS entrypoint, `trust proxy`) are the kind of thing a human forgets under deploy pressure. A small startup assertion — `if (isProd && !env.COOKIE_SECURE) throw` — turns a silent security regression into a boot-time crash, which is exactly the failure mode you want for this class of mistake.
3. **Adopt per-tenant key derivation (HKDF over `schoolId`) before any school's real PII is stored** — the code already names this as the plan; execute it as a gate, not a backlog item.
4. **Add `pnpm audit --audit-level=high` to CI** (root `.github/workflows/ci.yml` already runs lint/typecheck/tests — this is one more step) so dependency drift is caught automatically instead of by manual audit sessions like this one.
5. **Redact by pattern, not by exact path**, for anything that could plausibly carry PII in a nested shape — DTOs will keep growing nested objects (this very session added two: `guardian`, `details`), and an allowlist of exact paths is a maintenance trap that silently rots.
6. **Prefer `timingSafeEqual` as the default comparison idiom for any secret-adjacent equality check**, even where the risk is low (§4.1) — it costs nothing and removes the question from every future review.
7. **Rotate `ENCRYPTION_MASTER_KEY` and `JWT_KEYS` on a real schedule, not just "when we remember."** The two-key `kid`-based JWT rotation mechanism already exists ([`token.service.ts`](../apps/api/src/modules/auth/token.service.ts)) — the missing piece is an operational runbook + calendar reminder, not more code.
8. **Treat the vendor/platform console (`BYPASSRLS`) surface as the highest-value target it is.** It's already well-separated (distinct cookies, distinct JWT `typ`, distinct CSRF token) — keep that separation, and consider making `PlatformPrismaService` injection itself lint-restricted to the `platform/` module plus the one verified exception (`comms.service.ts`'s webhook lookup), so a future accidental injection elsewhere fails at lint time, not at code review time.
