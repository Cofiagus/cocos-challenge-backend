#!/usr/bin/env bash
# ============================================================================
# test-db-reset.sh — (re)crea la base de datos de TEST en UN solo comando:
#
#     npm run test:db:reset
#
# La test DB ya NO sale de un template cargado con db/schema.sql (ese
# snapshot NO tiene las columnas nuevas). Ahora sale del SCHEMA MIGRADO
# (prisma/migrations/**) + db/seed.sql, igual que la dev DB:
#
#   1. Verifica psql + que el Postgres local acepte conexiones (falla ruidoso).
#   2. (Re)crea `cocos_challenge_test` VACÍA (drop/create; template0 para no
#      heredar propiedades de la admin).
#   3. Aplica las migraciones versionadas: `npx prisma migrate deploy` con
#      DATABASE_URL apuntando a la test DB (prisma.config.ts NO pisa variables
#      ya presentes en el proceso).
#   4. Carga db/seed.sql SIN ediciones (los archivos GENERADOS no se tocan;
#      el seed trae TRUNCATE + COPY + setval, todo compatible con el schema
#      migrado: enums con exactamente sus valores).
#   5. Verifica counts del seed + columnas nuevas y falla si algo no cierra.
#
# Idempotente: correrlo de nuevo = drop/create/migrate/seed otra vez.
# Sin docker: usa el cluster userspace de localhost:5433 (auth TRUST).
#
# El enfoque de template precargado (`cocos_challenge_template`) quedó obsoleto:
# si existe de una corrida vieja, se borra acá.
#
# Postgres local de esta máquina: cluster userspace en localhost:5433 (auth TRUST,
# el password se ignora) o docker-compose.yml (postgres:postgres). Si no está levantado:
#   /usr/lib/postgresql/18/bin/pg_ctl -D ~/.pg/cocos -o '-p 5433 -k /tmp' \
#     -l ~/.pg/cocos.log start
#
# Los targets docker del Makefile (db-up/db-reset) son para otros entornos;
# el comando de tests NO depende de docker.
# ============================================================================
set -euo pipefail

# Conexión al servidor (BD administrativa); overridable para otros entornos.
DB_ADMIN_URL="${DB_ADMIN_URL:-postgresql://postgres:postgres@localhost:5433/postgres}"
# Nombre de la test DB overridable (p. ej. TEST_DB_NAME=cocos_challenge_ftest
# para aislar suites que corren en paralelo contra el mismo cluster).
TEST_DB="${TEST_DB_NAME:-cocos_challenge_test}"
LEGACY_TEMPLATE_DB="cocos_challenge_template"
# URLs por BD: el path de una URL postgresql:// SE REEMPLAZA, no se concatena.
DB_SERVER_URL="${DB_ADMIN_URL%/*}"
TEST_URL="$DB_SERVER_URL/$TEST_DB"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Guard: psql disponible
if ! command -v psql >/dev/null 2>&1; then
  echo "✗ psql no está en PATH — instalá el cliente de PostgreSQL." >&2
  exit 1
fi

# Guard: Postgres local arriba
if ! psql "$DB_ADMIN_URL" -tAc "SELECT 1" >/dev/null 2>&1; then
  echo "✗ No puedo conectar a $DB_ADMIN_URL" >&2
  echo "  ¿Está levantado el Postgres local (puerto 5433)? Arrancalo con:" >&2
  echo "  /usr/lib/postgresql/18/bin/pg_ctl -D ~/.pg/cocos -o '-p 5433 -k /tmp' -l ~/.pg/cocos.log start" >&2
  exit 1
fi

# Limpieza del enfoque de template precargado (cargado desde db/schema.sql, sin
# columnas nuevas): ya no aplica.
if psql "$DB_ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = '$LEGACY_TEMPLATE_DB'" | grep -q 1; then
  echo "→ borrando template obsoleto $LEGACY_TEMPLATE_DB (enfoque anterior con template)…"
  psql "$DB_ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $LEGACY_TEMPLATE_DB"
fi

# 1. (Re)crear la DB de test VACÍA
psql "$DB_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $TEST_DB"
psql "$DB_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $TEST_DB TEMPLATE template0"
echo "✓ $TEST_DB recreada (vacía)"

# 2. Schema MIGRADO: prisma migrate deploy contra la test DB.
#    DATABASE_URL exportado GANA sobre el .env que carga prisma.config.ts
#    (dotenv no pisa variables ya presentes).
( cd "$ROOT_DIR" && DATABASE_URL="$TEST_URL" npx prisma migrate deploy )
echo "✓ migraciones aplicadas sobre $TEST_DB"

# 3. Seed SIN ediciones (db/seed.sql es generado; ver header del archivo)
psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT_DIR/db/seed.sql"
echo "✓ db/seed.sql cargado"

# 4. Verificación: counts del seed (users=4, instruments=66, orders=11,
#    marketdata=126) y columnas nuevas de orders presentes.
echo "→ counts en $TEST_DB:"
declare -A EXPECTED=(
  [users]=4 [instruments]=66 [orders]=11 [marketdata]=126
)
for table in users instruments orders marketdata; do
  count="$(psql "$TEST_URL" -tAc "SELECT count(*) FROM $table")"
  printf '   %-12s %s\n' "$table" "$count"
  if [ "$count" != "${EXPECTED[$table]}" ]; then
    echo "✗ count de $table = $count, esperado ${EXPECTED[$table]}" >&2
    exit 1
  fi
done

missing_columns="$(psql "$TEST_URL" -tAc "
  SELECT count(*) FROM information_schema.columns
  WHERE table_name = 'orders'
    AND column_name IN ('timeInForce', 'filledPrice', 'filledAt', 'idempotencyKey')")"
if [ "$missing_columns" != "4" ]; then
  echo "✗ faltan columnas nuevas de orders (halladas $missing_columns/4)" >&2
  exit 1
fi
if ! psql "$TEST_URL" -tAc "SELECT to_regclass('public.order_events')" | grep -q order_events; then
  echo "✗ falta la tabla order_events" >&2
  exit 1
fi
echo "✓ columnas nuevas presentes (timeInForce, filledPrice, filledAt, idempotencyKey) + order_events"
if [ "$TEST_DB" = "cocos_challenge_test" ]; then
  echo "✓ listo — .env.test ya apunta acá: DATABASE_URL=$TEST_URL"
else
  echo "✓ listo (TEST_DB_NAME=$TEST_DB; .env.test NO apunta acá — pasar la URL explícita a la suite)"
fi