# Verificación de grandes montos — evidencia de ejecución

Este documento es la **única evidencia de ejecución** de la spec
[`specs/datos-financieros-grandes-montos.md`](../../specs/datos-financieros-grandes-montos.md)
(D1–D5). Registra qué se verificó, cómo reproducirlo y qué **no** se verificó. Las reglas
viven en sus documentos dueños (`README.md`, `docs/api.md`, `docs/database.md`); acá sólo
hay evidencia, no reglas nuevas.

## Qué se verificó

> ⚠️ **Corte histórico.** Esta verificación se hizo sobre la candidata `1bd02e4`, previa al
> merge. **No describe el árbol actual.** El estado vigente lo publica `README.md` §Estado del
> build (`58 suites / 751 tests`), que es la única fuente de conteos. Lo que sigue conserva valor
> como evidencia de **qué** se verificó y **cómo**, no de cuántos tests hay hoy.

- **Núcleo probado:** `1bd02e4` (merge de cierre de la acceptación de grandes montos). La
  corrida del gate se hizo en el worktree de esa revisión.
- **Resultado:** `37` suites / `515` tests, **0 fallidos, 0 open handles** (Jest
  `--runInBand --detectOpenHandles --json`). Antes de la suite: `npm run typecheck`,
  `npm run lint`, `npm run build` y `npm run openapi` sin diff, y el reset de la base de
  test default desde las **2 migraciones versionadas en aquel momento** (`init_trading_api`,
  `large_money`) + `db/seed.sql` **sin editar**. Hoy el head tiene **4** migraciones.
- La evidencia corresponde a la rama candidata previa a la integración en `main`; el estado
  real de integración (qué SHA está mergeado) lo registran `git log` y `PROGRESS.md`, no
  este documento.

## Comandos reproducibles

Los gates de generación corren **antes** del reset y de la suite; el repo no fija proveedor,
host ni credenciales, y este documento no los registra. Nunca apuntar el reset a la base de
la app: la `TEST_DATABASE_URL` es una URL dedicada del servidor PostgreSQL local de ensayo,
y las suites derivan de ella sus propias DBs aisladas.

```bash
npx prisma generate                                     # cliente Prisma; no conecta ni aplica migraciones
npm run typecheck && npm run lint && npm run build && npm run openapi
git status --porcelain                                  # vacío: sin diff en openapi.json ni en el árbol
TEST_DB_NAME=cocos_challenge_test npm run test:db:reset # 2 migraciones + seed en la DB de ensayo
DOTENV_CONFIG_QUIET=true npx jest --runInBand --detectOpenHandles
```

- `npx prisma generate` sólo necesita una `DATABASE_URL` bien formada en el entorno: no
  conecta a ninguna base ni aplica migraciones, así que no requiere una DB existente.
- El reset **no** recrea la base del path de `TEST_DATABASE_URL`: suelta y crea la DB
  nombrada por `TEST_DB_NAME` (en el gate, `cocos_challenge_test`, default del script) sobre
  el **servidor** de esa URL. Exige permiso de crear/eliminar bases en ese servidor aislado
  de ensayo — no en la DB de la app. Cada suite funcional fija su propio `TEST_DB_NAME`
  aislado derivado de esa misma URL y se auto-resetea.

## Matriz de aceptación (spec §Aceptación → tests → resultado)

