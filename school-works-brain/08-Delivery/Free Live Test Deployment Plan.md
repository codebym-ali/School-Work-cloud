---
title: Free live test deployment — plan
type: plan
status: PLANNED — not executed
updated: 2026-09-08
---

# Getting the whole system live, free, to test

**Operator ask (2026-09-08):** *"deploy this whole system on live to test, for free."*

This is a **test/demo** deployment, not the production go-live in [[Deployment & Operations]]. The goal is
a public URL where the real product can be exercised end-to-end, at zero cost.

## What "free" actually has to survive

Four constraints kill most free tiers. A candidate must clear **all four**:

1. **A long-running worker.** BullMQ (`apps/worker`) is a permanent background process. Free tiers that
   sleep idle services, or offer only web dynos, cannot run it — and without it SMS, invoice jobs and
   mark-overdue silently never fire, which presents as a product fault rather than a hosting one.
2. **Two-level wildcard subdomains.** Tenancy is `<school>.<domain>`, and since the front-end split the
   doors are `<role>.<school>.<domain>`. This is the single most limiting requirement.
3. **Postgres where we may create roles and run RLS DDL.** The app needs three distinct connections —
   `MIGRATION_DATABASE_URL` (owns DDL), `DATABASE_URL` (`app_user`, **no BYPASSRLS**) and
   `PLATFORM_DATABASE_URL` — plus `FORCE ROW LEVEL SECURITY`. A host that hands you one restricted user
   cannot express the isolation model at all.
4. **Redis with blocking commands.** BullMQ needs real TCP Redis, not a request-counted REST façade.

## Recommendation: one Oracle Cloud **Always Free** ARM VM

**4 ARM cores · 24 GB RAM · 200 GB** — permanently free, not a trial. It is the only free option that
clears all four constraints at once, and the repo is already shaped for it: `deploy/docker-compose.prod.yml`,
`deploy/Caddyfile` and a generic front-end `Dockerfile` were written for this exact topology.

Everything runs on the one box — API, worker, the five Next apps, Caddy, **and** Postgres and Redis
locally. Running the backing services ourselves sidesteps every managed free-tier limit rather than
negotiating with it.

### Why not the obvious alternatives

| Option | Fails on |
|---|---|
| **Vercel (Hobby)** | Wildcard domains are a paid feature, so the tenancy model cannot work. No worker either. |
| **Render free** | Web services **sleep** after 15 minutes idle; background workers are not in the free plan. |
| **Fly.io** | No longer has a standing free tier (trial credit only). |
| **Railway / Koyeb** | Trial credit, or a single nano service — this stack is eight. |
| **Neon + Upstash + R2** | Each is fine alone, but Upstash free is command-counted and BullMQ polls; and you still need somewhere to run the worker. **Keep as the fallback.** |

⚠️ **Oracle asks for a card to verify identity** (Always Free is not charged), and ARM capacity is
genuinely scarce in some regions — retry, or pick another home region. If that blocks you, say so early:
the fallback is Neon + Upstash + R2 with the API and worker on a small paid box, which is no longer free.

## The genuinely fiddly part: DNS and TLS

We need `owner.demo.<something>` to both resolve **and** be certificated, for free.

**Preferred — `sslip.io`.** It resolves *any* labels in front of an embedded IP, at any depth, with no
signup: `owner.demo.<vm-ip>.sslip.io` → the VM. That satisfies the two-level requirement outright.

**TLS, in order of preference:**

1. **Caddy on-demand TLS.** `deploy/Caddyfile` already wires this to the
   `GET /platform/public/host-allowed` gate, so a certificate is issued only for hosts the API recognises
   as a real tenant — never for random probes. ⚠️ `sslip.io` is a shared domain, so Let's Encrypt rate
   limits are shared with everyone using it. If issuance fails, do not fight it; fall through to (2).
2. **`tls internal`** — Caddy's own CA. Unlimited and free; the browser warns until the CA is trusted.
   Fine for a test, and it still gives real HTTPS, which matters: the session cookies are `Secure` +
   `SameSite=Strict` and will not work at all over plain HTTP.
