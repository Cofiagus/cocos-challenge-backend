# Targets de base de datos. Ver docs/database.md §6.
#
#   make db-up        levanta Postgres local (docker, puerto 5433)
#   make db-load      crea schema + carga seed — snapshot LEGACY: exige LEGACY=1
#   make db-reset     drop + load — snapshot LEGACY: exige LEGACY=1
#   make db-snapshot  re-baja schema+datos desde la base real
#   make psql         psql contra la base local
#   make prices       prueba la query de portfolio (user 1)

LOCAL_URL ?= postgresql://postgres:postgres@localhost:5433/cocos_challenge
REMOTE_URL ?= $(NEON_DATABASE_URL)
PYTHON ?= python3

.PHONY: help db-up db-down db-wait db-load db-reset db-snapshot psql prices

help:
	@grep -E '^[a-z-]+:' $(MAKEFILE_LIST) | sed 's/:.*//' | column -c 80

db-up:
	docker compose up -d db
	@$(MAKE) --no-print-directory db-wait

db-down:
	docker compose down

db-wait:
	@echo "→ esperando a que Postgres acepte conexiones…"
	@for i in $$(seq 1 40); do \
		docker compose exec -T db pg_isready -U postgres -d cocos_challenge >/dev/null 2>&1 && exit 0; \
		sleep 1; \
	done; echo "✗ Postgres no levantó"; exit 1

db-load:
	@if [ "$(LEGACY)" != "1" ]; then \
	  echo "✗ db-load cargaría db/schema.sql: el snapshot LEGACY de la base real (sin timeInForce/filledPrice/filledAt/idempotencyKey ni order_events)." >&2; \
	  echo "  El flujo vigente para crear una DB es 'npx prisma migrate deploy' + 'psql -f db/seed.sql' (ver README y docs/database.md; 'npm run test:db:reset' lo ejecuta para la DB de test)." >&2; \
	  echo "  Para cargar el snapshot de todas formas: make db-load LEGACY=1" >&2; \
	  exit 1; \
	fi
	@test -f db/schema.sql || (echo "✗ falta db/schema.sql — corré 'make db-snapshot'"; exit 1)
	psql "$(LOCAL_URL)" -v ON_ERROR_STOP=1 -q -f db/schema.sql
	@if [ -f db/seed.sql ]; then psql "$(LOCAL_URL)" -v ON_ERROR_STOP=1 -q -f db/seed.sql; fi
	@echo "✓ schema + seed cargados en $(LOCAL_URL)"

db-reset:
	@if [ "$(LEGACY)" != "1" ]; then \
	  echo "✗ db-reset dropearía el schema de $(LOCAL_URL) y después cargaría db/schema.sql: el snapshot LEGACY de la base real (sin timeInForce/filledPrice/filledAt/idempotencyKey ni order_events). No se dropeó nada." >&2; \
	  echo "  El flujo vigente para crear una DB es 'npx prisma migrate deploy' + 'psql -f db/seed.sql' (ver README y docs/database.md); para la DB de test usá 'npm run test:db:reset'." >&2; \
	  echo "  Para dropear y cargar el snapshot de todas formas: make db-reset LEGACY=1" >&2; \
	  exit 1; \
	fi
	psql "$(LOCAL_URL)" -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
	@$(MAKE) --no-print-directory db-load LEGACY=1

db-snapshot:
	@test -n "$(REMOTE_URL)" || (echo "✗ exportá NEON_DATABASE_URL antes de snapshotear"; exit 1)
	DATABASE_URL="$(REMOTE_URL)" $(PYTHON) scripts/db-snapshot.py

psql:
	psql "$(LOCAL_URL)"

prices:
	psql "$(LOCAL_URL)" -v userid=1 -f db/queries/portfolio.sql
