#!/usr/bin/env bash
#
# Weekly restore-verify (blueprint §27 db-backup-verify, §33): download the latest
# backup, restore it into a throwaway scratch database, run a smoke query, then drop
# it. A backup you have never restored is not a backup. Page on failure.
#
# Required env:
#   RESTORE_ADMIN_URL   postgres URL to a superuser DB (e.g. .../postgres) used to
#                       CREATE/DROP the scratch database
#   R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
# Optional:
#   SCRATCH_DB (default school_restore_check)
#
# Requires: pg_restore, psql, aws-cli v2.
set -euo pipefail

: "${RESTORE_ADMIN_URL:?set RESTORE_ADMIN_URL}"
: "${R2_ENDPOINT:?set R2_ENDPOINT}"
: "${R2_BUCKET:?set R2_BUCKET}"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY}"
SCRATCH_DB="${SCRATCH_DB:-school_restore_check}"

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"

KEY="$(aws s3 cp "s3://${R2_BUCKET}/backups/latest.txt" - --endpoint-url "$R2_ENDPOINT")"
FILE="/tmp/restore-check.dump"
echo "[$(date -u)] downloading s3://${R2_BUCKET}/${KEY}"
aws s3 cp "s3://${R2_BUCKET}/${KEY}" "$FILE" --endpoint-url "$R2_ENDPOINT" --only-show-errors

# Base URL without the trailing /dbname, so we can target the scratch DB.
BASE_URL="${RESTORE_ADMIN_URL%/*}"
cleanup() { psql "$RESTORE_ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${SCRATCH_DB};" >/dev/null 2>&1 || true; rm -f "$FILE"; }
trap cleanup EXIT

echo "[$(date -u)] restoring into ${SCRATCH_DB}"
psql "$RESTORE_ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${SCRATCH_DB};"
psql "$RESTORE_ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${SCRATCH_DB};"
pg_restore --no-owner --no-privileges --dbname="${BASE_URL}/${SCRATCH_DB}" "$FILE"

COUNT="$(psql "${BASE_URL}/${SCRATCH_DB}" -tAc "SELECT count(*) FROM schools;")"
echo "[$(date -u)] smoke check: schools=${COUNT}"
[ "$COUNT" -ge 0 ] && echo "[$(date -u)] restore-verify PASSED" || { echo "restore-verify FAILED"; exit 1; }
