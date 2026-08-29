---
title: Security & Compliance
type: security
updated: 2026-07-06
---

# Security & Compliance

## Threat model (§18)
Cross-tenant leak, JWT theft/replay, credential stuffing, SQLi, key exposure, insider threat, compromised admin, payment double-spend, malicious upload, XSS, CSRF, SMS-PII-to-wrong-number, stale-cache suspension bypass — each with a concrete mitigation in the blueprint.

## Authentication (§22) ✅ built (M1)
- Passwords: **argon2id** (64MB, 3 iters) + HaveIBeenPwned check. Lockout after 10 fails (15 min, self-heals).
- Tokens: JWT access (15m) + **rotating single-use refresh** (30d); **reuse of a revoked refresh → revoke the whole family** (theft signal).
- Transport: **httpOnly, Secure, SameSite=Strict cookies** (nothing token-shaped in localStorage) + **CSRF double-submit** on writes.
- **MFA (TOTP) mandatory** for OWNER_ADMIN, **OPERATIONS_ADMIN** & ACCOUNTANT; recovery codes hashed.

## Authorization (§22.8)
Role check + **row-level ownership**: CampusScope, SectionOwnership, SubjectOwnership, GuardianOfStudent, Self. Enforced as guards where possible, and **as service-level checks when they must read tenant data** (guards run before the withTenant tx). → [[Multi-Tenancy & Isolation]].

**Role hierarchy (the one exception to the flat guard).** `RolesGuard` is a flat "holds one of the required roles" check for every role **except** `OPERATIONS_ADMIN` — the owner's school-wide **deputy** ("Ops Admin", shipped 2026-08-29). Via `libs/common/authz/role-hierarchy.ts`, an Ops admin **satisfies any `@Roles` requirement below it** (Campus Admin, Admission Controller, HR, Accountant, Teacher, Staff) but **never `OWNER_ADMIN`** — so `@Roles('OWNER_ADMIN', <lower>)` routes admit it while **`@Roles('OWNER_ADMIN')`-alone routes stay owner-reserved by construction**. The fine-grained **grant-ceiling** (OP-1: only the owner appoints/revokes a deputy; OP-2: a deputy can't grant its own level-or-above nor touch an owner/another deputy) is **service-level** in `users.service` (reads the target's roles). Module-access toggles + user removal stay owner-only. Full design: [[Operations Admin Role Plan]] · rationale: [[Key Decisions]].

## Tenant isolation
The headline control — see [[Multi-Tenancy & Isolation]] (3 layers + merge-blocking CI).

## Web hardening (§22.7)
CSP (`default-src 'self'`, no inline script), HSTS, `X-Content-Type-Options`, `frame-ancestors 'none'`, same-origin CORS, global whitelist ValidationPipe (`forbidNonWhitelisted`).

## Uploads (§22.6)
Pre-signed PUT to a **quarantine prefix** → magic-byte + MIME allowlist + **ClamAV** → move to permanent prefix. Served only via 10-min pre-signed GETs after an ownership check. *(Pipeline not built yet.)*

## Data protection (§32)
Field-level **AES-256-GCM** for `cnic`, `bank_account`, `mfa_secret` (in a Prisma extension; on our stack the master key lives in Coolify secrets, replacing KMS). **PII never logged** (redaction list). **Right-to-erasure = anonymization** (names→`REDACTED-{id}`, DOB→year, phone/CNIC/photo nulled); financial/attendance skeletons retained for legal obligations, proven by a `PII_ANONYMIZED` audit row.

## Vendor break-glass (§22.9)
PLATFORM_ADMIN tenant access needs an explicit **support session**: reason, 4-hour expiry, visible to the school's OWNER_ADMIN, every action logged.

**Source:** [[06-security-compliance-specification]], blueprint §18–§22, §32.
**Implementation status:** auth + isolation ✅ (M1); **rate limits ✅ (M7 — Redis sliding-window `RateLimitGuard`, §29; 429 + `Retry-After`)**; **upload AV scan ✅ (M7 — clamd INSTREAM, fail-closed, §22.6)**; erasure ⬜ later → [[Progress Tracker]].
