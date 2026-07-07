---
title: Documentation Map
type: meta
updated: 2026-07-06
---

# Documentation Map

Analysis of every file under `docs/` (plus the master blueprint at the repo root),
what each one is for, and how they relate. The blueprint is the superset; the numbered
`docs/` files are focused briefs derived from it; the register locks the shared facts.

## The hierarchy
```
consistency-register.md   ← LOCKED. Names/numbers/rules. Wins over the numbered docs.
        ▲ derived verbatim from
school-management-master-blueprint.md (v2.0)   ← AUTHORITATIVE. Wins over everything.
        ▲ briefs derived from
docs/01 … docs/10          ← audience-specific summaries; must trace back to the register
```
Conflict order: **Blueprint > Consistency Register > numbered docs**. In practice the
register and blueprint agree (register is extracted verbatim); the numbered docs must not drift.

## The files

| # | File | What it is | Maps to note |
|---|---|---|---|
| — | [[school-management-master-blueprint]] | **The master blueprint (v2.0).** 1,390 lines. Full product + domain + data + security + API + ops + delivery. Single source a team/agent can build from. | everything |
| — | [[consistency-register]] | **LOCKED ledger.** Enums, magic numbers, all 48 model→table mappings, error/audit codes, the 20 immutable business rules, roles, API conventions. | [[Key Decisions]] |
| 01 | [[01-product-requirements-document]] | **PRD.** Vision, personas, scope-by-release, functional requirements, success metrics. Audience: product/exec. | [[Product Overview]] |
| 02 | [[02-technical-architecture-document]] | **Architecture.** Modular monolith, tech stack, module boundaries, request lifecycle, deployables (api + worker). | [[System Architecture]] |
| 03 | [[03-database-schema-erd]] | **Data model.** The 48-model Prisma schema, ERD, keys, indexes, partial-unique constraints, RLS notes. 967 lines — the most detailed brief. | [[Data Model]] |
| 05 | [[05-ui-ux-specification]] | **UI/UX.** Screens per role, global UX rules (loading/empty/error states, confirmations, WCAG AA), mobile-first. *No frontend built yet.* | [[Product Overview]] |
| 06 | [[06-security-compliance-specification]] | **Security & compliance.** Threat model, tenant isolation, auth/authz, encryption, PII, retention, right-to-erasure. | [[Security & Compliance]] |
| 07 | [[07-non-functional-requirements]] | **NFRs.** Latency/uptime/RPO/RTO targets, rate limits, capacity basis, observability requirements. | [[Deployment & Operations]] |
| 08 | [[08-deployment-infrastructure-plan]] | **Deployment.** Environments, IaC, backups, blue/green, DR. *Written for AWS; we run Contabo + Coolify + R2 — see the note.* | [[Deployment & Operations]] |
| 09 | [[09-testing-quality-strategy]] | **Testing.** The pyramid: unit → integration → **tenant-isolation (merge-blocking)** → matrix-conformance → E2E → load. SEV policy. | [[Testing & Quality]] |
| 10 | [[10-project-milestones-roadmap]] | **Roadmap.** M1→M7, dependency graph, gates, top-5 risks, post-GA (v1.5/v2.0). | [[Roadmap & Milestones]] |

> [!note] Doc 04
> There is no `04-*` file in this set (the numbering skips it). The API contract lives
> in blueprint §23–§25; see [[API Contract]].

## How to keep this trustworthy
- Any spec change starts as a **blueprint PR**, then updates the [[Key Decisions|register]], then the affected numbered doc — never the other way round.
- These brain notes are **derived views**; when a source changes, update the note's summary and its **Source** line.

**Source:** `docs/` folder (11 files) · [[school-management-master-blueprint]]
