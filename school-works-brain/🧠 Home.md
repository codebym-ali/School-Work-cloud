---
title: School Management System — Brain
type: MOC
updated: 2026-07-06
---

# 🧠 School Management System — Brain

The knowledge base ("second brain") for the multi-tenant school-management SaaS.
This vault **summarises and links**; it never duplicates the authoritative sources.

> [!important] Source of truth
> The authoritative specs live in the repo, not here:
> - [[school-management-master-blueprint]] — the master blueprint (v2.0, wins all conflicts)
> - [[consistency-register]] — LOCKED ledger of every name, number and rule
> These notes point back to blueprint sections (`§n`) and the `docs/` briefs.
> **Open the repository root as your Obsidian vault** so links to `docs/` resolve.

> [!warning] Contributors & AI agents — read [[Maintenance]] first
> `school-works-brain/` is the **single living memory** of this project. Whenever you
> implement/change/decide anything, record it here **in the same task**. Do **not** use
> `docs/` (frozen reference). The repo-root `CLAUDE.md` enforces this for Claude Code.

## 🗺️ Start here
- [[Maintenance]] — **how to keep this brain (the project's memory) alive** ← read first
- [[Documentation Map]] — what every document is, and how they relate
- [[Progress Tracker]] — **live build status**, updated at the end of every phase
- [[Roadmap & Milestones]] — M1→M7 plan and gates
- [[Key Decisions]] — the locked decisions digest

## 📚 The vault
| Area | Notes |
|---|---|
| **Product** | [[Product Overview]] |
| **Architecture** | [[System Architecture]] · [[Multi-Tenancy & Isolation]] |
| **Domain** | [[Enrollment & Admissions]] · [[Attendance & Leaves]] · [[Exams & Report Cards]] · [[Fees & Payments]] · [[HR, Payroll, Comms & Documents]] |
| **Data** | [[Data Model]] |
| **Security** | [[Security & Compliance]] |
| **API** | [[API Contract]] |
| **Operations** | [[Deployment & Operations]] |
| **Delivery** | [[Roadmap & Milestones]] · [[Testing & Quality]] |
| **Meta** | [[Maintenance]] · [[Documentation Map]] · [[Key Decisions]] · [[Glossary]] |

## 🧭 How to use this vault
- Each note is a **concise map** with: a summary, the key rules (linking to [[Key Decisions]]), related notes, and a **Source** line + **Implementation status**.
- Use the graph view to see how domain areas connect (enrollment is the spine — most notes link back to [[Enrollment & Admissions]]).
- When a phase ships, update [[Progress Tracker]] first, then any note whose "Implementation status" changed. Full procedure: [[Maintenance]].
