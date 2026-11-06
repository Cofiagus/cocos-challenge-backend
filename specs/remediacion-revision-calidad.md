# Spec — Remediación de la revisión de calidad (post-UC-2)

**Estado: BORRADOR Rev. 1 — requiere aprobación humana explícita antes de cualquier célula.**
**Referencia:** `AGENTS.md` §5 (reglas no negociables), §6 (spec antes de código), §7 (límites).
**Base:** HEAD `e6f9a22` · 5.470 LOC en `src/` · 42 archivos `.test.ts`.

---

## 1. Why

La revisión senior del repo (estructura, dominio, modelos de datos, documentación y tests)
concluyó que la arquitectura y el manejo de dinero son correctos, pero identificó defectos
concretos que un reviewer puede verificar desde la respuesta de la API:

1. **El P&L es incorrecto en dos casos medibles** (costo promedio que no se reinicia al cerrar
   una posición; retorno con signo invertido en posiciones negativas). Afecta `totalReturnPct`
   del portfolio — el dato financiero más visible del challenge.
2. **La idempotencia no cumple su contrato documentado** para `amountArs`: el README promete
   "payload distinto ⇒ 409" y la comparación sólo mira el `size` derivado.
3. **La DB no garantiza las invariantes que la app sí respeta**: columnas críticas nullable,
   sin CHECK de coherencia estado/unidad, sin unicidad de velas de marketdata.
4. **Drift documental ya materializado** (un llamador falso en CODEMAP y tipos monetarios
   desactualizados en `docs/database.md`), con una guardia que no cubre README/DECISIONS/specs.
5. **UC-2 incorporó un proveedor externo al camino crítico** de un request GET, con
   consultas secuenciales por candidato y sin presupuesto de tiempo ni degradación.

Cada punto se ataca con una célula propia, rutas disjuntas y verificación ejecutable.
Nada de esto cambia el contrato de cable ni la semántica aprobada en `DECISIONS.md`.

## 2. What (alcance)

Seis células de código/configuración y una de documentación, en tres waves:

| Wave | Célula | Objetivo | Rutas que ESCRIBE |
|---|---|---|---|
| 1 | **F1-PNL** | WAC por posición con reset al quedar flat; retorno normalizado en posiciones negativas | `src/domain/portfolio/index.ts`, `tests/unit/domain/portfolio*.test.ts` |
| 1 | **F5-EDGE** | Eliminar la duplicación del borde: `parseWriteRequest` + `toHttpError` compartidos | `src/http/shared/edge.ts`, `src/http/orders/orders-router.ts`, `src/http/transfers/transfers-router.ts`, `src/http/cancel/cancel-router.ts` |
| 1 | **F7-DOCS** | Corregir drift y extender la guardia a README/DECISIONS/specs | `docs/CODEMAP.md`, `docs/database.md`, `tests/docs/docs-consistency.test.ts` |
| 1 | **F8-VERIFY** | Scripts de verificación sin DB y humo ESM sobre `dist/` | `package.json`, `tests/deps.smoke.test.ts` |
| 2 | **F2-IDEM** | Idempotencia sobre el payload original (`amountArs`) | `src/infra/prisma/order-repository.ts`, `tests/integration/infra/order-repository.idempotency.test.ts` |
| 2 | **F4-RUNTIME** | `createServerApp(deps)` factory, `/health` con readiness, fail-fast de config, pool dimensionado | `src/http/server.ts`, `src/http/health.ts`, `src/index.ts`, `src/lib/prisma-client.ts` |
| 2 | **F6-QUOTES** | Presupuesto de tiempo y concurrencia en la búsqueda con cotizaciones; política de degradación | `src/application/instruments/search-instruments.ts`, `src/infra/yahoo/yahoo-instrument-quote-source.ts` |
| 3 | **F3-DB** | NOT NULL + CHECKs de estado/unidad + UNIQUE de marketdata (migración create-only) | `prisma/schema.prisma`, `prisma/migrations/<nueva>/migration.sql`, `tests/integration/infra/large-money-storage.test.ts` |

**Fuera de alcance** (ver §3): matching continuo, fills parciales, auth, `DAY`/`EXPIRED`,
cambio de formato del dinero, tablas de saldo, y todo lo que no aparece en las tareas de §5.

---

## 3. Constraints (qué NO)

1. **No cambiar el contrato de cable.** Sin endpoints nuevos salvo `/health` (F4), sin
   renombrar campos, sin volver a `number` el dinero. `openapi.json` se regenera, no se edita.
