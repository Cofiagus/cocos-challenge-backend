#!/usr/bin/env bash
# Reset one isolated integration-test database from migrations + challenge seed.
# TEST_DATABASE_URL is loaded from .env.test or the process environment.
# DATABASE_URL is the application target and is never used for test writes.
set -euo pipefail

TEST_DB="${TEST_DB_NAME:-cocos_challenge_test}"
if [[ ! "$TEST_DB" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
  echo "✗ TEST_DB_NAME inválido; usar sólo minúsculas, números y guion bajo." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "✗ psql no está en PATH — instalá el cliente de PostgreSQL." >&2
  exit 1
fi

# Load both env files, derive URLs without logging either, and refuse to reset
# the exact database configured for the application.
URLS="$(TEST_DB_NAME="$TEST_DB" node --input-type=module <<'NODE'
import { config, parse } from "dotenv";
import { readFileSync } from "node:fs";
config({ path: ".env.test" });

const testConnectionString = process.env.TEST_DATABASE_URL;
if (!testConnectionString) {
  process.stderr.write("TEST_DATABASE_URL no definida; configurá .env.test.\n");
  process.exit(2);
}
const target = new URL(testConnectionString);
if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
  process.stderr.write("TEST_DATABASE_URL debe usar el protocolo PostgreSQL.\n");
  process.exit(2);
}
const targetDatabaseName = process.env.TEST_DB_NAME;
let applicationConnectionString = process.env.APP_DATABASE_URL;
if (!applicationConnectionString) {
  try {
    applicationConnectionString = parse(readFileSync(".env", "utf8")).DATABASE_URL;
  } catch {
    applicationConnectionString = undefined;
  }
}
if (applicationConnectionString) {
  const app = new URL(applicationConnectionString);
  const sameDatabase = app.protocol === target.protocol &&
    app.hostname === target.hostname &&
    (app.port || "5432") === (target.port || "5432") &&
    app.pathname === `/${targetDatabaseName}`;
  if (sameDatabase) {
    process.stderr.write("El destino de reset coincide con DATABASE_URL; operación cancelada.\n");
    process.exit(3);
  }
}
const admin = new URL(target);
admin.pathname = "/postgres";
target.pathname = `/${targetDatabaseName}`;
process.stdout.write(`${admin.toString()}\n${target.toString()}\n`);
NODE
)"
mapfile -t RESOLVED_URLS <<< "$URLS"
if [[ "${#RESOLVED_URLS[@]}" -ne 2 ]]; then
  echo "✗ No se pudo resolver la configuración de test." >&2
  exit 1
fi
DB_ADMIN_URL="${RESOLVED_URLS[0]}"
TEST_URL="${RESOLVED_URLS[1]}"

if ! psql "$DB_ADMIN_URL" -tAc "SELECT 1" >/dev/null 2>&1; then
  echo "✗ No puedo conectar al servidor configurado en TEST_DATABASE_URL." >&2
  exit 1
fi

psql "$DB_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $TEST_DB"
psql "$DB_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $TEST_DB TEMPLATE template0"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
( cd "$ROOT_DIR" && DATABASE_URL="$TEST_URL" npx prisma migrate deploy )
psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT_DIR/db/seed.sql"

declare -A EXPECTED=(
  [users]=4 [instruments]=66 [orders]=11 [marketdata]=126
)
for table in users instruments orders marketdata; do
  count="$(psql "$TEST_URL" -tAc "SELECT count(*) FROM $table")"
  if [[ "$count" != "${EXPECTED[$table]}" ]]; then
    echo "✗ count inesperado en $table (esperado ${EXPECTED[$table]})." >&2
    exit 1
  fi
done

missing_columns="$(psql "$TEST_URL" -tAc "
  SELECT count(*) FROM information_schema.columns
  WHERE table_name = 'orders'
    AND column_name IN ('timeInForce', 'filledPrice', 'filledAt', 'idempotencyKey')")"
if [[ "$missing_columns" != "4" ]]; then
  echo "✗ faltan columnas migradas de orders (halladas $missing_columns/4)." >&2
  exit 1
fi
if ! psql "$TEST_URL" -tAc "SELECT to_regclass('public.order_events')" | grep -q order_events; then
  echo "✗ falta la tabla order_events." >&2
  exit 1
fi
printf '✓ base aislada de test %s recreada, migrada y cargada con el seed.\n' "$TEST_DB"
