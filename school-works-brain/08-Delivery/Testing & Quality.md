---
title: Testing & Quality
type: delivery
updated: 2026-07-06
---

# Testing & Quality

**The state machines and business rules ARE the acceptance criteria** (blueprint §34). A story doesn't enter a sprint without criteria derived from Parts II–V.

## The pyramid & CI order (§34, [[09-testing-quality-strategy]])
```
lint → unit → integration → tenant-isolation (MERGE-BLOCKING) → matrix-conformance → build → staging → E2E → load
```
- **Unit** (Jest): every state machine + the fee/payroll/grading formulas with worked-example fixtures (blueprint Appendix C).
- **Integration** (Supertest + ephemeral pg/redis): per-PR.
- **Tenant-isolation suite** — seeds two schools, asserts every cross-tenant access fails. **Blocks merge.** → [[Multi-Tenancy & Isolation]].
- **Matrix-conformance** — every permission-matrix cell maps to a real route.
- **E2E** (Playwright): admit, collect fee, mark attendance, publish marks, report card issued, promotion. *(The "parent views report card" journey was retired with the parent portal, 2026-07-28.)*
- **Load** (k6): fee-season peak (500 payment VUs + 10k SMS) before major releases.

## Definition of Done (per story)
code + tests + OpenAPI updated + docs touched. PR checklist: new model in the RLS migration + isolation test? authz guard on every new route? AuditLog on sensitive mutations? `$queryRaw` justified? error codes registered?

## SEV policy
Anything touching **tenant isolation, immutable payments/reversals, or PII delivery is SEV-1 by default**.

## Current state (as built)
- **39 tests green** across 7 suites (unit + integration/e2e + isolation).
- Gates enforced locally + in CI: isolation suite, RLS-coverage grep, lint, strict typecheck, api+worker build.
- **Not yet:** matrix-conformance test, Playwright E2E, k6 load. → [[Progress Tracker]].

**Source:** [[09-testing-quality-strategy]], blueprint §34.
