---
title: System Architecture
type: architecture
updated: 2026-07-06
---

# System Architecture

A **modular monolith**: one NestJS codebase, strict module boundaries, deployed as **two processes** that share the code — `api` (HTTP) and `worker` (BullMQ consumers). Preserves microservice-extraction optionality without distributed-systems cost.

## Stack
| Layer | Choice |
|---|---|
| Backend | Node 22, NestJS 10, TypeScript strict |
| ORM | Prisma, **snake_case** DB mapping (mandatory for RLS/raw SQL) |
| DB | PostgreSQL 16, RLS enabled, UUID PKs |
| Cache/queues | Redis 7 + BullMQ |
| Frontend | Next.js 14 (not built yet) |
| Files | Cloudflare R2 (S3-compatible) — [[Deployment & Operations]] |
| Auth | JWT access (15m) + rotating refresh (httpOnly cookies) — [[Security & Compliance]] |
| SMS | Pluggable gateway adapter — [[HR, Payroll, Comms & Documents]] |

## Modules
`admissions · students · attendance · leaves · exams · fees · hr · comms · documents · platform · setup · enrollment · common`. Modules communicate through exported services only (ESLint boundary rules). Background work runs in `worker`.

## Request lifecycle (order matters — §19)
1. **ClsMiddleware** → establishes per-request context
2. **TenantResolutionMiddleware** → resolve tenant from Host, set `schoolId` (pre-auth, so `/auth/login` works)
3. **JwtAuthGuard** → validate cookie, attach user
4. **TenantScopeGuard** → assert `user.schoolId == resolved schoolId` (else 403)
5. **RolesGuard** + ownership checks
6. **TenantTransactionInterceptor** → wraps handler in `withTenant` (one RLS-bound tx per request)

→ full detail in [[Multi-Tenancy & Isolation]].

## Repo shape (as built)
```
apps/api      apps/worker
libs/common   libs/database
prisma/       test/   .github/workflows/ci.yml
```
Webpack bundling → single `dist/apps/*/main.js` per deployable. Path aliases `@common`, `@database`.

**Source:** [[02-technical-architecture-document]], blueprint §3, §16, §19.
**Implementation status:** ✅ built and green (M1). Modules added through M3; see [[Progress Tracker]].
