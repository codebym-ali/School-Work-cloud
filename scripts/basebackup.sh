#!/usr/bin/env bash
#
# Physical BASE backup for point-in-time recovery (blueprint §33, §29 RPO ≤30m). Streams
# pg_basebackup (tar, gzip) → Cloudflare R2. PITR = this base + the archived WAL (Postgres
# archive_command; see docker-compose.prod.yml). Take one daily; WAL fills the gaps to
# ≤5-min granularity (archive_timeout=300). This is DISTINCT from the nightly logical
# pg_dump (backup-postgres.sh): the dump is for a simple full restore; base+WAL is for PITR.
#
# ── Restore to a point in time (runbook) ────────────────────────────────────────────────
#   1. Stop Postgres; move aside / wipe PGDATA.
#   2. Download + extract this base into PGDATA (tar -xzf).
#   3. touch PGDATA/recovery.signal ; in postgresql.conf set:
#        restore_command = 'aws s3 cp s3://$R2_BUCKET/wal/%f %p --endpoint-url $R2_ENDPOINT'
#        recovery_target_time = '2026-07-11 09:00:00+05'   # the moment to recover to
#   4. Start Postgres — it replays archived WAL up to the target, then promotes.
#
# Required env: PGBASE_CONNINFO (a replication-capable conninfo),
#               R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
# Requires: pg_basebackup (v16), aws-cli v2.
set -euo pipefail

: "${PGBASE_CONNINFO:?set PGBASE_CONNINFO (replication-capable)}"
: "${R2_ENDPOINT:?set R2_ENDPOINT}"
: "${R2_BUCKET:?set R2_BUCKET}"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY}"

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
KEY="basebackups/base-${STAMP}.tar.gz"

echo "[$(date -u)] pg_basebackup (tar, gzip) → s3://${R2_BUCKET}/${KEY}"
# -X fetch bundles the WAL needed to make the base internally consistent; -D - streams to stdout.
pg_basebackup --dbname="$PGBASE_CONNINFO" --format=tar --wal-method=fetch --gzip --pgdata=- \
  | aws s3 cp - "s3://${R2_BUCKET}/${KEY}" --endpoint-url "$R2_ENDPOINT" --only-show-errors

echo "[$(date -u)] base backup complete: ${KEY}"