2. **No tocar rutas de otra célula.** Colisión ⇒ `BLOCKER` al orquestador; jamás editar la ruta ajena.
3. **No editar migraciones aplicadas.** Sólo migración nueva, create-only (D5).
4. **No aplicar migraciones a la DB de la app.** Sólo DBs de test aisladas; requiere autorización humana aparte.
5. **No relajar la toolchain.** Sin `any`, sin `eslint-disable`, sin subir umbrales de
   `complexity`/`max-depth`/`max-params`/`max-lines*`. Superar un umbral ⇒ extraer función con nombre de dominio.
6. **No introducir dependencias nuevas.** `fetch`, `zod`, `decimal.js`, `pg` son suficientes.
7. **No reescribir tests ajenos.** Si una aserción existente consagra el defecto (F1.b), cambiarla
   es parte de la tarea y se reporta explícitamente, con justificación.
8. **No implementar matching ni fills parciales.**
9. **Cero secretos en el repo.** Sin credenciales en `.env*`, scripts ni logs.
10. **Sin merge a `main` por las células.** Mergea sólo el orquestador, de a una tarea por vez.

---

## 4. Invariantes de `DECISIONS.md` → puerto/firma → test

El gate de cada wave recorre esta tabla fila por fila. Una invariante sin puerto o sin test que
la pruebe ⇒ **REJECT del gate**.

| Invariante (`DECISIONS.md`) | Puerto / firma que la expresa | Test que la prueba |
|---|---|---|
| Dinero nunca float, entrada/salida string | `FinancialDecimal` (`contracts/financial-decimal.ts:18-21`), `MoneyArsSchema`/`ArsInputSchema` | `tests/unit/money-input`, `money-serialization`, `large-money-arithmetic` |
| Idempotencia en DB, claim como primera escritura | `OrderRepository.createOrder` + `ON CONFLICT` (`infra/prisma/order-repository.ts:137-147`) | `tests/integration/infra/order-repository.idempotency` |
| Validación + escritura en UNA tx con lock por usuario | `OrderRepository.withUserTransaction` (`order-repository.ts:171-187`) | `tests/integration/infra/order-repository.transaction` |
| Auditoría append-only en la misma tx | `OrderRepository.appendOrderEvent` dentro del tx | `order-repository.transaction.test.ts:232` (rollback) |
| Transición atómica `NEW→CANCELLED` | `markCancelled` = `UPDATE … WHERE status='NEW'` (`order-repository.ts:288-298`) | `tests/functional/cancel` |
| Cash y posiciones son proyecciones | `PortfolioReadRepository` + `deriveCash`/`derivePositions` | `tests/unit/domain/portfolio*`, `tests/functional/read` |
| Errores uniformes `{error:{code,message}}` | `apiErrorBody` (`contracts/errors.ts:50-52`) | `tests/unit/http/error-contract` |
| WAC de posición sobre compras | `weightedAverageCost` (`domain/portfolio/index.ts:120-134`) | **nuevo**: ciclo cerrado+reabierto (F1.a) |
| Proveedor de cotización inyectable | `InstrumentQuoteSource` (`domain/ports/index.ts`) | `tests/unit/infra/yahoo-instrument-quote-source`, `instrument-search-ports` |

---

## 5. Tasks

Cada tarea es atómica, de 1–2 archivos, y termina con su verificación ejecutada y pegada.

### Wave 1 — paralela (4 células, rutas disjuntas)

**F1-PNL · Célula de dominio P&L** — rutas: `src/domain/portfolio/index.ts`, `tests/unit/domain/portfolio*.test.ts`

- **T1.a — WAC de posición con reset al quedar flat.** Especificar el WAC acumulando lotes y
  reiniciándolo cuando la cantidad neta llega a 0: `avgCost` de la posición viva, no el
  promedio histórico de todas las compras. Motivo: el contrato expone
  `weightedAverageCostArs` de la posición y `totalReturnPct`, y hoy una ida y vuelta deja un
  `avgCost` fantasma que fabrica un retorno inexistente (`+33.33%` donde el económico es
  `0%`). Verificado por ejecución contra el código real.
- **T1.b — Retorno normalizado en posiciones negativas.** Normalizar el denominador por
  `|costBasis|` (o por capital comprometido). Hoy `costBasis = quantity × avgCost` es
  negativo y divide, invirtiendo el signo: una posición que **gana** $150 reporta `-10%`.
  **Atención:** `tests/unit/domain/portfolio.test.ts:390-415` congela `-10.00%` como
  correcto y debe actualizarse en la misma tarea, justificándolo en el reporte.
