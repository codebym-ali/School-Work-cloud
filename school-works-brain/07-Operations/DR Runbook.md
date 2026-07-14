---
title: DR Runbook
type: ops
updated: 2026-07-14
---

# Disaster-Recovery Runbook

> [!danger] When it's on fire, start here
> 1. **Declare** — post in `#incident`, name an **Incident Lead**. 2. **Stop the bleeding** — put the app in maintenance (scale api/web to 0 at the proxy) so nothing writes to a database you're about to replace. 3. **Pick the scenario** in the decision tree below. 4. **Work the steps, out loud, one at a time.** 5. **Validate** with the post-recovery checklist before reopening.

The mechanism, cadence, and stack rationale live in [[Deployment & Operations]]; this note is the **procedure**. Backups are ours to own (self-hosted Postgres, no RDS PITR) — a backup you have never restored is not a backup, so §"Quarterly drill" is non-optional.

## Objectives (§29, §33)
| | Target | How we meet it |
|---|---|---|
| **RPO** (max data loss) | ≤ 30 min | WAL archived every **5 min** (`archive_timeout=300`) → effective ≤5 min. Nightly logical dump bounds worst case to 24h if WAL is also lost. |
| **RTO** (max downtime) | ≤ 4 h | Logical restore of one tenant-fleet DB is minutes–low-hours; the drill measures the real number. |
| **Backup integrity** | weekly proof | `restore-verify.sh` restores the latest dump into a scratch DB + smoke query, **pages on failure**. |

## Backup inventory
| Artifact | Script | Where | Cadence | Use |
|---|---|---|---|---|
| Logical dump (`pg_dump -Fc`) | `scripts/backup-postgres.sh` | R2 `s3://$R2_BUCKET/backups/YYYY/MM/DD/school-*.dump` (+ `backups/latest.txt` pointer) | nightly (Coolify scheduled task) | **Runbook A** — full restore |
| Physical base backup | `scripts/basebackup.sh` | R2 `s3://$R2_BUCKET/basebackups/base-*.tar.gz` | daily | **Runbook B** — PITR base |
| WAL segments | Postgres `archive_command` | prod: ship to R2 `wal/`; local compose: `walarchive` volume | every ≤5 min | **Runbook B** — replay to target |
| Restore proof | `scripts/restore-verify.sh` (prod) / `restore-verify-local.sh` (dev/CI) | scratch DB | weekly / per-CI | integrity gate |

> [!warning] Prod WAL must go off-box. The compose `archive_command` copies WAL to a **local `walarchive` volume** — fine for the RPO mechanism, useless if the VPS dies. Before pilot, point `archive_command` at R2 (wal-g / a small `aws s3 cp` wrapper) so **base + WAL both live in R2**. Until then, Runbook B only survives a *logical* disaster (bad migration), not host loss.

## Access you need before you start (keep in the password manager, NOT only on the box)
- R2 creds: `R2_ENDPOINT` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
- A Postgres **superuser** URL for the target instance (create/drop DB, own restore)
- App secrets to reboot the stack: `ENCRYPTION_MASTER_KEY`, `JWT_KEYS`, `DATABASE_URL`, `S3_*`, SMS creds
- SSH to the VPS + Coolify login

## Decision tree
```
Data wrong / gone?
├─ App/DB host is GONE (VPS dead, disk lost) ............ Runbook C (rebuild) → then A or B
├─ DB intact but DATA corrupted by a known event
│   (bad migration, accidental mass DELETE/UPDATE) ...... Runbook B (PITR to just before it)
├─ DB lost/unrecoverable, some data loss acceptable ..... Runbook A (latest nightly dump)
└─ ONE tenant's data damaged, others fine .............. Runbook D (single-tenant)
```

---

## Runbook A — full restore from the latest logical dump
*Use when: DB is lost/unrecoverable and losing up to ~24h (since last dump) is acceptable, or as the final step of a VPS rebuild.* **This is the simplest, most-rehearsed path** (`restore-verify.sh` runs it weekly).

1. Maintenance mode: `api`/`worker`/`web` → 0 replicas (nothing writes).
2. Set R2 env + a superuser `RESTORE_ADMIN_URL` (…/postgres).
3. Pull the latest dump:
   ```bash
   KEY=$(aws s3 cp s3://$R2_BUCKET/backups/latest.txt - --endpoint-url $R2_ENDPOINT)
   aws s3 cp s3://$R2_BUCKET/$KEY /tmp/restore.dump --endpoint-url $R2_ENDPOINT
   ```
4. Recreate the DB and restore:
   ```bash
   psql "$RESTORE_ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS school;" -c "CREATE DATABASE school;"
   pg_restore --no-owner --no-privileges --dbname="${RESTORE_ADMIN_URL%/*}/school" /tmp/restore.dump
   ```
