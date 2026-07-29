---
title: Glossary
type: meta
updated: 2026-07-06
---

# Glossary

Domain terms used across the vault. Source: blueprint §6.

- **GR number** — General Register number. A student's permanent registration ID, unique per school (`[schoolId, grNumber]`), assigned at admission, never reused. Auto-sequenced or manual. → [[Enrollment & Admissions]]
- **CNIC** — Pakistani national identity card number. Guardian PII; encrypted at rest (`cnic_enc`). → [[Security & Compliance]]
- **Tenant** — one school (all its campuses). Addressed by subdomain `{slug}.platform.pk`. → [[Multi-Tenancy & Isolation]]
- **Session (attendance)** — a marked slot within a day: `MORNING` / `EVENING`. Schools configure one or two. → [[Attendance & Leaves]]
- **Term** — a grading period within an academic year (e.g. Term 1). Exams roll up into terms. → [[Exams & Report Cards]]
- **Fee head** — a category of charge (Tuition, Annual Fund, Exam Fee…). → [[Fees & Payments]]
- **Fee structure** — amount + frequency per (school, campus, class, fee head, year).
- **Defaulter** — a student with ≥1 invoice past due and unpaid.
- **Enrollment** — the row that places a student in a (year, campus, class, section). The domain spine. → [[Enrollment & Admissions]]
- **Guardian** — the adult responsible for a student (`ParentProfile` + `StudentGuardian` link). A **contact record, not an account**: guardians have no login and are not `User`s. Admission requires one; every SMS resolves the *primary* guardian. → [[Key Decisions]]
- **Parent portal** — *removed 2026-07-28.* The retired self-service dashboard. The word "parent" in older notes and in the blueprint (§5, §23) may still imply a login; it no longer exists. → [[Key Decisions]]
- **Advance / GuardianCredit** — a guardian's prepaid balance, auto-applied to new invoices (oldest first).
- **Reversal** — the only way to correct an (immutable) payment; own receipt prefixed `RV-`.
- **Break-glass** — audited, time-boxed vendor (PLATFORM_ADMIN) access to a tenant. → [[Security & Compliance]]
- **RLS** — Postgres Row-Level Security; the DB-level tenant isolation layer. → [[Multi-Tenancy & Isolation]]
- **Segment (SMS)** — a billable SMS unit; 160 chars GSM-7 / 70 chars UCS-2 (Urdu). → [[HR, Payroll, Comms & Documents]]
