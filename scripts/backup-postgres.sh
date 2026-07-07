#!/usr/bin/env bash
#
# Nightly Postgres backup → Cloudflare R2 (blueprint §33; our stack replaces RDS PITR).
# Self-hosted Postgres means backups are ours to own. Run via a Coolify scheduled task
# (or cron) once a day. Pair with WAL archiving for point-in-time recovery.
#
# Required env:
#   BACKUP_DATABASE_URL   postgres URL to dump (a read-capable superuser/owner role)
#   R2_ENDPOINT           https://<accountid>.r2.cloudflarestorage.com
#   R2_BUCKET             e.g. school-backups
#   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
# Optional:
#   BACKUP_RETENTION_DAYS (default 30 — enforce via an R2 lifecycle rule too)
#
# Requires: pg_dump (v16), aws-cli v2.
set -euo pipefail

: "${BACKUP_DATABASE_URL:?set BACKUP_DATABASE_URL}"
: "${R2_ENDPOINT:?set R2_ENDPOINT}"
: "${R2_BUCKET:?set R2_BUCKET}"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DAY="$(date -u +%Y/%m/%d)"
FILE="/tmp/school-${STAMP}.dump"
KEY="backups/${DAY}/school-${STAMP}.dump"

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"

echo "[$(date -u)] pg_dump (custom format, compressed) → ${FILE}"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --dbname="$BACKUP_DATABASE_URL" --file="$FILE"

SIZE="$(du -h "$FILE" | cut -f1)"
echo "[$(date -u)] uploading ${SIZE} → s3://${R2_BUCKET}/${KEY}"
aws s3 cp "$FILE" "s3://${R2_BUCKET}/${KEY}" --endpoint-url "$R2_ENDPOINT" --only-show-errors

# A small pointer to the latest backup for the restore-verify job.
echo "$KEY" > /tmp/latest.txt
aws s3 cp /tmp/latest.txt "s3://${R2_BUCKET}/backups/latest.txt" --endpoint-url "$R2_ENDPOINT" --only-show-errors

rm -f "$FILE" /tmp/latest.txt
echo "[$(date -u)] backup complete: ${KEY}"
