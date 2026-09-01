---
title: Front-End Split — QA & Test Cases
type: qa
status: RUN 2026-08-29
updated: 2026-08-29
---

# Front-End Instance Separation — QA test cases + live run

**Scope:** the five-app split (Phases 0–4 of [[Front-End Instance Separation Plan]]). This is a
**refactor** (moving code between apps + shared packages), so the acceptance criteria are: no backend
regression, each app builds and serves ONLY its intended routes (origin/route isolation), shared code
resolves, and cross-app navigation is wired. **Method:** full `next build` per app (compile + static
generation executes every page), backend merge-gate suites, `next start` runtime route-partition
probes, and rendered-HTML checks of the cross-app links. Run 2026-08-29, clean env (dev servers stopped).

**Result headline:** the split itself is **sound** — all five apps build, partition perfectly at
runtime, and the backend is unaffected (isolation 7/7, matrix-conformance 602). Three issues found, all
in **test-infra / cleanup**, none a user-facing product defect (see §Issues).

## Build gate (all ✅)
| App | Build | Static pages |
|---|---|---|
| backend (api + worker) | ✅ | — |
| web (marketing) | ✅ | 7/7 |
| superadmin-web | ✅ | 10/10 |
| owner-web | ✅ | 37/37 |
| staff-web | ✅ | 36/36 |
| student-web | ✅ | 9/9 |
Plus: `apps/web` + all four new apps `tsc` clean; `pnpm lint` clean.

## Per-phase test cases

### Phase 0 — react-free shared packages (`@sw/api-client`, `@sw/roles`, `@sw/ui` type, `@sw/http`)
| TC | Case | Expected | Result |
|----|------|----------|--------|
| P0-1 | `apps/web` imports the extracted libs via re-export shims, behaves identically | web build + tsc green | ✅ |
| P0-2 | Shared client type + roles resolve across apps via the `@sw/*` alias | consumers compile | ✅ |
| P0-3 | Backend untouched by the extraction | backend build + suites green | ✅ |

### Phase 1 — SuperAdmin app (`superadmin-web`, console)
| TC | Case | Expected | Result |
|----|------|----------|--------|
| P1-1 | Serves the console at root (`/`, `/billing`, `/leads`, `/operators`, `/security`, `/login`, `/set-password`) | 200 | ✅ (build 10/10; `/`, `/billing` → 200) |
| P1-2 | Ships **zero tenant code** — no school routes | `/students`, `/dashboard` → 404 | ✅ 404 |
| P1-3 | `/api` proxy reaches tenant-agnostic platform routes | 401 guarded | ✅ (Phase-1 live smoke) |

### Phase 2 — Student portal (`student-web`)
| TC | Case | Expected | Result |
|----|------|----------|--------|
| P2-1 | Serves the portal at root (`/`, `/attendance`, `/timetable`, `/results`, `/fees`, `/login`) | 200 | ✅ (build 9/9; `/`, `/attendance`, `/fees` → 200) |
| P2-2 | No staff/owner routes | `/dashboard` → 404 | ✅ 404 |
| P2-3 | Tenant-scoped `/api` proxy reaches `/portal/*` | 401 guarded | ✅ (Phase-2 live smoke) |

### Phase 3a — workspace + shared React UI
| TC | Case | Expected | Result |
|----|------|----------|--------|
| P3a-1 | Single hoisted React shared across apps (Icon/Metric/session) | all apps build; no dup-react hook errors | ✅ |
| P3a-2 | `student-web` Metric deduped to `@sw/ui` | student build green | ✅ |

### Phase 3b — Owner + Staff apps (share `@sw/school-ui`)
| TC | Case | Expected | Result |
|----|------|----------|--------|
| P3b-1 | owner-web serves the full school app | `/dashboard` → 200 | ✅ |
| P3b-2 | **owner-only** Campus Hub is in owner-web | owner `/campuses` → 200 | ✅ |
| P3b-3 | Campus Hub **pruned** from staff-web | staff `/campuses` → **404** | ✅ |
| P3b-4 | admission-portal is staff-only | staff `/admission-portal/main` → 200; owner → **404** | ✅ |
| P3b-5 | Both share one copy of the screens (thin re-exports of `@school/*`) | builds green, no duplication | ✅ |

