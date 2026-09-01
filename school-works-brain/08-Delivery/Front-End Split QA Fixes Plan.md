---
title: Front-End Split — QA Fixes Plan
type: plan
status: PLANNED — not built
updated: 2026-08-29
---

# Front-End Split — plan to resolve the QA issues

Resolves the three issues (+ minors) from [[Front-End Split QA & Test Cases]]. All are **test-infra /
cleanup** — the split itself is regression-free. Goal: get the CI merge gates green again and tidy up,
before the split (branch `feat/frontend-prod-cutover`) is merged.

## Priority & sequencing
| # | Fix | Priority | Effort | Risk |
|---|-----|----------|--------|------|
| 1 | `route-coverage` scanner → look where the UI moved | **P1** (merge gate red) | S | Low |
| 3 | delete dead `apps/web` shims | **P1** (trivial, do with #1) | XS | None |
| 2 | re-home the Playwright e2e suite | **P2** (broken coverage, not in the merge gate) | M–L | Med |
| 4 | lint `packages/*`; prune owner-web over-mount | P3 (hygiene) | S–M | Low |

Do **1 + 3 together** (one commit, restores the gate), then **2**, then **4** if time allows.

---

## Fix 1 — `route-coverage` scanner *(P1, small)*
**Root cause.** `test/integration/route-coverage.e2e-spec.ts` → `readWeb()` walks only
`apps/web/{app,lib,components}`. The split moved the callers: the **API path strings** now live in
`packages/api-client/src` (the `api.*` client) and screens live in `packages/school-ui/src` + the new
apps. So 146 routes look "uncovered."

**Approach.** Point `readWeb()` at every front-end source root, not just `apps/web`:
- `packages/**/src` (api-client has the path literals; school-ui has the inline `apiGet(\`/x/${id}\`)` calls),
- `apps/*/app` (each app's routes/pages, for any inline calls),
- keep `apps/web/{lib,components}`.
Guard the directory walk against missing dirs (it uses `readdirSync`, which throws) so a not-yet-created
app doesn't break it.

**Files.** `test/integration/route-coverage.e2e-spec.ts` (only the `roots` list + a `existsSync` guard).
**Verify.** `pnpm test:integration -- route-coverage` → back to green (0 uncovered beyond the existing
`MISSING_UI_BACKLOG`). If any route is *genuinely* now uncovered (UI truly gone), add it to the backlog
with a comment — but none is expected (the split moved UI, didn't delete it).
**DoD.** route-coverage passes; the gate again catches a real orphaned route.

## Fix 3 — delete dead `apps/web` shims *(P1, trivial — bundle with Fix 1)*
**Root cause.** After the trim, seven re-export shims in `apps/web` are imported by **zero** pages:
`lib/{me-context,campus-lens,format,student-status,timetable}` + `components/{icon,metric}`.

**Approach.** `git rm` the seven files. (Keep `lib/{api,roles,app-urls}` — still used by marketing/login/`p`.)
**Verify.** `apps/web` `tsc` + `next build` still green; grep confirms no remaining `@/lib/...`/`@/components/...`
import of a deleted shim.
**DoD.** No dead shims; web build unchanged (7/7).

## Fix 2 — re-home the Playwright e2e suite *(P2, medium–large)*
**Root cause.** `test/e2e/*.spec.ts` (~20 specs) drive the school app + `/owner-login` / `/staff-login`
on `apps/web:3001`. Those routes 404 there now (moved to owner-web/staff-web) and the doors are gone.
Not in the standard merge gate (needs live servers), so builds didn't catch it.

**Approach (lowest-churn).** `owner-web` serves the **entire** school app + the owner door, so most specs
re-home to it with almost no per-spec change:
1. **`playwright.config.ts`** — set `baseURL` to `http://localhost:3005` (owner-web) for the default project;
   change `webServer` to start the apps the suite needs (owner-web, and staff-web/superadmin-web/student-web
   for the door-specific specs) **plus the API + worker**. (Multiple `webServer` entries are supported.)
2. **`test/e2e/helpers.ts`** — the login helper hits the door: point the owner sign-in at `/login`
   (owner-web's door, was `/owner-login`), keep the staff/console/student flows pointed at their apps'
   origins where a spec needs them (per-test `baseURL` or full URLs).
3. **Per-spec touch-ups** — specs that hard-code `/owner-login` / `/staff-login` / cross-door assertions
   (`owner-login.spec.ts`, any door-refusal test) move to the right origin; the rest use the default
   owner-web baseURL and are largely unchanged (`goto('/students')` etc. still resolve).
4. **Console spec** (`admin.spec.ts`) → superadmin-web:3004 at root paths (`/`, `/billing`, …).
5. **Student flows** (if any) → student-web:3003.

**Effort.** Medium–large: mostly config + helpers; a handful of specs need origin/path edits. The
multi-server `webServer` + build/start on Windows is the fiddly part (start prebuilt apps via `next start`
to avoid dev-compile latency; **stop background node before building** per the Windows quirk).
**Verify.** `pnpm test:e2e` (or a subset) green against the re-homed origins. As an interim, at least
`owner-login.spec` + one school-app spec (e.g. `students`/`classes`) + the console spec.
**DoD.** The Playwright suite runs green against the split; door-refusal assertions still hold
(owner refused at staff door and vice-versa).

## Fix 4 — hygiene *(P3, optional)*
- **Lint `packages/*`.** `pnpm lint` globs `{apps,libs,test}/**/*.ts` (never `.tsx`), so `@sw/school-ui`
  is type-checked (via app builds) but not ESLinted. Extend the glob to `packages/` and add `.tsx`
  linting (a `lint` script per front-end already runs `next lint`, but the shared packages have no linter).
  ⚠️ May surface lint findings in the moved code → budget a cleanup pass; do this LAST.
- **Prune owner-web over-mount.** owner-web ships the teacher-mobile routes (`home`, `my-classes`,
  `my-timetable`, `me-more`, `my-*`) an owner never uses. Remove those thin routes from owner-web (as
  Campus Hub was pruned from staff-web) — a `rm` of the thin route files; runtime is unchanged (they were
  role-gated anyway). Cosmetic.

## Overall DoD
`route-coverage` + `matrix-conformance` + `tenant-isolation` green; all 5 apps build; the Playwright
suite runs green against the split; no dead shims. Update [[Front-End Split QA & Test Cases]] (issues →
fixed) and the Progress Tracker.