- **VERIFY (célula):** `npx jest tests/unit/domain` ⇒ verde; `npm run typecheck && npm run lint` ⇒ exit 0.

**F5-EDGE · Célula de borde HTTP** — rutas: `src/http/shared/edge.ts` + los 3 routers de escritura

- **T5.a — `parseWriteRequest(req, {params, body, header})` y `toHttpError(error)` en `shared/edge.ts`.**
  Extrae el bloque idéntico de ~46 líneas de `orders-router.ts:38-83` y `transfers-router.ts:44-89`
  y centraliza el mapeo `instanceof XError → status` repetido en los 3 routers.
- **T5.b — Los routers consumen los helpers** sin cambiar el contrato: mismos status, mismos códigos.
- **VERIFY (célula):** `npx jest tests/unit/http` ⇒ verde; `npm run lint` ⇒ exit 0; `git diff --stat` ⇒ 0 cambios en `openapi.json`.

**F7-DOCS · Célula de documentación** — rutas: `docs/CODEMAP.md`, `docs/database.md`, `tests/docs/docs-consistency.test.ts`

- **T7.a — Corregir el llamador falso.** `docs/CODEMAP.md:63` atribuye `evaluateCross` a
  `infra/marketdata-price-source.ts`, que no lo importa (`grep -c evaluateCross` = 0 en ese
  archivo); el llamador real es `src/application/orders/decide-order.ts:336`. Además contradice
  `CODEMAP.md:107` y `:180` ("nadie lo cablea").
- **T7.b — Resolver la ambigüedad de tipos monetarios.** `docs/database.md:82-86,93,106,117`
  declaran `numeric(10,2)` para el "esquema migrado vigente", mientras `schema.prisma:108-112,128-129,143`
  ya está en `Decimal(24,2)` y el quickstart (`README.md:22`) corre `migrate deploy`, que
  produce 24,2. Fijar una convención explícita: "estado aplicado en la DB de la app" ≠ "head
  versionado", y alinear las tablas al head.
- **T7.c — Extender la guardia.** `NORMATIVE_DOCS` (`tests/docs/docs-consistency.test.ts:36-44`)
  cubre sólo `AGENTS.md` + `docs/**`: README, `DECISIONS.md`, `specs/` y `PROGRESS.md` quedan fuera,
  y por eso los 15 tests de docs pasan con `database.md` desactualizado. Ampliar con criterio
  conservador y sin romper el gate.
- **VERIFY (célula):** `npx jest tests/docs` ⇒ verde.

**F8-VERIFY · Célula de verificación** — rutas: `package.json`, `tests/deps.smoke.test.ts`

- **T8.a — `npm run test:no-db`**: script que corre únicamente las suites sin DB, para CI.
- **T8.b — Humo ESM del artefacto que se despliega.** Jest transpila a CJS (`jest.config.js:20`),
  así que un import que sólo rompa en `nodenext` no lo detecta ningún test. Añadir un smoke que
  construya e importe `dist/index.js` (o resuelva imports sin mapper) para cubrir ese agujero.
- **VERIFY (célula):** `npm run test:no-db` ⇒ verde; `npm run build && node --input-type=module -e 'import("./dist/index.js")'` ⇒ arranca.

### Wave 2 — paralela (3 células, rutas disjuntas)

**F2-IDEM · Célula de idempotencia** — rutas: `src/infra/prisma/order-repository.ts`, `tests/integration/infra/order-repository.idempotency.test.ts`

- **T2.a — Comparar el payload original de trading.** `sameIdentityPayload`
  (`order-repository.ts:102-107`) compara instrumento/side/type/TIF/price y `sameTradingSize`
  (`:110-118`) sólo el `size` derivado: dos requests con la misma key y `amountArs`
  `"1000.00"` vs `"1000.50"` que caen en el mismo `floor` devuelven **REPLAY** en vez del
  409 que prometen `README.md:71,291` y `DECISIONS.md:29`. Persistir una huella del pedido
  original y compararla.
- **T2.b — Test de aceptación del caso.** Misma key + `amountArs` distinto con igual `floor` ⇒ 409.
- **⚠️ QUESTION al humano (ver §6, Q1):** el cómo (columna + migración vs reuso de metadata del
  evento, como ya hace el cash). No resolver en silencio.

**F4-RUNTIME · Célula de composición y runtime**

- **T4.a — `createServerApp(deps)` factory** (`src/http/server.ts:18-31`). Hoy los 4 repos se
  instancian a nivel de módulo, así que importar la app exige `DATABASE_URL` y crea el cliente
  (verificado: el import falla sin la variable). Exportar factory + `serverApp` por defecto.