3. **DuckDNS**, if a stable name is wanted. ⚠️ Verify multi-level resolution
   (`owner.demo.<name>.duckdns.org`) **before** committing — a single-level wildcard would force
   flattening role and school into one label, which `TenantResolutionMiddleware` does not expect.

## Runbook

**0. Do the security gate below first.** Not last.

1. **Provision** the Always Free ARM instance (Ubuntu 22.04+). Open 80/443 in the OCI security list
   **and** in the host firewall — Oracle images ship `iptables` rules that silently drop traffic, and
   that is the most common "the VM is up but nothing answers" cause.
2. **Install** Docker + the compose plugin; clone the repo.
3. **Add Postgres 16 and Redis to the compose file.** The production compose deliberately defines
   neither — it assumes managed services. Running them on the box is the whole reason this fits a free
   tier.
4. **Write `.env`** from `.env.example`, with **freshly generated** secrets:
   - the three DB URLs (`MIGRATION_*` owns DDL; `DATABASE_URL` is `app_user` with **no BYPASSRLS**),
   - `REDIS_URL`,
   - `APP_APEX_DOMAIN` = the chosen host, and `RESERVED_SUBDOMAINS` including `superadmin`, `admin`,
     `owner`, `staff`, `student`, `www`, so a role label can never be resolved as a school,
   - `S3_*` → **Cloudflare R2 free tier** (10 GB), already the intended target in `.env.example`,
   - `CLAMAV_ENABLED=false` — already the default. There is no arm64 ClamAV image, and `scan()` is
     skipped cleanly when disabled, so uploads still work; they are simply not scanned.
5. **Build and start:** `docker compose -f deploy/docker-compose.prod.yml up -d --build`. Eight images
   build on the box; 24 GB is comfortable, but expect **20–40 minutes** on ARM the first time.
6. **Migrate and seed.** The `migrate` service runs `prisma migrate deploy` plus the SQL companions;
   then `pnpm db:seed` for the demo tenant.
7. **Verify in this order**, because each step isolates a different failure: `/api/v1/health/ready`
   (DB + Redis) → apex loads → `demo.<host>` resolves to the tenant → `owner.demo.<host>` shows the owner
   door → sign in → the worker log shows it consuming a job.

## ⚠️ Before it is public: the security gate

This is a **real multi-tenant system with real auth**, not a mock. Exposed carelessly it is an open door.

- **Change every seeded password.** `owner@demo.pk` / `Owner!Secret12` is in the repo *and* in this brain —
  anyone who reads either can sign in as the owner of the demo school.
- **Generate new secrets.** JWT signing, the CSRF secret and the PII encryption key must not be the
  `.env.example` values. ⚠️ The encryption key is not cosmetic — student CNICs are stored encrypted under
  it.
- **Keep rate limiting on** (`RATE_LIMIT_ENABLED=true`). It is the only thing between the login door and
  the open internet.
- **Do not expose the vendor console casually.** `superadmin.<host>` provisions and suspends tenants.
- Treat everything in it as **disposable test data** — no real student names, no real CNICs. The point of
  the exercise is to click around, and a free box has no backups.

## Known limits, stated up front

So none of these reads as a bug later:

- **No virus scanning** (no arm64 ClamAV image) — uploads are accepted unscanned.
- **No backups, no PITR, single node.** The nightly `pg_dump` and PITR work targets the real VPS.
- **Cold first paint** after a rebuild; no CDN in front of the apps.
- **On-demand TLS issues a certificate per host**, so the first hit on a new school subdomain is slow.
- **Oracle reclaims idle Always Free instances.** If the box disappears, that is policy, not a fault.

## Definition of done

A public URL where: the apex loads; `demo.<host>` resolves to the seeded school; the owner, staff and
student doors each sign in on their own subdomain; a register can be marked and an invoice generated; and
the worker is demonstrably consuming jobs. Plus a line in [[Progress Tracker]] recording the host and the
fact that this is a **disposable test environment**, not the production go-live.
