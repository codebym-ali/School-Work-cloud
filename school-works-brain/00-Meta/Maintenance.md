---
title: Maintenance — READ FIRST
type: meta
updated: 2026-07-06
---

# 🛠️ Maintenance — READ FIRST (for whoever continues this project)

> [!important] The golden rule
> **`school-works-brain/` is the single living memory of this project.**
> Whenever you implement, change, decide, or discover *anything*, record it here
> **as part of the same task** — not later, not "eventually". If it isn't in the
> brain, the project has forgotten it.

This applies to **every contributor** — human or AI agent (Claude Code included; see the
repo-root `CLAUDE.md`, which points here).

## ✅ Do
- **Update [[Progress Tracker]] at the end of every phase/feature** — follow the "How to update" procedure at the bottom of that note (move the milestone, tick the checklist, list the tests that went green, note findings/deviations, bump the header).
- **Update the relevant area note** whose *Implementation status* changed (e.g. build fees → update [[Fees & Payments]]).
- **Record non-obvious decisions & gotchas** in [[Key Decisions]] (or the area note), with the *why*. Future-you will not remember why.
- **Add new terms** to [[Glossary]] and link them.
- Keep notes **concise and linked** — summarise, then link to the authoritative spec. Do not paste spec paragraphs.
- Commit brain updates **with** the code change, so git history and the brain agree.

## 🚫 Don't
- **Don't use `docs/` as a working document.** It is **frozen reference** (see below). Never track progress or record decisions there.
- Don't duplicate the blueprint/register — link to them.
- Don't let a milestone be "done" until [[Progress Tracker]] says so and its tests are green.

## 📖 Sources of truth (frozen — reference only)
- **`school-management-master-blueprint.md`** (repo root) — the authoritative spec. Any spec change starts as a PR here.
- **[[consistency-register]]** — the LOCKED ledger of names/numbers/rules.
- **`docs/` (numbered briefs 01–10)** — **FROZEN.** Audience-specific summaries of the blueprint. Kept for reference/traceability only; **do not edit, do not rely on for current status.** The brain supersedes them as the living view. *(Safe to delete if you prefer — they're git-tracked and redundant with the blueprint; if you do, update the "Source:" lines in the area notes to point at blueprint `§` instead.)*

## 🔁 The flow of truth
```
blueprint PR  →  consistency-register  →  (docs/ briefs, frozen)
                          │
                          └─────────►  school-works-brain/  (LIVING: status, decisions, findings)
```
Specs flow down; **living project memory lives only in the brain.**

## Quick checklist to paste into a PR / task wrap-up
- [ ] Code + tests green (isolation suite, lint, typecheck, build)
- [ ] [[Progress Tracker]] updated (milestone, checklist, tests, findings, header)
- [ ] Affected area note's *Implementation status* updated
- [ ] New decisions/gotchas in [[Key Decisions]]; new terms in [[Glossary]]
- [ ] Committed together with the change
