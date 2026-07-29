---
title: Product Overview
type: domain
updated: 2026-07-06
---

# Product Overview

A multi-tenant SaaS for **private schools in Pakistan** (200–3,000 students, often multi-campus), covering full daily operations: admissions, enrollment, attendance, exams & report cards, fees, staff HR & payroll, parent communication (SMS-first), and document issuance. Sold per-school on subscription tiers. English UI in v1; Urdu SMS content supported.

## Buyers & users
- **Buyers:** owners/principals of private schools.
- **Daily users:** front-desk/admissions, accountants (fee counter), teachers (attendance + marks), campus admins, students (read-mostly portal).
- **Parents are not users.** They are *recipients* — SMS reaches them, they pay at the counter, the office answers their questions. There is no parent login and none is planned (locked decision, 2026-07-28 → [[Key Decisions]]). Guardian **data** is nonetheless load-bearing: no student can be admitted without one.

## Roles (8)
`PLATFORM_ADMIN` (vendor, cross-tenant) · `OWNER_ADMIN` · `CAMPUS_ADMIN` · `ACCOUNTANT` · `TEACHER` · `STAFF` · `PARENT` · `STUDENT`.
One person = one User row per school; `roles` is an array; effective permission = union, but scope checks apply per role. → [[API Contract]], [[Key Decisions]].

## Scope by release (what ships when)
| Area | v1.0 GA | v1.5 | v2.0 |
|---|---|---|---|
| Multi-campus, years, enrollment, promotion | ✅ | | |
| Admissions, students, guardians, portals | ✅ | | |
| Attendance + leaves (lock windows) | ✅ | | |
| Exams, grading, report cards (PDF) | ✅ | | |
| Fees (invoices, payments, fines, discounts, advances, reversals) | ✅ | | |
| SMS (transactional + manual, credits, webhooks) | ✅ | | |
| Staff HR + payroll | ✅ | | |
| Certificates, audit, dashboards, reports | ✅ | | |
| Teacher–subject assignment | ✅ | visual timetable | |
| Homework/diary, in-app+email notifications | | ✅ | |
| Library, transport, online payment gateway, i18n UI | | | ✅ |
| Hostel (flag removed), inventory | out of scope | | |

**No half-features ship.** Descoped modules carry no flags.

## UI/UX (frontend scaffold started)
Screens per role, global rules (loading/empty/error states, confirm dialogs for irreversible actions, field-level 422 inline, mobile-first, WCAG 2.1 AA), all times Asia/Karachi. → [[05-ui-ux-specification]]. Frontend lives in `apps/web` (Next.js 14) — login + dashboard wired; role-based screens next.

**Source:** [[01-product-requirements-document]], [[05-ui-ux-specification]], blueprint §1–§5.
**Implementation status:** backend for all v1 GA domains is **built (M1–M6 + hardening)**; frontend **scaffold started** (`apps/web` — login + dashboard) → [[Progress Tracker]].
