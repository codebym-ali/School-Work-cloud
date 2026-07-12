#!/usr/bin/env bash
#
# Local restore-verify (no R2 / cloud). Dumps the running Postgres, restores it into a
# throwaway scratch database, and asserts key-table row counts match the source.
# "A backup you have never restored is not a backup." Mirrors restore-verify.sh (the
# prod R2 path) but runs entirely against the local docker Postgres — good for dev + CI.
#
#   scripts/restore-verify-local.sh
#
# Env overrides: PG_CONTAINER (school-postgres), DB (school), SCRATCH (restore_check),
#                TABLES (space-separated list to compare).
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-school-postgres}"
DB="${DB:-school}"
SCRATCH="${SCRATCH:-restore_check}"
TABLES="${TABLES:-schools users students fee_invoices fee_payments student_enrollments audit_logs platform_users}"

x() { docker exec "$PG_CONTAINER" "$@"; }
xsh() { docker exec "$PG_CONTAINER" sh -c "$1"; }
count() { x psql -U postgres -d "$1" -tAc "select count(*) from $2" | tr -d '\r'; }

cleanup() { x psql -U postgres -c "DROP DATABASE IF EXISTS $SCRATCH;" >/dev/null 2>&1 || true; xsh "rm -f /tmp/rv.dump" || true; }
trap cleanup EXIT

echo "[restore-verify-local] pg_dump '$DB' (custom format)"
xsh "pg_dump -U postgres -Fc --no-owner --no-privileges $DB -f /tmp/rv.dump"

echo "[restore-verify-local] restore into scratch DB '$SCRATCH'"
x psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $SCRATCH;" -c "CREATE DATABASE $SCRATCH;" >/dev/null
# --no-owner: role grants aren't in the dump; warnings there are expected, so don't -e on it.
xsh "pg_restore -U postgres --no-owner --no-privileges -d $SCRATCH /tmp/rv.dump" || true

echo "[restore-verify-local] comparing row counts:"
fail=0
for t in $TABLES; do
  a="$(count "$DB" "$t")"
  b="$(count "$SCRATCH" "$t")"
  if [ "$a" = "$b" ]; then
    printf "  %-24s %s (match)\n" "$t" "$a"
  else
    printf "  %-24s live=%s restored=%s  MISMATCH\n" "$t" "$a" "$b"
    fail=1
  fi
done

if [ "$fail" = 0 ]; then
  echo "[restore-verify-local] PASSED — the backup restores faithfully"
else
  echo "[restore-verify-local] FAILED — restored data does not match" >&2
  exit 1
fi
