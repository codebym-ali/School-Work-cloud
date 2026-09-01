---
title: Front-End Instance Separation Plan
type: plan
status: SHIPPED — Phases 0–3 done (5 apps split); Phase 4 (marketing-only apps/web + prod hosting) remains
updated: 2026-08-29
---

# Front-End Instance Separation Plan — one app per audience, one shared API

**Raised by the operator (2026-08-29):** *"Separate the instances for different roles — SuperAdmin,
Owner Admin, Staff roles, and Student."* Locked decisions: **split front-ends only (one shared API)**;
**four apps, strictly per role — SuperAdmin · Owner · Staff · Student**; **driver = security isolation
/ blast radius.** Companion context: [[Operations Admin Role Plan]], [[Owner Login Plan]],
[[Deployment & Operations]] (VPS subdomain hosting), [[Key Decisions]], [[Multi-Tenancy & Isolation]].

---

## 1. Where we are today
**One** Next.js app (`apps/web`) serves four very different audiences from one bundle and one origin:
the public **marketing** site (apex `/`), the vendor **SuperAdmin** console (`/admin/*`, `platform_users`
auth), the **school app** (`(app)/*` — owner, campus admin, ops, teacher, staff), and the **student
portal** (`(app)/me/*` + `/portal`). One NestJS **API** enforces the real boundaries: subdomain = tenant,
Postgres **RLS**, and `@Roles` guards on every route. The API is **same-origin only**
(`app.enableCors({ origin: false, credentials: true })`) with **httpOnly, Secure, SameSite=Strict**
cookies + CSRF double-submit.

The weakness the operator is targeting: a bug, XSS, or compromised dependency in *any* of those surfaces
ships in the *same* bundle/origin as the others. A flaw in a student page sits next to the vendor console.

## 2. Decision — four front-end apps, aligned to the login doors
Split the one web app into **four separate Next.js apps** (plus marketing), each its own build, origin,
and deployment, **all talking to the one unchanged API**. The split lands exactly on the **auth boundary
that already exists** ([[Owner Login Plan]] — `login-door.ts`):

| App | Audience (roles) | Login door | Host (prod) |
|-----|------------------|-----------|-------------|
| **SuperAdmin** | `PLATFORM_ADMIN` operators (SUPER_ADMIN/BILLING/SUPPORT/ANALYST) | platform console | `superadmin.schoolworks.com` |
| **Owner** | `OWNER_ADMIN` only | `/owner-login` | `owner.<school>.schoolworks.com` |
| **Staff** | `OPERATIONS_ADMIN`, `CAMPUS_ADMIN`, `ACCOUNTANT`, `HR_MANAGER`, `ADMISSION_CONTROLLER`, `TEACHER`, `STAFF` | `/login` (staff door) | `staff.<school>.schoolworks.com` |
| **Student** | `STUDENT` | `/portal/auth/login` | `student.<school>.schoolworks.com` |
| *(Marketing)* | public | — | apex `schoolworks.com` |

Why doors, not an arbitrary carve-up: the owner door already refuses everyone but the owner, and the
staff door already refuses the owner — so "who may load this app at all" is already decided and tested
(`auth.e2e`). One app per door makes that boundary *physical* instead of a runtime check.

> ⚠️ **Honest note on Owner vs Staff.** The two overlap heavily — the owner can do everything the staff
> app does, plus a few *roots of trust* (appoint a deputy, module access, Campus Hub, delete a student).
> And **Ops Admin** (a staff-door role) already holds owner-level *operational* config (fee/exam setup,
> school settings — see [[Operations Admin Role Plan]]). So the Owner and Staff apps are **~90% the same
> screens**. Splitting them is still worth it for the **origin isolation** below, but the screens MUST be
> shared code (packages, §4), not copy-pasted — otherwise every fee/attendance screen has two truths, the
> exact failure the Classes refactor and the permission matrix exist to prevent.

## 3. What the split buys — and what it does NOT (read before valuing it)
**Buys (client-side blast radius — the driver):**
- **Origin isolation.** `student.…`, `staff.…`, `owner.…`, `superadmin.…` are distinct origins. A script
  on the student app **cannot read the owner/superadmin session cookie** (SameSite=Strict, first-party per
  origin) nor reach their code. XSS/supply-chain damage is confined to one audience.
- **Smaller surface per app.** The student bundle ships **zero** admin code; the SuperAdmin console ships
  **zero** tenant code. Less code = fewer gadgets to exploit, and a **tighter CSP per app**.
- **Independent patch/rollback** of one surface without touching the others.