- **T4.b — `GET /health`.** Liveness + readiness con `SELECT 1`; hoy `index.ts` hace `listen()`
  antes de cualquier query y un orquestador manda tráfico a un proceso con la base caída.
- **T4.c — Fail-fast de configuración** (`src/index.ts:7`): `PORT=abc` produce `NaN` y un
  `RangeError` síncrono que no pasa por `server.on("error")`; `DATABASE_URL` recién se valida
  en el primer query.
- **T4.d — Pool dimensionado** (`src/lib/prisma-client.ts:32`): hoy defaults (max 10, sin
  `connectionTimeoutMillis` ni `statement_timeout`).
- **VERIFY (célula):** `npm run typecheck && npm run lint` ⇒ 0; `npx jest tests/unit/http` ⇒ verde.

**F6-QUOTES · Célula de cotizaciones UC-2** — rutas: `src/application/instruments/search-instruments.ts`, `src/infra/yahoo/yahoo-instrument-quote-source.ts`

- **T6.a — Presupuesto de tiempo del request + concurrencia acotada.** Hoy el caso de uso
  llama `getCurrentQuote` secuencialmente por candidato (`search-instruments.ts:100-103`) con
  `limit` hasta 100: peor caso 100 × 5 s. Implementar un deadline compartido y un límite de
  concurrencia explícito (o paralelismo acotado), preservando el orden del catálogo.
- **T6.b — Política de faltantes sin regalo de datos.** Mantener la política aprobada:
  `quote === null` ⇒ omitir y completar el cupo con el siguiente candidato (sin fallback al
  seed); `MarketDataServiceUnavailableError` ⇒ propagar a 503. **No** degradar a listado parcial
  como éxito sin decisión humana.
- **VERIFY (célula):** `npx jest tests/unit/application/search-instruments tests/unit/instrument-search-ports` ⇒ verde.

### Wave 3 — secuencial (la más riesgosa, última a propósito)

**F3-DB · Célula de integridad de datos** — rutas: `prisma/schema.prisma`, `prisma/migrations/<nueva>/migration.sql`, `tests/integration/infra/large-money-storage.test.ts`

- **T3.a — Preflight de sólo lectura** sobre DB de test: contar filas con
  `status/size/price/type/side` NULL, `FILLED` sin `filledPrice`, `LIMIT` sin `price`,
  cash con `price ≠ 1.00`, y velas duplicadas por `(instrumentId, date)`. Registrar conteos.
- **T3.b — Backfill + constraints** según el preflight: `NOT NULL` en columnas que el dominio
  exige, CHECKs de coherencia (`FILLED ⇒ filledPrice NOT NULL`, `LIMIT ⇒ price NOT NULL`,
  cash ⇒ `price = 1.00`), `UNIQUE(instrumentId, date)` en marketdata. Migración create-only.
- **VERIFY (célula):** `npm run test:db:reset && npx jest tests/integration/infra` ⇒ verde contra DB de test aislada (una DB por suite).

---

## 6. Defaults que requieren confirmación explícita

Antes de despachar la célula correspondiente, el humano debe elegir:

| # | Célula | Decisión | Opciones |
|---|---|---|---|
### ✅ Decisiones ya tomadas por el humano (2026-11-06)

| # | Célula | Decisión | Consecuencia |
|---|---|---|---|
| **Q1** | F2-IDEM | **A — columna nueva `requestFingerprint`** | Agrega una columna a `orders` y una migración create-only. Cablea con F3-DB: la columna y su UNIQUE/CHECK se definen UNA sola vez en la migración de F3, y F2 sólo la escribe/compara. Orden de ejecución: **F3 antes de F2** en la Wave 3 (F3 define el DDL, F2 lo consume). |
| **Q2** | F1-PNL | **A — denominador `|costBasis|`, retorno exacto con signo** | El retorno de una posición negativa se **calcula** y puede ser negativo cuando corresponde: gana ⇒ positivo, pierde ⇒ negativo. No se devuelve `null`. Actualizar `tests/unit/domain/portfolio.test.ts:390-415`, que hoy congela `-10.00%` para una posición que gana $150. |

### ✅ Decisiones tomadas por el humano (2026-11-06)

