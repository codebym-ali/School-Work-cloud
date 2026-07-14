#!/bin/sh
#
# Postgres archive_command — durably ship one WAL segment off-box so point-in-time
# recovery survives host loss (blueprint §29 RPO ≤5m, §33 DR; see DR Runbook Runbook B).
# Postgres invokes this as:  archive-wal.sh %p %f   (%p = path to the segment, %f = name).
#
# Contract that makes it SAFE: return non-zero on ANY failure. Postgres treats a non-zero
# archive_command as "not archived", retries, and does NOT recycle the segment — so WAL is
# never dropped before it is durably in R2 (back-pressure fills pg_wal instead of losing data;
# monitor pg_stat_archiver.failed_count / disk).
#
# Two copies, most-durable last:
#   1. WAL_LOCAL_DIR  — a fast on-box copy for local PITR (idempotent; optional).
#   2. R2 (when WAL_R2_ENABLED=true) — the host-loss-safe copy, via rclone's env-configured
#      remote `r2` (RCLONE_CONFIG_R2_*). Success here is what gates the exit code.
#
# Ships in the custom postgres image (docker/postgres/Dockerfile). Off by default so the
# prod compose still runs locally without R2 creds (local-only archiving, as before).
set -eu

SRC="$1"   # %p
NAME="$2"  # %f

# 1) On-box copy for fast local restore (idempotent — never overwrite a done segment).
if [ -n "${WAL_LOCAL_DIR:-}" ]; then
  if [ ! -f "$WAL_LOCAL_DIR/$NAME" ]; then
    cp "$SRC" "$WAL_LOCAL_DIR/$NAME.tmp"
    mv "$WAL_LOCAL_DIR/$NAME.tmp" "$WAL_LOCAL_DIR/$NAME"   # atomic publish
  fi
fi

# 2) Durable off-box copy to R2 — the exit code of the whole script hinges on this.
if [ "${WAL_R2_ENABLED:-false}" = "true" ]; then
  : "${R2_BUCKET:?WAL_R2_ENABLED=true requires R2_BUCKET}"
  # rclone reads the remote from RCLONE_CONFIG_R2_* env vars; no config file needed.
  rclone --config /dev/null -q --retries 5 --low-level-retries 10 \
    copyto "$SRC" "r2:$R2_BUCKET/wal/$NAME"
fi
