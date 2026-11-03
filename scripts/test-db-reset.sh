#!/usr/bin/env bash
# ============================================================================
# test-db-reset.sh — (re)crea la base de datos de TEST en UN solo comando:
#
#     npm run test:db:reset
#
# Qué hace (idempotente, sin docker):
#   1. Verifica que psql exista y que el Postgres local acepte conexiones
#      (falla ruidosamente si no).
#   2. Crea UNA vez el template `cocos_challenge_template` cargando
#      db/schema.sql + db/seed.sql (los archivos GENERADOS — no se editan a mano;
#      si el snapshot cambia: drop template y re-corré).
#   3. (Re)crea `cocos_challenge_test` con CREATE DATABASE ... TEMPLATE
#      (milisegundos — enfoque de docs/database.md §6).
#   4. Muestra los counts del seed como verificación.
#
# Postgres local de esta máquina: cluster userspace en localhost:5433, auth TRUST
# (la URL no lleva password). Si no está levantado:
#   /usr/lib/postgresql/18/bin/pg_ctl -D ~/.pg/cocos -o '-p 5433 -k /tmp' \
#     -l ~/.pg/cocos.log start
#
# Los targets docker del Makefile (db-up/db-reset) son para otros entornos;
# el comando de tests NO depende de docker.
# ============================================================================
set -euo pipefail

# Conexión al servidor (BD administrativa); overridable para otros entornos.
DB_ADMIN_URL="${DB_ADMIN_URL:-postgresql://postgres@localhost:5433/postgres}"
TEMPLATE_DB="cocos_challenge_template"
TEST_DB="cocos_challenge_test"
# URLs por BD: el path de una URL postgresql:// SE REEMPLAZA, no se concatena.
DB_SERVER_URL="${DB_ADMIN_URL%/*}"
TEMPLATE_URL="$DB_SERVER_URL/$TEMPLATE_DB"
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

# 1. Template UNA vez: crea, carga snapshot, y cierra conexiones para que
#    pueda usarse como TEMPLATE. Si la carga falla, se elimina para que un
#    retry no herede un template a medias.
if ! psql "$DB_ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = '$TEMPLATE_DB'" | grep -q 1; then
  echo "→ creando template $TEMPLATE_DB (una sola vez)…"
  psql "$DB_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $TEMPLATE_DB TEMPLATE template0"
  if ! psql "$TEMPLATE_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT_DIR/db/schema.sql"; then
    psql "$DB_ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $TEMPLATE_DB"
    echo "✗ Falló la carga de db/schema.sql en el template (rollback del template)." >&2
    exit 1
  fi
  if ! psql "$TEMPLATE_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT_DIR/db/seed.sql"; then
    psql "$DB_ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $TEMPLATE_DB"
    echo "✗ Falló la carga de db/seed.sql en el template (rollback del template)." >&2
    exit 1
  fi
  # Template de verdad: nadie debe conectarse (bloquearía CREATE ... TEMPLATE).
  psql "$DB_ADMIN_URL" -q -c "ALTER DATABASE $TEMPLATE_DB ALLOW_CONNECTIONS false"
  echo "✓ template $TEMPLATE_DB listo (schema + seed)"
else
  echo "✓ template $TEMPLATE_DB ya existe — reuse"
fi

# 2. (Re)crear la DB de test desde el template
psql "$DB_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $TEST_DB"
psql "$DB_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $TEST_DB TEMPLATE $TEMPLATE_DB"
echo "✓ $TEST_DB recreada desde el template"

# 3. Verificación: counts del seed (users=4, instruments=66, orders=11, marketdata=126)
echo "→ counts en $TEST_DB:"
for table in users instruments orders marketdata; do
  count="$(psql "$TEST_URL" -tAc "SELECT count(*) FROM $table")"
  printf '   %-12s %s\n' "$table" "$count"
done
echo "✓ listo — .env.test ya apunta acá: DATABASE_URL=$TEST_URL"