| # | Célula | Decisión | Consecuencia |
|---|---|---|---|
| **Q3** | F6-QUOTES | **A — sin cache** | Sólo presupuesto de tiempo del request + concurrencia acotada. Sin estado en memoria: el precio es siempre fresco. Se descarta TTL. |
| **Q4** | F3-DB | **A — versionar Y ensayar en DB de test aislada** | La migración se aplica **sólo** sobre una base de test creada para el ensayo. **No se toca la DB de la app.** El ensayo deja evidencia de conservación de valores. |
| **Q5** | F4-RUNTIME | **A — `HOST` configurable, default `127.0.0.1`** | Mantiene el comportamiento actual (fix `d7663d1`) y permite contenedor. |
| **R1** | F9-README (nueva, Wave 2) | **A — actualizar números y estado a lo verificado** | El README deja de afirmar "37 suites / 515 tests" y "A4/A5 no verificados"; se alinea con la corrida real y con G5/Yahoo en vivo. |

### ⏳ Pendientes de confirmación

Ninguno. Todas las decisiones abiertas están firmadas; el build sigue el orden de §2.

---

## 7. Gate de verificación (lo corre el orquestador, no la célula)

Cada wave termina con el gate completo re-corrido por el orquestador antes del primer merge,
y después de **cada** merge:

```bash
npm run typecheck                 # exit 0
npm run lint                      # exit 0
npm run test:no-db                # (T8.a) suites sin DB, verde
npm run test:db:reset             # sólo si hay suites con DB en la wave
npm test                          # suite completa
npm run openapi && git diff --stat openapi.json   # 0 cambios salvo F4/F7
```

Reglas:
- Gate rojo ⇒ no se mergea y se devuelve a la célula o se relanza acotado.
- Si un merge toca `package.json`/lock ⇒ `npm install` en `main` antes de re-correr el gate.
- `PROGRESS.md` se actualiza en el **mismo commit** que cierra el gate (tabla de células +
  HEAD real), y no puede contradecirse con `git log`.

## 8. Protocolo de ejecución (heredado de `cell-orchestration`)

- Una branch y un worktree por célula: `git worktree add ../coccb-wt-<celula> -b <rama> main`,
  `npm ci` antes del dispatch, suite base verde antes de escribir.
- Rutas disjuntas; cualquier necesidad de ruta ajena ⇒ `BLOCKER`, no editar.
- Sin `skill_manage` dentro de la célula; las lecciones van en `OPEN`.
- Todo archivo existente se lee completo antes de reescribirlo.
- Timebox por tarea: **12 llamadas a herramientas / 10 min**. Al vencer: entregar lo verde
  commiteado y listar lo pendiente como limitación.
- Formato de reporte obligatorio:

```
CELL: <nombre> | TASK: <id>
STATUS: DONE | PARTIAL | BLOCKED
FILES: <creados/modificados>
VERIFY: <comando> => <resultado>
OPEN: <QUESTIONs / BLOCKERs / limitaciones>
```

- **Humo previo:** despachar 2 células triviales (una por ruta de modelo) valida modelo real,
  cwd y acceso al repo antes de gastar el presupuesto.

## 9. Entorno y línea de base verificada

**DB local (cluster userspace, no docker — no hay docker en esta máquina):**

```bash
# El cluster vive en ~/.pg/cocos y escucha 127.0.0.1:5433 (lo que espera .env.test)
/usr/lib/postgresql/18/bin/pg_ctl -D ~/.pg/cocos \
  -o "-p 5433 -k $HOME/.pg/sockets -c listen_addresses=127.0.0.1" \
  -l ~/.pg/cocos.log start
# Chequear por TCP, no por socket: `pg_isready -p 5433` usa /var/run/postgresql y da falso negativo
pg_isready -h 127.0.0.1 -p 5433
```

**Línea de base medida en HEAD `e6f9a22` (2026-11-06):**

```bash
npm run test:db:reset   # cocos_challenge_test: setval 4 / 66 / 11 / 126 (golden)
npm run typecheck       # exit 0
npm run lint            # exit 0
npm test                # 42 suites / 581 tests, exit 0, 21.7 s
```

Limitación observada en esa corrida: `A worker process has failed to exit gracefully and has been
force exited` — hay handles sin cerrar en alguna suite. No rompe el gate, pero contradice la
afirmación "0 open handles" de `PROGRESS.md`. Se registra como deuda, no como bloqueante.

## 10. Fuera de alcance explícito

- Motor de matching, disparador de `matchRestingOrders`, fills parciales.
- Autenticación/autorización (el challenge la descarta).
- Nuevos valores de enum (`DAY`, `EXPIRED`) y su barrido.
- Cambiar el formato del dinero (string in/out está firmado en D3).
- Tablas de cash/posiciones materializadas (contradice `AGENTS.md` §5.7).
- Refactors estéticos sin impacto en corrección o mantenibilidad verificable.
