# Targets de base de datos. Ver docs/database.md §6.
#
#   make db-up        levanta Postgres local (docker, puerto 5433)
#   make db-load      crea schema + carga seed
#   make db-reset     drop + load (vuelve al estado del seed)
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
	@test -f db/schema.sql || (echo "✗ falta db/schema.sql — corré 'make db-snapshot'"; exit 1)
	psql "$(LOCAL_URL)" -v ON_ERROR_STOP=1 -q -f db/schema.sql
	@if [ -f db/seed.sql ]; then psql "$(LOCAL_URL)" -v ON_ERROR_STOP=1 -q -f db/seed.sql; fi
	@echo "✓ schema + seed cargados en $(LOCAL_URL)"

db-reset:
	psql "$(LOCAL_URL)" -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
	@$(MAKE) --no-print-directory db-load

db-snapshot:
	@test -n "$(REMOTE_URL)" || (echo "✗ exportá NEON_DATABASE_URL antes de snapshotear"; exit 1)
	DATABASE_URL="$(REMOTE_URL)" $(PYTHON) scripts/db-snapshot.py

psql:
	psql "$(LOCAL_URL)"

prices:
	psql "$(LOCAL_URL)" -v userid=1 -f db/queries/portfolio.sql
