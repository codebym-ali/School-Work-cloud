---
title: Roadmap & Milestones
type: delivery
updated: 2026-07-14
---

# Roadmap & Milestones

Sequencing and gates are **authoritative** (blueprint §34); durations are planning estimates. Live status: [[Progress Tracker]].

## Milestones (M1→M7 → GA)
| M | Scope | Gate (exit criteria) | Status |
|---|---|---|---|
| **M1** | Foundations: tenancy, auth, CI, setup, provisioning | **Isolation suite green before any feature** | ✅ |
| **M2** | Students, admissions, enrollment | Admit journey E2E green | ✅ |
| **M3** | Attendance, leaves, SMS core | Mark attendance E2E + absence SMS verified | ✅ |
| **M4** | Fees end-to-end | Collect-fee E2E + `fee-integrity-check` clean | ✅ |
| **M5** | Exams & report cards | Enter/publish marks + parent views report card | ✅ |
| **M6** | HR, payroll, documents, reports, **promotion** | Promotion E2E + all 7 reports export | ✅ |
| **M7** | Hardening & pilot → **GA** | Load + pen test + DR drill + pilot live | ⏳ hardening done; VPS deploy/DR-drill/pen-test/pilot remain |

## Dependency rules (why the order is fixed)
- **M1 gates everything** — isolation + matrix-conformance are merge-blocking for the whole project.
- M2 & M3 can run in parallel after M1; **M4 waits for both** (SMS core → fee receipts).
- M4 precedes promotion-relevant flows: promotion preconditions need the **fee ledger (M4)** + **published report card (M5)**; promotion itself lands in M6.

## Top risks (from [[10-project-milestones-roadmap]])
1. Tenant-isolation bug in prod → 3-layer defense + paging on any `TENANT_VIOLATION`. **SEV-1 by definition.**
2. SMS aggregator downtime → pluggable adapter + retry + failed-messages screen + overdraft buffer.
3. Fee-season load → per-invoice row locks, stored `paidAmount`, dashboard cache, k6 before releases.
4. Legacy data import → CSV import with row-level errors; N-1 migrations.
5. Multi-campus authz gaps → CampusScope guard + matrix-conformance test + composite tenant-chain FKs.

## Post-GA
- **v1.5:** visual timetable, homework/diary, in-app+email notifications, marks CSV import.
- **v2.0:** library, transport, online payment gateway, full i18n UI, per-school timezone.

**Source:** [[10-project-milestones-roadmap]], blueprint §34, §4.
