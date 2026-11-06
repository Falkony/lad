#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$LAD_DB_PASSWORD" --set=db_name="$POSTGRES_DB" <<'SQL'
CREATE ROLE lad LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
ALTER SCHEMA public OWNER TO lad;
GRANT CONNECT, TEMP ON DATABASE :"db_name" TO lad;
SQL