| # | Criterio | Tests | Resultado |
|---|---|---|---|
| 1 | Máximo D1 persiste y vuelve con centavos; máximo+0.01 y más escala rechazados sin filas | `tests/functional/large-money/large-money-acceptance.test.ts` §1 “CASH_IN 0.01 / 123.45 / máximo…” y §2 “máximo+0.01, tercer decimal, number y exponente…”; `tests/integration/infra/large-money-storage.test.ts` “round-trip exacto…” y “rechaza máximo+0.01 por overflow del typmod” | ✔ |
| 2 | `90071992547409.93` sin perder el centavo; máximo−0.01 = `…98` | large-money §1 “90071992547409.93 no pierde el centavo…” | ✔ |
| 3 | 0.01 y 123.45 exactos; CASH_OUT por un centavo sobre disponible no debita | large-money §1 + §3 “0.01 sobre disponible 0 ⇒ 201 REJECTED… sin débito” | ✔ |
| 4 | Concurrencia: fondos para una sola ⇒ **dos órdenes con sus eventos** (una `FILLED`, otra `REJECTED`) y **un solo débito**; auditoría en la misma disciplina | large-money §3 “dos CASH_OUT concurrentes…”; `tests/functional/orders/create-order.test.ts` UC-3·12/·13 (idempotencia concurrente y cash concurrente) | ✔ |
| 5 | Size derivado fuera de rango ⇒ 400 sin INSERT; fracciones no se guardan como trading | large-money §6 “BUY amountArs 2147483648.00 ⇒ 400 sin orden/evento”; `tests/unit/contracts-orders.test.ts` (cota INT4); storage “acepta cash grande (> INT4)…” | ✔ |
| 6 | Agregados > máximo exactos; `quantity` > entero seguro sin contaminar marketValue | large-money §7 “dos cash máximos…”; `tests/unit/domain/portfolio.test.ts` (ver Límites) | ✔ |
| 7 | Seed conserva valores e IDs; replays históricos §5 no reejecutan movimientos | large-money §5 (replay 123.45→123.00, 409 sin evidencia, ZERO_SIZE histórico); storage “preflight legacy…”, “aplica la migración nueva… conserva filas, IDs, keys y eventos” | ✔ |
| 8 | Migración probada desde esquema viejo con datos y desde DB nueva + seed; CHECKs en PostgreSQL (no mocks); rollback de multi-escritura | `large-money-storage.test.ts` completo (preflight, ALTER medido, CHECKs inspeccionados por nombre, rollback, “DB nueva: migrate deploy…”) + large-money §8 (rollback trading y cash vía HTTP) | ✔ |
| 9 | OpenAPI y ejemplos con el contrato aprobado | `tests/docs/openapi.test.ts` + `npm run openapi` sin diff en el gate | ✔ |
| 10 | Gates con salida real | typecheck / lint / build / openapi sin diff + suite completa de este gate | ✔ |

## Guardas SQL vs. guardas de aplicación

- **SQL (CHECKs, verificados contra PostgreSQL real, no mocks):** en `orders`, `price` y
  `filledPrice` finitos y **estrictamente positivos** (> 0); en `marketdata`, sus precios
  finitos y **no negativos** (≥ 0: el 0 es válido, los negativos se rechazan); `size` finito
  y no negativo, acciones enteras ≤ INT4 en BUY/SELL, y
  `orders_size_zero_only_rejected_check` (size 0 sólo en `REJECTED`, sin mirar
  `order_events`). Los nombres reales están asertados en `large-money-storage.test.ts`.
- **Aplicación:** gramática monetaria del borde (Zod, 400 sin escribir), sizing defensivo
  antes de `number`, idempotencia en DB (`UNIQUE` + `ON CONFLICT`), lock por usuario,
  reserva y orden/evento en la misma transacción. Cubiertas por unit + functional.

## Límites de la evidencia (lo que NO se afirma)

- **`quantity` > `MAX_SAFE_INTEGER`:** probado en **unit** con ≈4,19 millones de órdenes
  válidas **en memoria** (4.194.306, cada una dentro de INT4). No es un e2e con millones
  de filas en DB.
- **Duración del ALTER `NUMERIC(24,2)` + CHECKs:** 95 ms medida en el ensayo chico (DB de
  test con el seed). **No** es una estimación de duración para producción: la ventana real
  se mide en el preflight del despliegue (spec §6.5).
- **No se ejecutó:** la migración sobre la DB de la app, ningún despliegue rolling, ningún
  downgrade, ni una corrida manual íntegra de la colección `collection/` o de los ejemplos
  `curl` (los `id` de los ejemplos documentados siguen siendo ilustrativos). El despliegue
  de la app queda sujeto a la [ventana coordinada](../../README.md#migración-coordinada-de-grandes-montos).
- **Errores en el log del gate:** contiene dos líneas
  `error no manejado: Error: fallo de auditoría inyectado (rollback E2E)` (routers de
  orders y transfers). Son los throws **inyectados a propósito** por los tests de rollback
  (§8) que el error-handler registra en stderr; **no** son assertions fallidas (0 failed).
