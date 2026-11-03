# PROGRESS.md — bitácora del orquestador

Solo el orquestador escribe este archivo. Fuente de verdad del avance: fases, gates,
estado por célula, QUESTIONs abiertas y limitaciones acumuladas para el README.

## Estado actual

- **FASE 0** (Célula 0 — entorno): EN CURSO.
- FASE 1–5: pendientes.

## Entorno (verificado 2026-11-03 por el orquestador)

- Repo: `/home/cofi/repos/cocos-challenge-backend`, branch `main` @ `41af211`.
- Node v26.12.1, npm 12.0.2. **Sin docker** en esta máquina.
- PostgreSQL 18 como cluster userspace: `~/.pg/cocos`, puerto 5433, user `postgres`,
  auth trust (`.env` ya apunta ahí). Socket dir: `/tmp` (arranque:
  `/usr/lib/postgresql/18/bin/pg_ctl -D ~/.pg/cocos -o "-p 5433 -k /tmp" -l ~/.pg/cocos.log start`).
- DB dev `cocos_challenge` con snapshot `db/schema.sql` + `db/seed.sql` cargado y verificado:
  users=4, instruments=66, orders=11, marketdata=126.
- Referencia user 1 (calculada contra el seed, no de memoria):
  cashSettled=753.000,00 · cashReserved=125.500,00 · **cashDisponible=627.500,00**
  PAMP qty 40 (close 925,85 · 14-jul) · METR qty 500 (close 229,50) · BMA qty −10 (close 1.502,80)
  Sin marketdata (→ NO_PRICE): PGR, IRCP. ARS (id 66, MONEDA): no operable.
- `package.json` de partida con deuda conocida: prisma@8-rc (CLI de Platform, no ORM) vs
  @prisma/client@7.10.1 · postinstall ajeno (`prisma skills sync`) · `prisma:seed` apunta a
  `prisma/seed.ts` inexistente · `type: commonjs` vs ESM mandatorio en AGENTS.md.

## Células

| Célula | Fase | Estado | Gate |
|---|---|---|---|
| 0 — entorno | 0 | EN CURSO | pendiente |
| A — dominio puro | 2 | no lanzada | — |
| B — persistencia e infra | 2 | no lanzada | — |
| C — endpoints de lectura | 2 | no lanzada | — |
| D — tests funcionales UC-3 (rojos) | 2 | no lanzada | — |
| E — integración UC-3 | 3 | no lanzada | — |
| F — cancelar orden | 4 | no lanzada | — |
| G — transferencias | 4 | no lanzada | — |
| H — docs y entrega | 5 | no lanzada | — |

## QUESTIONs abiertas

(ninguna)

## Limitaciones acumuladas (input del README de FASE 5)

- Alcance cerrado por DECISIONS.md: sin Yahoo, sin price_ticks/ingesta, sin DAY/EXPIRED,
  sin sweep, sin matching continuo, sin fills parciales, sin prioridad precio-tiempo
  → van a "Evolución propuesta" del README, no al código.
- Posición negativa del seed (BMA −10) se lista tal cual: inconsistencia del dataset,
  documentada, no "corregida" por el código.
- Sin docker en la máquina de desarrollo: DB local = cluster userspace PG 18 en 5433;
  `docker-compose.yml` queda como referencia para otros entornos.
