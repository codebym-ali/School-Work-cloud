#!/bin/sh
# Runs once, inside docker-entrypoint-initdb.d, AFTER 00-init.sql has created the roles.
#
# postgres-init.sql creates app_user / platform_admin with DEV LITERAL passwords ('app_pw',
# 'platform_pw') because it is shared with local dev, where those are fine and are in the repo.
# On a public box they are not fine. This replaces them with the generated values, read from the
# environment so no secret is ever written into a file under version control.
set -e
: "${APP_USER_PASSWORD:?APP_USER_PASSWORD not set}"
: "${PLATFORM_USER_PASSWORD:?PLATFORM_USER_PASSWORD not set}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
ALTER ROLE app_user       WITH PASSWORD '${APP_USER_PASSWORD}';
ALTER ROLE platform_admin WITH PASSWORD '${PLATFORM_USER_PASSWORD}';
SQL
echo "role passwords rotated off the dev literals"