### Phase 4 — wiring, trim, TLS gate, containers
| TC | Case | Expected | Result |
|----|------|----------|--------|
| P4-1 | `apps/web` trimmed to marketing | `/` 200, `/login` 200, `/dashboard` **404**, `/students` **404** | ✅ (42→7 routes) |
| P4-2 | Edge pages moved to role apps (same-origin cookies) | owner/staff `/break-glass`, `/set-password` → 200 | ✅ |
| P4-3 | Login **chooser** links cross-origin | hrefs → :3005 (owner), :3006 (staff), :3003 (student) | ✅ |
| P4-4 | Marketing **footer** links cross-origin | same three hrefs | ✅ |
| P4-5 | `host-allowed` TLS gate | real tenant/role/console → 200; unknown → 404 | ✅ (localhost/demo/owner.demo/superadmin=200; nope/owner.nope=404) |

## Runtime route-partition matrix (the split's core guarantee) — ✅ all pass
```
                 /      /login  /dashboard  /students  /campuses  /admission-portal  /break-glass
web        (3001) 200    200      404         404        —          —                  —
superadmin (3004) 200    200      404         404        —          —                  —
owner      (3005) —      200      200         200        200        404                200
staff      (3006) —      200      200         200        404        200                200
student    (3003) 200    200      404         —          —          —                  —
```
(200 = route exists — present-but-auth-gated pages return the shell HTML then client-redirect; 404 =
route absent = correctly NOT in this app.)

## Backend regression (the split is front-end only)
- **tenant-isolation** — 7/7 ✅ · **matrix-conformance** — 602 passed ✅ · backend build ✅.
- **route-coverage** — **1 FAILED** → Issue 1.

---

## Issues found

### Issue 1 — `route-coverage` merge gate broken by the split *(Medium — CI gate, no user impact)*
`test/integration/route-coverage.e2e-spec.ts` asserts every API route has a caller in the web source,
but its `readWeb()` scans **only `apps/web/{app,lib,components}`**. The split moved the calling UI into
`packages/school-ui` (and the other apps), so it now reports **146 routes with no caller** and fails.
The routes ARE called — the scanner is looking in the wrong place. **Fix:** extend `readWeb()` to also
walk `packages/school-ui/src` (and the app dirs), or point it at the whole `packages/`+`apps/` front-end.

### Issue 2 — Playwright e2e suite targets moved routes *(Medium — broken test coverage)*
`test/e2e/*.spec.ts` (~20 specs: admin, admissions, attendance, calendar, campuses, classes, exams,
fees, owner-login, …) drive the school app at `apps/web` (`/dashboard`, `/students`, `/owner-login`,
`/staff-login`, …). After the trim those routes 404 on `apps/web` and the owner/staff doors are gone, so
the whole suite would fail against `apps/web:3001`. It's not in the standard merge gate (needs running
servers), so builds didn't catch it. **Fix:** re-home the specs to the new apps' origins — owner/staff
flows → owner-web:3005 / staff-web:3006, the console spec → superadmin-web:3004 — and update the base
URLs / login helpers. (Backend integration + isolation suites are unaffected.)

### Issue 3 — dead shim files left in `apps/web` *(Low — cleanup)*
After the trim, `apps/web` still contains re-export shims used by **zero** remaining pages:
`lib/me-context`, `lib/campus-lens`, `lib/format`, `lib/student-status`, `lib/timetable`,
`components/icon`, `components/metric`. Harmless (tree-shaken out of the build) but dead. `lib/api`,
`lib/roles`, `lib/app-urls` are still live (marketing/login/`p`). **Fix:** delete the seven dead shims.

### Minor observations (not defects)
- **Over-mounting:** owner-web ships the teacher-mobile routes (`home`, `my-classes`, `my-timetable`,
  `me-more`, `my-*`) an owner never uses. Role-gated at runtime, harmless; could be pruned like Campus Hub.
- **`packages/*` aren't linted** — `pnpm lint` globs `{apps,libs,test}/**/*.ts` (and never `.tsx`), so the
  moved `@sw/school-ui` code is type-checked (via app builds) but not ESLinted. Pre-existing gap, now larger.
- **Windows build quirk (not a code issue):** `next build` must run with dev servers stopped — stray node
  crashes Next's static-generation workers (`0xC0000142`).

**Verdict:** the split is functionally correct and regression-free on the product side; the open items are
test-infra (Issues 1–2, worth fixing before relying on CI) and one cleanup (Issue 3).
