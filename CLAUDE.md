# CLAUDE.md — project guide for AI agents & contributors

Multi-tenant **school-management SaaS** for private schools in Pakistan. NestJS 10 monorepo
(`apps/api`, `apps/worker`, `libs/common`, `libs/database`) + Prisma + Postgres 16 (RLS) +
Redis/BullMQ. Built from `school-management-master-blueprint.md` (authoritative spec).

## 🧠 THE RULE: keep the brain updated
**`school-works-brain/` is the single living memory of this project.** Whenever you implement,
change, decide, or discover anything, **record it in the brain as part of the same task.**
- Read **`school-works-brain/00-Meta/Maintenance.md`** first — it defines exactly what to update.
- **End of every phase/feature → update `school-works-brain/09-Progress/Progress Tracker.md`**
  (procedure is at the bottom of that file), plus the relevant area note's *Implementation status*.
- Record non-obvious decisions/gotchas in `school-works-brain/00-Meta/Key Decisions.md`.
- Commit brain updates **with** the code change.

## 🚫 Do NOT use `docs/`
`docs/` (numbered briefs) is **frozen reference only** — never track progress or record
decisions there. The authoritative spec is the root `school-management-master-blueprint.md`
+ `docs/consistency-register.md` (LOCKED). The brain is the living view; the briefs are superseded.

## Non-negotiable engineering conventions
- **Tenancy:** every tenant table carries `school_id`; 3-layer isolation (Prisma extension + RLS FORCE + merge-blocking isolation suite). `app_user` has no BYPASSRLS. See `school-works-brain/02-Architecture/Multi-Tenancy & Isolation.md`.
- **DB:** snake_case (`@@map`/`@map`), UUID PKs, `Decimal(12,2)` money. Services **pass `schoolId` explicitly on creates** (the extension asserts it). **Avoid Prisma `upsert` on tenant models** (the extension merges `schoolId` into the where clause, breaking the unique selector — use find-then-write).
- **§22.8 ownership checks that read tenant data go in the service, not a guard** (guards run before the `withTenant` tx → RLS returns 0 rows).
- **Quality gates must stay green:** tenant-isolation suite, RLS-coverage check, lint, strict typecheck, api+worker build. State machines/business rules are the acceptance criteria.

## Common commands
```bash
docker compose up -d                 # pg (5433) · redis (6381) · minio · clamav
pnpm db:setup                        # prisma migrate + SQL companions + RLS-coverage check
pnpm db:seed                         # demo tenant → demo.localhost / owner@demo.pk / Owner!Secret12
pnpm start:api:dev                   # API on :3000 (prefix /api/v1)
pnpm start:worker:dev                # BullMQ worker
pnpm test:isolation                  # merge-blocking tenant-isolation suite
pnpm test && pnpm lint && pnpm build # full green check
```
Local dev ports are shifted off the user's other project "Goex": Postgres **5433**, Redis **6381**.
```
