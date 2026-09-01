# Deploying the split front-end (Phase 4)

The app is one NestJS **API** plus **five** Next front-ends, one per audience (Front-End Instance
Separation Plan). Each front-end is served on its own origin and proxies `/api` to the shared API
same-origin, so session cookies stay first-party + `SameSite=Strict`.

## Apps, dev ports, prod hosts
| App | Dev | Prod host | Login |
|-----|-----|-----------|-------|
| `apps/web` (marketing + login chooser) | 3001 | `schoolworks.com`, `www` | — |
| `apps/superadmin-web` (vendor console) | 3004 | `superadmin.schoolworks.com` | platform |
| `apps/owner-web` | 3005 | `owner.<school>.schoolworks.com` | owner door |
| `apps/staff-web` | 3006 | `staff.<school>.schoolworks.com` | staff door |
| `apps/student-web` | 3003 | `student.<school>.schoolworks.com` | reg-no + CNIC |
| `apps/api` (NestJS) | 4000 | internal (behind the proxy) | — |

## Local dev
Start the API + worker (`pnpm start:api:dev`, `pnpm start:worker:dev`), then each front-end you need:
`cd apps/<app> && pnpm dev`. The tenant apps (web/owner/staff/student) use `dev.mjs`, which pins the
API proxy to `demo.localhost:4000` and shims `*.localhost` DNS; the console proxies to `127.0.0.1:4000`
(platform routes are tenant-agnostic). Cross-app links resolve via the `NEXT_PUBLIC_*_URL` defaults
(the ports above). ⚠️ **Windows:** run `next build` with the dev servers stopped — stray node
processes crash Next's static-generation workers (`0xC0000142`).

## Env (per front-end, production)
- `NEXT_API_ORIGIN` — internal API origin the app's `/api` proxy targets (or omit to follow the host).
- `apps/web` cross-app links: `NEXT_PUBLIC_OWNER_URL`, `NEXT_PUBLIC_STAFF_URL`, `NEXT_PUBLIC_STUDENT_URL`,
  `NEXT_PUBLIC_SUPERADMIN_URL` (owner/staff/student are tenant-scoped → per-school subdomains).
- API: `APP_APEX_DOMAIN=schoolworks.com`, `RESERVED_SUBDOMAINS` including `superadmin`, `admin`, `owner`,
  `staff`, `student`, `www` (so those role labels never resolve as a tenant).

## Reverse proxy
`Caddyfile` routes each subdomain to its app and proxies `/api` to the NestJS API. For the tenant
apps it **strips the role label from the Host** (`owner.greenwood…` → `greenwood.schoolworks.com`) so
the API's `TenantResolutionMiddleware` still resolves the school. TLS is on-demand (a cert per host,
gated by an `ask` endpoint) since `owner.<school>.schoolworks.com` is two labels deep.

## Container build
Each front-end is a standard Next standalone build (`output: 'standalone'`, skipped on Windows). One
Dockerfile per app (mirror `apps/web/Dockerfile`), or a shared multi-stage build parameterised by app
dir. The pnpm workspace means one install produces all apps' node_modules.

## Remaining before cutover
- Trim `apps/web` to marketing + chooser only: relocate the school-app routes and the edge pages
  (break-glass, admission-portal, set-password — they land in the school app) into owner/staff-web,
  and drop the transitional `(app)` re-exports + owner/staff-login pages. `apps/web` currently still
  serves the full app as a harmless superset.
- Add the API `host-allowed` endpoint for on-demand TLS (or switch to per-school DNS-01 wildcards).
- Per-app Dockerfiles + a compose/orchestrator for the five apps.
