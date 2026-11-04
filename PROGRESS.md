# PROGRESS.md — bitácora del orquestador

Solo el orquestador escribe este archivo. Fuente de verdad del avance: fases, gates,
estado por célula, QUESTIONs abiertas y limitaciones acumuladas para el README.

## Estado actual

- **FASE 0** (Célula 0 — entorno): **DONE — merge `b590dfb`, GATE 0 verificado por el orquestador** (typecheck/lint/test verde, `test:db:reset` idempotente, Prisma CLI 7.10.1 = client 7.10.1).
- **FASE 1** (Célula 0 — contratos): reporte DONE (branch `fase-1-contratos`, 5 commits, GATE 1 verde re-corrido por el orquestador: validate + typecheck + lint + test 4/4 + reset con columnas nuevas). **Revisión de contratos del orquestador: 1 gap → corrección delegada** (en curso): faltaba canal de transacción en los ports para expresar DECISIONS.md (tx única + lock por usuario + auditoría en la misma tx). Mecanismo decidido: `TransactionContext` opaco + `withUserTransaction` en `OrderRepository` + `tx?` en `PortfolioReadRepository`. Merge pendiente de esa corrección.
- FASE 2–5: pendientes (FASE 2 se lanza tras el merge de FASE 1 corregida).

### Interpretaciones DECISIONS fijadas en contrato por la Célula 0 (aceptadas por el orquestador)

- MARKET con `price` en el body => 400 (no crea orden).
- IOC/FOK sin precio de referencia => REJECTED persistida con `NO_PRICE`; GTC LIMIT sin precio => NEW (resting no necesita ref para nada); MARKET sin precio => REJECTED `NO_PRICE`.
- Búsqueda responde array plano (sin wrapper). Query vacía o ausente => 400.
- `timeInForce` NOT NULL DEFAULT 'GTC' en DB (toda orden conoce su TIF; seed queda en GTC; TIF se ignora para MARKET).
- `datetime`/`filledAt` serializan ISO 8601 **sin offset** (timestamp sin tz, hora local del mercado).
- Nombres estables de error codes: VALIDATION_ERROR, INSTRUMENT_NOT_OPERABLE, USER_NOT_FOUND, ORDER_NOT_FOUND, IDEMPOTENCY_CONFLICT, ORDER_NOT_CANCELLABLE.

### Notas de FASE 1 para las células de FASE 2

- `@prisma/adapter-pg` (driver adapter, EXIGIDO por Prisma 7 para instanciar el cliente): **aprobado por el orquestador** para la Célula B — es parte del stack Prisma ya elegido por el repo, no una decisión nueva de diseño.
- jest-resolve NO mapea `.js`→`.ts`: ANTES de lanzar FASE 2 el orquestador agrega `moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" }` a `jest.config.js` (ruta del orquestador — las células no pueden tocar jest.config.js).
- Generador Prisma: `prisma-client-js` (emite `.js`+`.d.ts` a `node_modules/.prisma/client` — compatible con tsc nodenext + jest CJS + eslint sin tocar configs). El nuevo `prisma-client` solo emite `.ts` y rompería el lint.

### Decisiones aceptadas por el orquestador en FASE 0 (reportadas por la célula)

1. **TypeScript ^7.0.2 → ^5.9.3**: TS7 (compilador nativo) removió la API JS de `require('typescript')`; ts-jest y typescript-eslint dependen de ella. 5.9.3 es la única línea que satisface ambos peers pedidos por el plan. Reversible con bump de devDep.
2. **@types/pg@^8.23.1** (types-only): pg no bundlea tipos y el humo de DB usa pg bajo strict/no-any.
3. **npm allowScripts** aprobado para prisma + @prisma/engines (sin postinstall de ellos el CLI 7.x no baja binarios). esbuild y @parcel/watcher SIGUEN bloqueados → **limitación conocida**: `npm run dev` (tsx watch) puede fallar en FASE 3; los gates del plan no lo incluyen.

### Notas técnicas heredadas (de FASE 0, para las células siguientes)

- App ESM (`type: module`, tsconfig nodenext); tests compilados a CJS por ts-jest (`tsconfig.test.json`).
- `import { Decimal } from 'decimal.js'` (named) bajo nodenext — el default export del d.ts no tiene construct signature.
- Prisma 7 no autocarga `.env`: la URL del datasource se resuelve vía `prisma.config.ts` (`defineConfig` de `prisma/config`).
- `npm run build` compila también `tests/` (no hay rootDir): si FASE 3 quiere dist limpio, hace falta `tsconfig.build.json`.

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
| 0 — entorno | 0 | **DONE (merge `b590dfb`)** | GATE 0 ✓ |
| 0 — contratos | 1 | EN CURSO | pendiente |
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
