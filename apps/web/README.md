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
`next.config.mjs` proxies `/api/*` → `NEXT_API_ORIGIN` (default `http://demo.localhost:4000`).
The destination host carries the **tenant subdomain**, so the API resolves the `demo`
school. For another tenant, set `NEXT_API_ORIGIN=http://<slug>.localhost:4000`.
In production the frontend and API sit behind the same tenant domain (Traefik routes
`/api` → API, `/` → this app), so requests are naturally same-origin.

## Status
Scaffold: **login + dashboard** wired to the API (auth cookies + CSRF). Next: role-based
screens (admissions, students, attendance, fees counter, exams, reports) generated from
the OpenAPI contract at `/api/docs`.