**Does NOT buy (state plainly so it isn't over-valued):**
- **It is not the authorization boundary.** The API still authorizes every request by JWT + `@Roles` +
  RLS. Someone hitting the API directly is bounded by those regardless of which front-end exists. The
  split is **defence-in-depth on the client**, not a replacement for server-side authz. *Do not move any
  security check out of the API into "well, that app isn't shipped to them."*
- **It does not change tenant isolation** — RLS + `JWT.sid` already do that, per tenant, unchanged.

## 4. Monorepo shape — shared code is the whole game
Extract the reusable core out of `apps/web` into packages, then each app composes what it needs:

```
apps/
  api/                 # unchanged NestJS API (the one enforcement point)
  worker/              # unchanged
  superadmin-web/      # /admin/* → its own app         (platform auth)
  owner-web/           # owner console + roots of trust
  staff-web/           # the operational school app (campus/ops/teacher/…)
  student-web/         # /portal + /me
  marketing-web/       # apex landing (page.tsx + page.module.css)
packages/
  ui/                  # design tokens, globals.css, icon set, shared components
  api-client/          # lib/api.ts + all response types (the fetch client)
  session/             # me-context, login flows, MFA, auth-redirect guards
  roles/               # lib/roles.ts (hierarchy: rolesSatisfying/effectiveRoles/isSchoolWideAdmin)
  school-ui/           # the shared SCHOOL screens (students, fees, attendance, exams, …)
  config/              # shared tsconfig / eslint / next presets
libs/                  # common, database (backend, unchanged)
```
- **`school-ui` is what makes Owner-vs-Staff safe:** both apps import the same screen components and gate
  them with the `roles` package (`isSchoolWideAdmin`, `hasAnyRole` — already built in the Ops UI pass).
  Owner-web additionally mounts the root-of-trust screens; staff-web does not ship them at all.
- pnpm workspaces already exist; this is new packages + moving files, **not** a framework change.

## 5. Hosting, TLS & tenant resolution (the operational core)
**Same-origin BFF per app — do NOT go cross-origin.** Each app is served on its subdomain and **proxies
`/api/v1/*` to the one internal NestJS** (reverse-proxy route or Next rewrite). The browser only ever
talks to its own origin, so:
- cookies stay **first-party + SameSite=Strict**, CSRF double-submit unchanged,
- the API keeps `origin: false` (no cross-site CORS, no `SameSite=None`) — **minimal API change.**

A cross-origin `api.schoolworks.com` shared by all apps is the tempting alternative and is **wrong here**:
it forces `SameSite=None; Secure` + a CORS allow-list, which reopens exactly the cross-site cookie exposure
the split is meant to reduce.

**Host format & tenant:** tenant apps use **`<role>.<school>.schoolworks.com`** (e.g.
`owner.greenwood.schoolworks.com`). The API's `TenantResolutionMiddleware` extracts the **school** label
(ignoring the role prefix) pre-auth (for the login screen); post-auth the tenant comes from **`JWT.sid`**
as it does today. SuperAdmin is `superadmin.schoolworks.com` (no school — platform context).

**TLS for the two-level host:** a single `*.schoolworks.com` wildcard does **not** cover
`owner.greenwood.…` (wildcards match one label). Two clean options:
- **(Recommended) Caddy on-demand TLS** — issues a cert per hostname on first request, gated by an `ask`
  endpoint that confirms `<school>` is a real, active tenant. No wildcard juggling; new schools/roles just
  work. Pairs well with the [[Deployment & Operations]] VPS plan.
- **Per-school wildcard** `*.<school>.schoolworks.com` via ACME **DNS-01**, issued when a tenant is
  provisioned. Fewer moving parts at request time, more at provisioning time.

**Dev experience:** one dev server per app on its own port — marketing `:3000`, owner `:3001`,
staff `:3002`, student `:3003`, superadmin `:3004` — each rewriting `/api` → `:4000`.
⚠️ This is **dev convenience only**. It is *not* the rejected "role-per-port as a security boundary" idea
([[Key Decisions]]): in prod these are subdomains on 443; ports never encode a tenant or a permission.

## 6. Cross-cutting details to get right
- **A user with two roles** (e.g. teacher + accountant) uses the **staff** app; a person who is somehow
  owner + teacher uses the **owner** app (owner door wins, matching `usesTeacherShell`/`login-door.ts`).
  Each app is one door, so there is no in-app "switch role" — you sign in to the app you need.
- **Deep links / redirects:** `landingPath()` moves into the `roles` package; each app has its own login
  redirect target. A staff member who lands on an owner URL simply has no such route in their app.
- **Session cookie name/scope:** unchanged per origin. No SSO across the role apps by design — that
  separation *is* the feature.
- **Manifest / PWA / branding** per app (the student app can be an installable portal; the console need
  not be).
- **Observability:** tag Sentry/analytics by app so a spike is attributable to one surface.

## 7. Phased rollout (each phase independently shippable, lowest risk first)
- **Phase 0 — extract packages, still one app. ✅ PARTIALLY SHIPPED (2026-08-29).** Pull the shared libs
  out of `apps/web`; the app imports them via re-export shims and behaves identically. **Done:** the
  **react-free** libs — `@sw/api-client` (`lib/api.ts`), `@sw/roles` (`lib/roles.ts`), and `@sw/ui` (the
  `IconName` type only, so `@sw/roles` stays pure-logic). Wired via a tsconfig alias `@sw/* →
  packages/*/src` (no pnpm workspace needed — same idiom as `@common`) + Next `experimental.externalDir`.
  Shims at the old `@/lib/*` / `@/components/icon` paths keep every existing import byte-identical.
  Gates green: web `tsc`, **full `next build`**, `lint`, backend build.
  **Deferred:** the **react-bearing** packages — the `<Icon>` component and the full `ui` component set,
  and `session` (`me-context`, `campus-lens`). Reason: this repo is **not** a pnpm workspace, so a package
  outside an app cannot resolve `react` (no hoisting). **Update after Phase 1:** the SuperAdmin app shipped
  *without* needing this (it uses only react-free `@sw/*` + its own components), which shows the react-share
  problem only bites when two apps must **share React components** — i.e. **Phase 3 (Owner/Staff)**, which
  share the big `school-ui`. So the pnpm-workspace foundation + the react-bearing `ui`/`session` extraction
  now land in **Phase 3**, not Phase 1. Until then the `<Icon>` component stays in each app (using the
  shared `IconName` type) and `session` stays in `apps/web/lib`.
- **Phase 1 — SuperAdmin app. ✅ SHIPPED (2026-08-29).** Stood up `apps/superadmin-web` as a standalone
  Next app (its own `package.json`/install/`node_modules`, dev port **3004**, own `next.config`/`tsconfig`),
  and moved the whole console out of `apps/web`: `app/admin/*` → root routes (`/`, `/billing`, `/leads`,
  `/operators`, `/security`, `/login`, `/set-password`) — the `/admin` prefix is gone because the origin
  *is* the console; the nested `admin/layout.tsx` became a root `layout.tsx` + a client `ConsoleShell`;
  `lib/platform-api.ts` + `me-context` moved with it; `globals.css` copied (its own design-system copy).
  **Zero tenant code:** extracted `ApiError` into a new react-free **`@sw/http`** so the console (and
  `platformApi`) use it without importing the tenant `@sw/api-client`. Its API proxy targets a **fixed
  origin** (`127.0.0.1:4000` dev / `NEXT_API_ORIGIN`) — every call is `/api/v1/platform/*`, which the API
  **excludes from tenant resolution**, so no tenant subdomain / `*.localhost` DNS is needed (prod: the
  reserved `superadmin`/`admin` subdomain). **No pnpm workspace was needed** — a second standalone-install
  app resolves the react-free `@sw/*` packages via the same tsconfig alias. **Verified:** console `tsc` +
  full `next build` (all 7 routes); `apps/web` `tsc` + `next build` clean after the console's removal;
  lint clean; **live smoke** — console serves on `:3004` (login renders) and its `/api` proxy reaches the
  platform routes (401 guarded). `apps/web` no longer serves the console.
- **Phase 2 — Student app. ✅ SHIPPED (2026-08-29).** Stood up `apps/student-web` (standalone install,
  dev port **3003**) and moved the portal out of `apps/web`: `(app)/me/*` → root routes (`/`,
  `/attendance`, `/timetable`, `/results`, `/fees`) and `student-login` → `/login`; a small client
  `StudentShell` (auth gate + top nav) replaces the shared `(app)` shell. **Tenant-scoped** (student
  signs in by reg-no + CNIC, which is per-school), so — unlike the console — it uses the same tenant-aware
  dev runner as `apps/web` (`dev.mjs` + `dev-dns.cjs`, `NEXT_API_ORIGIN=demo.localhost:4000`) and the
  subdomain-following `/api` proxy; prod host `student.<school>.schoolworks.com`. **Sharing without a
  workspace:** the react-**free** utils it needed (`format`, `student-status`, `timetable`) moved into
  `@sw/ui` (shims left in `apps/web/lib`), and it imports `@sw/api-client`/`@sw/http` via the alias. The
  one react component it uses (`Metric`) is **copied** into `student-web/components` for now — the single
  duplicated file, deduped into `@sw/ui` when the workspace lands (Phase 3). `apps/web` keeps a tiny
  `/student-login` **redirect stub** (→ `NEXT_PUBLIC_STUDENT_URL`, dev `localhost:3003`) so its existing
  links (marketing footer, login chooser, admissions portal) don't 404. **Verified:** student-web tsc +
  `next build`; `apps/web` tsc + build clean after removal; lint clean; **live smoke** — portal serves on
  `:3003` (login renders) and its `/api` proxy reaches `/portal/*` (401 guarded).
- **Phase 3 — Owner / Staff split.**
  - **3a — workspace + shared React UI. ✅ SHIPPED (2026-08-29).** The architectural unlock: a
    `pnpm-workspace.yaml` (members `apps/*`) + `.npmrc` `node-linker=hoisted` give a flat root
    `node_modules` with a SINGLE react/react-dom/next, reachable from `packages/*` — so apps can now share
    React components. Moved the shared React UI into `@sw/ui` (the `Icon` set + the `Metric` components)
    and extracted `@sw/session` (`me-context`, `campus-lens`); `apps/web` keeps re-export shims, and
    student-web's Phase-2 `Metric` copy is deduped. Removed the per-app lockfiles (one root lock now).
    Verified in a clean env: backend build; all three existing apps `next build` (web 42/42 static pages);
    lint; Prisma regenerated. ⚠️ *Windows note:* run `next build` with the dev servers stopped — stray
    node processes make the static-generation workers crash (`0xC0000142`), unrelated to the code.
  - **3b — the Owner + Staff apps. ✅ SHIPPED (2026-08-29).** The whole `(app)` tree (34 screens + their
    sub-components + the shell `layout`, the shared components charts/notification-bell/teacher-tabs/
    move-student-dialog/email-password-signin, and the libs attendance/labels/date-ranges/subject-match/
    timings/use-phone) moved out of `apps/web` into a new shared **`@sw/school-ui`** package. All `@/`
    imports were rewritten: shared → `@sw/*`, school-ui-internal → a new **`@school/*`** alias
    (`packages/school-ui/src/*`). Stood up **`apps/owner-web`** (dev 3005) and **`apps/staff-web`** (dev
    3006), both tenant-scoped: each has **thin `app/(app)/<route>/page.tsx` files** re-exporting the shared
    page components + the shared shell layout, generated by a script. owner-web mounts every route + the
    owner door (`/login` → `api.ownerLogin`); staff-web omits the owner-only **Campus Hub** and uses the
    staff door (`api.login`). Runtime role-gating (RolesGuard + `isSchoolWideAdmin`/`groupedNav`) already
    differentiates what each role sees. `apps/web` still works via its own thin `(app)` re-exports (it
    becomes marketing-only in Phase 4). **Verified (clean env):** owner-web `next build` 35/35 static pages,
    staff-web 34/34, apps/web 42/42; superadmin + student `tsc`; backend build; lint. One hoisted React
    across all apps. ⚠️ *Build-verified, not dev-smoked for owner/staff (builds static-generate every page,
    which executes the components); the shell + proxy pattern is the same one live-smoked for student.*
- **Phase 4 — Marketing app** on the apex; retire the old `apps/web`.
- **Infra (parallel):** reverse proxy + on-demand TLS + `<role>.<school>` routing, wired in [[Deployment & Operations]].

## 8. Risks & open decisions
- **Owner/Staff overlap (§2).** Confirmed the biggest cost. Mitigated by `school-ui`; still doubles the
  build/deploy count for ~one app's worth of unique screens. *Open:* accept the 4-app split now, or ship
  Owner+Staff as one `school-web` (3 apps) and split later?
- **URL depth & TLS.** `<role>.<school>.…` needs on-demand or per-school certs (§5). *Open:* Caddy
  on-demand (recommended) vs per-school wildcard.
- **Playwright suites** live against `apps/web` today; they must be re-homed per app (more suites, each
  smaller). Backend suites (api/isolation/matrix) are **unaffected** — the API doesn't change.
- **Shared-package versioning** inside the monorepo (one version, built together) — keep it a workspace,
  not published packages, to avoid version skew.
- **SEO/SSR** for marketing only; the app surfaces stay client-rendered as now.

## 9. Definition of Done (per phase)
Each extracted app: builds and type-checks; its own lint + Playwright smoke; **the API is byte-unchanged**
(no new CORS origins, cookies still SameSite=Strict, `origin:false`); the tenant-isolation, matrix-conformance,
and route-coverage suites stay green (they test the API, which is untouched); the reverse proxy serves the
subdomain over HTTPS with a valid cert; and a signed-in session on one role app is provably **not** usable
on another (distinct origin, distinct cookie). Update the brain (this plan → shipped per phase, Progress
Tracker, [[Deployment & Operations]], [[Key Decisions]]).
