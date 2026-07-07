# 🧠 school-works-brain — School Management System knowledge base

An [Obsidian](https://obsidian.md) vault that is the **single living memory** of the project:
concise, cross-linked notes that **summarise and point to** the authoritative specs
(never duplicate them), plus a **live progress tracker**.

> [!important] This is the project's memory — keep it updated.
> Whenever anything is implemented/changed/decided, record it here **in the same task**.
> Read **[[Maintenance]]** first. `docs/` is frozen reference — do not use it for tracking.
> (For Claude Code sessions, the repo-root `CLAUDE.md` enforces this automatically.)

## Open it in Obsidian
1. Obsidian → **Open folder as vault** → select the **repository root** (`School Works/`), *not* just `school-works-brain/`.
   - Opening the repo root makes `[[wikilinks]]` to `docs/*` and `[[school-management-master-blueprint]]` resolve, so the brain links straight into the source specs.
   - Obsidian only treats `.md` as notes; the `apps/`, `libs/` code is ignored (shown as attachments at most).
2. Start at **[[🧠 Home]]** (the map of content). Turn on **Graph view** to see how areas connect.
3. (Optional) Settings → Files & Links → enable "Automatically update internal links".

Prefer a clean vault? Open just `school-works-brain/` — internal links work; only the `docs/*` links won't resolve.

## Structure
```
school-works-brain/
├── 🧠 Home.md                 ← start here (MOC)
├── README.md
├── 00-Meta/                   Maintenance ← read first · Documentation Map · Key Decisions · Glossary
├── 01-Product/                Product Overview
├── 02-Architecture/           System Architecture · Multi-Tenancy & Isolation
├── 03-Domain/                 Enrollment & Admissions · Attendance & Leaves ·
│                              Exams & Report Cards · Fees & Payments ·
│                              HR, Payroll, Comms & Documents
├── 04-Data-Model/             Data Model
├── 05-Security/               Security & Compliance
├── 06-API/                    API Contract
├── 07-Operations/             Deployment & Operations
├── 08-Delivery/               Roadmap & Milestones · Testing & Quality
└── 09-Progress/               Progress Tracker   ← updated every phase
```

## Note anatomy
Every note ends with:
- **Source** — the spec it maps to (root blueprint `§` + the frozen `docs/` brief, if any).
- **Implementation status** — what's built vs planned, linking to **[[Progress Tracker]]**.

## Conventions
- **Don't duplicate specs.** If you're copying paragraphs from the blueprint, link instead.
- **Living memory lives only here.** `docs/` is frozen; the root `school-management-master-blueprint.md` + `docs/consistency-register.md` are the frozen authoritative specs the brain references.
- At the end of each build phase: update **[[Progress Tracker]]** first (procedure is in that note), then any note whose status changed. Full rules: **[[Maintenance]]**.
