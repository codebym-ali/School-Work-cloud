# Postgres 16 + rclone, for durable WAL archiving to R2 (blueprint §33; see DR Runbook).
# Thin layer over the official image: adds rclone (single static binary, S3/R2 via env)
# and the archive_command wrapper. Build context is the repo root so it can COPY scripts/.
#
#   docker build -f docker/postgres/Dockerfile -t school-postgres .
FROM postgres:16-alpine
RUN apk add --no-cache rclone
COPY scripts/archive-wal.sh /usr/local/bin/archive-wal.sh
RUN chmod +x /usr/local/bin/archive-wal.sh
# Own the WAL archive dir as postgres (uid 70) so a fresh named volume mounted here
# inherits that ownership — otherwise archive_command's write fails "Permission denied"
# (the archive-dir uid gotcha). Docker seeds an empty volume from the image dir + perms.
RUN mkdir -p /wal-archive && chown postgres:postgres /wal-archive
VOLUME /wal-archive