5. Re-apply the SQL companions + RLS (roles/policies aren't in a `--no-owner` dump):
   ```bash
   node scripts/apply-sql-companions.mjs && node scripts/check-rls-coverage.mjs
   ```
   Ensure `app_user`/`platform_admin` roles exist (postgres-init.sql) and **`app_user` still lacks BYPASSRLS**.
6. Run the **post-recovery checklist** → bring the app back.

## Runbook B — point-in-time recovery (base backup + WAL replay)
*Use when: a specific bad event (migration, mass delete) at a known time T corrupted the data and you want everything up to **just before T**.* Verified locally 2026-07-14 (see drill log).

1. Maintenance mode. **Identify the target time** `T` in UTC (e.g. moment before the bad migration) — recover to `T − 1s`.
2. On a clean Postgres data dir (`PGDATA` empty/moved aside), fetch + extract the newest base:
   ```bash
   aws s3 cp s3://$R2_BUCKET/basebackups/base-<STAMP>.tar.gz - --endpoint-url $R2_ENDPOINT | tar -xz -C "$PGDATA"
   ```
3. Configure recovery (`postgresql.conf` or `postgresql.auto.conf`):
   ```
   restore_command = 'aws s3 cp s3://$R2_BUCKET/wal/%f %p --endpoint-url $R2_ENDPOINT'   # local drill: cp /walarchive/%f %p
   recovery_target_time = '2026-07-11 09:00:00+00'
   recovery_target_action = 'promote'
   ```
4. `touch "$PGDATA/recovery.signal"` and start Postgres. It replays archived WAL up to `T`, then promotes.
5. Confirm the target: check `SELECT pg_last_wal_replay_lsn();` settled and the bad change is **absent** while the last good change is **present**.
6. Post-recovery checklist → reopen. *(If you overshot/undershot, re-extract the base and adjust `recovery_target_time`.)*

## Runbook C — whole-VPS rebuild
*Use when: the host is gone.*
1. Provision a new Contabo VPS; install Docker + Coolify; restore Coolify app config (or redeploy from git: `docker-compose.prod.yml`).
2. Restore secrets from the password manager into Coolify env (`ENCRYPTION_MASTER_KEY` **must** match the old one or encrypted columns are unreadable; `JWT_KEYS` single-line JSON).
3. Bring up `postgres`/`redis`/`minio` (or managed equivalents). Run the `migrate` one-shot.
4. Restore data via **Runbook A** (or **B** if WAL is in R2 and you need PITR).
5. Repoint Cloudflare DNS (wildcard `*.domain`) to the new IP; verify TLS (Traefik/Let's Encrypt).
6. Post-recovery checklist across a couple of tenant subdomains.

## Runbook D — single-tenant recovery
*Use when: one school's data is damaged, others are healthy — you must NOT roll the whole fleet back.*
- **Preferred:** restore the latest dump into a **scratch DB** (Runbook A steps 3–4 with `SCRATCH_DB`), then copy just that `school_id`'s rows back into prod inside a `withTenant`/RLS-safe transaction (respect FK order; payments are immutable — correct via reversal, never edit).
- The blueprint's `tenant-export` replay path ([[Multi-Tenancy & Isolation]]) is the eventual tool here; **not yet built** — until then this is a careful manual, scripted, dry-run-on-scratch-first operation. Never run ad-hoc DELETE/UPDATE on prod without a dry run on the scratch copy.

---

## Post-recovery validation checklist (every scenario)
- [ ] `check-rls-coverage.mjs` green; `app_user` has **no BYPASSRLS** (`SELECT rolbypassrls FROM pg_roles WHERE rolname='app_user';` → f).
- [ ] Tenant isolation holds — run `pnpm test:isolation` against the restored DB (or the 3 spot-checks: cross-tenant read = 0 rows, unset GUC = 0 rows).
- [ ] `GET /api/v1/fees/integrity-check` per active tenant → `ok:true` (no ledger drift).
- [ ] Smoke: login on ≥2 tenant subdomains, load dashboard, one read + one write.
- [ ] Row-count sanity vs. expectation (schools/students/fee_payments not surprisingly low).
- [ ] Encrypted columns decrypt (open a record with CNIC/phone) → confirms `ENCRYPTION_MASTER_KEY` matches.
- [ ] Re-enable backups/cron; confirm the next nightly dump + weekly restore-verify are scheduled.
- [ ] Write the incident up in [[Key Decisions]] if anything non-obvious was learned.

## Quarterly DR drill (rehearse before you need it)
Run **Runbook B end-to-end** on a scratch box/stack (never prod) once a quarter; **time it** and record RTO below. Success = target-time recovery lands exactly (last good row present, bad row absent) **and** the post-recovery checklist passes. A drill that reveals a broken assumption is a *successful* drill — fix the runbook.

### Drill log
| Date | Scenario | RTO achieved | Data-loss window | Outcome / fixes |
|---|---|---|---|---|
| 2026-07-14 | Runbook A (logical), local | `restore-verify-local.sh`: 8 tables round-trip exact | n/a (drill) | ✅ PASS |
| 2026-07-14 | Runbook B (PITR), local self-contained (postgres:16-alpine, archive→volume) | promote ~2s after base fetch | recovered to exact target T | ✅ PASS — inserted GOOD → base backup → recorded T → inserted BAD; restored base + replayed WAL to T; restored DB had **only GOOD, BAD absent** |
| _next: 2026-Q4_ | Runbook B on staging VPS (WAL in R2) | — | — | pending VPS |

> [!note] Drill gotchas (fold into any VPS run)
> - The **archive dir must be writable by the postgres uid** (70 in alpine) or `archive_command` silently fails — `chown 70:70` the volume/dir first (same gotcha seen in the compose WAL test).
> - `pg_basebackup -Xstream` was **flaky on a just-started cluster** (exited 0 but wrote nothing); a short settle + **`-Xfetch`** was reliable. Assert `PG_VERSION` exists after the backup — don't trust the exit code alone.
> - Build the restore `PGDATA` from the base, then append `restore_command` + `recovery_target_time` to `postgresql.auto.conf` and `touch recovery.signal` **before** first start; the official image detects the existing cluster (skips `initdb`) only if `PG_VERSION` is present.
> - `recovery_target_action = 'promote'` leaves the node writable immediately; confirm with `SELECT pg_is_in_recovery()` → `f`.

**Source:** blueprint §27 (`db-backup-verify`), §33 (DR). Scripts: `scripts/backup-postgres.sh`, `basebackup.sh`, `restore-verify.sh`, `restore-verify-local.sh`.
