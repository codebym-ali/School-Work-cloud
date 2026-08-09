# school-web — frontend (Next.js 14)

The web frontend for the school-management SaaS. App Router + TypeScript. Talks to the
API same-origin (`/api/v1/*`); the httpOnly session cookies + CSRF double-submit are
handled by `lib/api.ts`.

## Run locally
Prereqs: the API + its stack running, and a seeded tenant:
```bash
# from the repo root
docker compose up -d
pnpm db:setup && pnpm db:seed      # seeds tenant "demo" / owner@demo.pk / Owner!Secret12
pnpm start:api:dev                 # API on :4000

# this app (separate install — not part of the backend package)
cd apps/web
pnpm install
pnpm dev                           # http://localhost:3001
```
Open **http://localhost:3001** and sign in with the seeded owner. The pre-filled
credentials match `pnpm db:seed`.

## How tenant routing works in dev
`next.config.mjs` proxies `/api/*` to the API, and **the destination follows the subdomain you are
browsing**: `demo.localhost:3001` → the `demo` school, `falcon.localhost:3001` → `falcon`. Same as
production. Open a different subdomain and you are in a different school; no restart.

> **Changed 2026-08-09.** The proxy used to be pinned to one origin, decided at server start, so
> every API call went to `demo` whatever the URL said — and signing in as another school's teacher
> returned *"Invalid credentials"*, because the password was being checked against a school that
> had never heard of them. If you have an `apps/web/.env.local` from before then, delete the
> `NEXT_API_ORIGIN` line in it: **an explicit value still wins**, so a stale one re-pins everything
> to `demo` and this fix will look like it did nothing.

`NEXT_API_ORIGIN` is still honoured when set, deliberately — CI, the e2e suite and anyone pointing
the UI at a remote API rely on pinning it. Bare `localhost` (no subdomain) falls back to `demo`,
since there is no subdomain to resolve a tenant from. `API_PORT` overrides the API's port (4000).

In production the frontend and API sit behind the same tenant domain (Traefik routes
`/api` → API, `/` → this app), so requests are naturally same-origin.

## Status
Scaffold: **login + dashboard** wired to the API (auth cookies + CSRF). Next: role-based
screens (admissions, students, attendance, fees counter, exams, reports) generated from
the OpenAPI contract at `/api/docs`.
