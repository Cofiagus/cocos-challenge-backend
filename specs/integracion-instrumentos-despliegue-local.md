# Spec — plan de delegación: integrar UC-2 (cotizaciones Yahoo) sobre grandes montos, migrar sólo la DB local, dejar la API arriba y verificar con supervisión estricta

> **Rev. 3 — BORRADOR pendiente de validación humana.** Re-escrito tras revisión por hallazgos contrastados del
> supervisor (semántica Git, scopes reales, gates supervisados, writers de DB, preflight y runtime). Sigue siendo un PLAN:
> esta fase no ejecuta nada. Hay UNA validación humana de este plan y su topología; después los gates G0–G5 los corre y
> verifica el supervisor (padre orquestador), único que mergea a main, con read-back de outputs reales. UC-2 Rev. 2 y
> D1–D5 están firmadas y se toman como dado: ninguna decisión firmada se reabre.
>
> **Semántica Git (hallazgo verificado):** `feature/instruments-current-quotes` (`4541d1c`) divergió en el ancestro común
> `60b3764`, pre-grandes-montos. El diff two-point `main..rama` muestra "D" en artefactos D1–D5 porque esas rutas fueron
> AÑADIDAS sólo en main después del fork: contra el ancestro (`git diff --name-status 60b3764..rama`) esas rutas están
> VACÍAS — la rama jamás las tocó. Prohibido afirmar "la rama borra artefactos" o que "un merge los borraría". Riesgo
> real: copiar archivos completos viejos o resolver theirs a full revierte finanzas. Método: portar el alcance UC-2 de
> `4541d1c` sobre `8d1475f` por alcance, comparando contra `60b3764`, conservando finanzas y la config/env de main. Sin
> declarar "merge no es posible" sin repro (`git merge-tree`); prohibido checkout/restore de la rama entera.

## Why

UC-2 vive completo y probado en `feature/instruments-current-quotes` (`4541d1c`) pero no está en main, que ya integra
grandes montos (D1–D5). Comparten ancestro `60b3764`: hay rutas nuevas y rutas compartidas que requieren reconciliación;
los archivos financieros añadidos sólo en main no fueron eliminados por la rama UC-2. La entrega además exige una DB app local migrada con `prisma migrate
deploy`, la API corriendo en 3000 y verificación HTTP en vivo — sin tocar el PG del sistema (5432) ni DBs remotas, y
conservando los 515 escenarios ya probados.

## What

Validación humana única (plan + topología) → A0…A6 con gates G0–G5 supervisados por el padre. Máximo **4 subagentes
activos**, células de código disjuntas, **sólo el orq mergea**.

### Inventario medido (preflight 2026-11-05; la existencia/estado de la DB la descubre el operador con tools, no por opinión humana)

| Hecho | Valor |
|---|---|
| `main` | `8d1475f`, limpio; grandes montos integrados; 37 suites / 515 tests verdes |
| `feature/instruments-current-quotes` | `4541d1c`, base `60b3764`; UC-2 completo; **no integrado**; no tocó rutas D1–D5 (verificado vs ancestro) |
| Cluster local | `~/.pg/cocos`, `PG_VERSION 18`, servidor **apagado** hoy |
| Puertos | 5433 libre · servicio en 5432 sin ownership confirmado (AJENO, no tocar) · 55432 cluster de pruebas activo |
| `.env` (main worktree) | existe, `PORT=3000`, **sin `DATABASE_URL`** |
| Proceso heredado / `.env.test` | heredado: `DATABASE_URL` → `127.0.0.1:55432/lm_prepare_test` (preparación): **nunca usar por default**; `.env.test`: `localhost:5433/cocos_challenge_test` |
| Toolchain | `psql`/`pg_dump`/`pg_restore` disponibles; dependencias y cliente Prisma generados para verificar este plan |

### Topología (confirmable en la validación única; nada se ejecuta sin ella)

| Recurso | Propuesta | Condición |
|---|---|---|
| PG app local | cluster `~/.pg/cocos`, loopback **5433** | sin inicializar/borrar el cluster; sin asumir contenido |
| DB app | `cocos_challenge` en ese cluster | el operador la **descubre** en A0: si existe se preserva todo (jamás seed/reset de una preexistente); crear+migrar+seed sólo si NO existía, quedó vacía y la política lo permite |
| Tests | DBs aisladas propias en el cluster 55432 | nunca la DB app; los tests SÍ escriben en sus DBs de test |
| HTTP | **127.0.0.1:3000** | libre al inventariar; verificar de nuevo y limitar el listener a loopback |

### Roles y writers de DB

| Rol | Modelo | Responsabilidad |
|---|---|---|
| Orquestador (padre) | supervisor | corre G0–G5, read-back, merges a main, PROGRESS |
| Células de código | DS (`ds_flash`) razonamiento/runtime; GLM adaptador/test-docs/DB | A1 por subtareas, A4/A5/A6 |
| Operador DB | GLM (único) | único **escritor de migraciones / ADMIN de la DB app** (A0, A3) |
| QA independiente | célula distinta del autor | ACCEPT/SIN BLOQUEANTES antes de cada merge |

Writers de DB reales: el operador escribe la DB app; **los tests escriben sus propias DBs de test aisladas** (pueden
paralelizar sobre DBs distintas); los tests HTTP de escritura corren en copia de prueba (55432), **nunca** contra la
DB app del runtime. Prohibido seed/reset de una DB app preexistente; sí se permite resetear las DBs exclusivamente de test identificadas y asignadas a cada suite.

### Scopes — rutas concretas y dueño (no "S-INT todo")

| Scope | Dónde | Rutas / dueño |
|---|---|---|
| S-PLAN | este worktree, `plan/instruments-local-rollout` | sólo `specs/integracion-instrumentos-despliegue-local.md` |
| S-INT | `coccb-wt-local-rollout-int`, rama `feature/instruments-local-rollout` desde `8d1475f` | rama candidata: sólo el supervisor integra commits de células |
| C-SEAMS (DS) | worktree propio `…-seams` | contracts/instruments + errors, domain/ports e instrument-repository (sólo offset), con sus tests; secuencia de cortes de 1–2 archivos |
| C-YAHOO (GLM) | worktree propio `…-yahoo`, desde seams verificados | nuevo adaptador Yahoo y su unit test; fila propia de CODEMAP |
| C-UC2 (DS) | worktree propio `…-uc2`, desde seams verificados | nuevo search-instruments y test; luego router y test HTTP; filas propias de CODEMAP |
| C-WIRING (DS) | worktree propio `…-wiring`, después de C-UC2/C-YAHOO | http/server.ts y functional/large-money/support.ts: Yahoo real sólo en runtime, fuente controlada en tests |
| C-TESTS (GLM) | worktree propio `…-tests`, después de wiring | functional/read/support.ts + read-endpoints.test.ts, sin revertir UC-1 ni sus valores string |
| C-DOCS (GLM) | worktree propio `…-docs`, después del contrato estable | registry/OpenAPI y docs UC-2 de (c), de a 1–2 archivos; CODEMAP general sólo tras integrar las filas de autores |
| S-QA | worktree transitorio en el SHA exacto del candidato | corre gates; no edita src |
| A3–A5 | **worktree principal** (main, SHA integrado) | operador DB y runtime; sin worktrees dedicados |

Sin worktrees para operadores puramente read-only: A0 corre con herramientas desde el worktree del plan; worktrees
sólo para células de código y QA cuando ejecuta. Sin secretos en logs, informes ni Git; backups privados durables (fuera de
`/tmp` y del cache 24 h) con restore ensayado; sin dinero en float; sin reescribir `order_events`; 1–2 archivos por
subtarea; timebox explícito y outputs reales por ejecutor; QUESTION cerrada sólo ante una ambigüedad real. Al vencer,
entregar el estado y los cortes verificados, no reintentar sin límite ni interrumpir a la fuerza una migración activa.

## Constraints

- Esta fase (S-PLAN) no ejecuta nada: sin DB writes, sin servicios, sin merges ni push. Sólo comitea este md.
- Núcleo financiero **congelado** para la integración UC-2: `src/contracts/{money,financial-decimal,domain,orders,portfolio,transfers}.ts`,
  `src/domain/{portfolio,matching,sizing}/**`, `src/application/{orders,transfers,portfolio}/**`, `src/http/shared/edge.ts`,
  `src/infra/prisma/{mappers,order-repository,portfolio-read-repository,marketdata-repository,marketdata-price-source}.ts`,
  `prisma/schema.prisma`, migraciones y deps de `package.json`: prohibido editarlos salvo BLOCKER con repro aprobado por humano.
- No reescribir las specs firmadas (`instruments-current-quotes.md`, `datos-financieros-grandes-montos.md`).
- `prisma migrate deploy` como comando de despliegue de las migraciones versionadas. No generar nuevas migraciones,
  usar `migrate reset` ni `db push`. El script existente de reset sólo se admite sobre DBs de test asignadas, nunca la DB app.
  No editar migraciones ya aplicadas.
- Legacy sin history de Prisma o DDL divergente → detener y escalar; prohibido baseline automática y SQL normalizador por defecto.
- `.env` existente NO se sobrescribe con `*.example`: backup + editar sólo las keys necesarias, preservando el resto; fuera de Git.
- `src/index.ts` escucha con `listen(port)` (sin soporte HOST): no inventar que `HOST=...` restringe el listener.
  A4 debe verificar loopback real; si hace falta, delegar un ajuste mínimo de entry + test dentro de A6, sin refactor ni health route nueva.
- Sin ajustes por preferencia: "ajusta todo" = sólo fallos reproducidos, 1–2 archivos rojo→verde, sin borrar
  escenarios ni aflojar asserts. Conteo de tests medido, nunca hardcodeado.

## Tasks

### A0 — Identificación y backup (operador DB GLM; datos de la DB app sin modificar)

- **A0a (sin levantar PG):** identificar archivos/versión/puertos y env: cluster `~/.pg/cocos` (PG 18) apagado, 5433
  libre, 5432 ajeno, 55432 en uso; `.env` de main sin `DATABASE_URL`; proceso heredado apuntando a `lm_prepare_test` (nunca por default).
- **A0b (tras la firma del plan):** arrancar el cluster en 5433; descubrir la(s) DB(s) existentes: history en
  `_prisma_migrations`, conteos y montos de users/orders/order_events/instruments/marketdata, IDs extremos,
  secuencias, PIDs de writers; preflight de grandes montos (size/precios nulos-cero-negativos, cash con precio ≠ 1.00,
  keys cash sin `metadata.amountArs`); backup privado durable + **restore ensayado en un clon de test** (verificado
  por conteos/fingerprints), sin mutar datos de la DB app. Si la DB app no existe, registrar ese estado: no hay DB que
  respaldar; crearla sólo en A3 y conservar evidencia del seed autorizado. Informes sin usuario/password/secretos de query: sólo host/puerto/db.

**G0 (supervisor):** preflight sin anomalías; DB app descubierta con tools. Volver a humano SÓLO por: anomalía
financiera, legacy sin history de Prisma, target no identificado o writer desconocido.

### A1 — Port de UC-2 sobre `8d1475f` (células DS/GLM, scope S-INT)

Orden con gates chicos por subtarea (1–2 archivos + CODEMAP en el MISMO commit si hay exports):
1. **Seams compartidos** (un DS): `src/contracts/instruments.ts`, `src/contracts/errors.ts`,
   `src/domain/ports/index.ts` — portados de `4541d1c`, comparando contra `60b3764`.
2. **Paralelo disjunto:** adaptador Yahoo `src/infra/yahoo/yahoo-instrument-quote-source.ts` (nuevo, GLM) ∥ caso de
   uso `src/application/instruments/search-instruments.ts` (nuevo, DS).
3. **Integración (3 puntos):** `src/http/instruments/instruments-router.ts`, `src/http/server.ts` y
   `src/infra/prisma/instrument-repository.ts` (sólo la lectura por offset que UC-2 necesita).
4. **Cierre:** tests unit UC-2, funcionales, OpenAPI (registry/json) y docs (ver (c)).

Reglas del port: portar por alcance desde `4541d1c`; jamás copiar un archivo completo viejo sobre la versión de main
ni resolver theirs a full; auxiliares de la rama vieja (`.env.example`, `jest.config`, `prisma.config`, scripts de
test-db, `tests/setup`, `tests/helpers`): re-derivar caso por caso (main ya tiene su infra de 515). Los 5 unit UC-2
portan casi tal cual; en `tests/functional/read/{support,read-endpoints.test}.ts` añadir SÓLO los casos UC-2 sobre la
versión de main (preservar strings UC-1 y los 515 escenarios); `tests/functional/large-money/support.ts`: sólo el
ajuste mínimo que exija compilar. Sin deps nuevas, migraciones, mapping de tickers ni seed fallback; fallo de
proveedor → 503 honesto; riesgo intermedio por consumidores pendientes registrado, sin falsear verde.

**G1 (supervisor):** gates chicos de cada subtarea cerrados + build/typecheck/lint del candidato + diff de alcance
(cero toques en rutas congeladas). **Sin suite completa** (esa es G2).

### A2 — Verificación completa del candidato (DS + QA independiente, scope S-QA)

Prisma generate + build + typecheck + lint; suite completa con conteo **medido** ≥ 515 preservados;
`detectOpenHandles` limpio; E2E de máximos/centavos, concurrencia (doble submit, advisory lock), idempotencia
histórica y rollback de multi-escritura contra DBs de test aisladas (55432); UC-2 funcional con fuente inyectada
(sin Internet): default 10, omisión de faltantes, 503; OpenAPI determinista regenerado y docs verdes.

**G2 (supervisor):** QA independiente ACCEPT sin bloqueantes → el padre mergea a main.

### A3 — Migración única de la DB app (operador DB GLM; worktree principal)

1. Pausar writers del repo/proceso; si la DB ya existía, **revalidar el backup** (restore ensayado en clon) ANTES del deploy; registrar
   antes: conteos por tabla, IDs extremos, secuencias, auditoría y montos canónicos de control (sin credenciales ni datos personales en el informe).
2. Si la DB NO existía, crearla y comprobar que está vacía. Aplicar `npx prisma migrate deploy` con DATABASE_URL
   explícita a la DB app (5433); cargar el seed sólo en esa DB recién creada si se aprueba esa política. Jamás seed/reset de una DB app preexistente.
3. Verificar history consistente, CHECKs financieros reales en PostgreSQL, columnas NUMERIC(24,2), fingerprints
   económicos (cash/posiciones/patrimonio) y **segundo deploy sin cambios**.
4. Legacy sin history o DDL divergente → detener, escalar; prohibido `migrate resolve` automático.
5. Rollback = restore probado en clon con costo e indisponibilidad explícitos; prohibido downgrade por cast/truncado de dinero.

**G3 (supervisor):** DB preexistente: fingerprints económicos antes/después iguales. DB nueva: creación y seed trazados,
conteos y montos esperados contrastados con el seed autorizado. En ambos casos: segundo deploy idempotente, migraciones aplicadas y
host/puerto/db de destino registrados (sin secretos).

### A4 — Arranque de la API local (DS; worktree principal, SHA integrado)

1. `npx prisma generate` + `npm run build`; editar el `.env` EXISTENTE (backup previo): añadir `DATABASE_URL` → DB
   app 5433 y fijar `PORT=3000`, preservar las demás keys; sin versionar.
2. Arrancar `npm start` (o `node dist/index.js`) como proceso administrado: PID, puerto, log en archivo durable; PG queda activo. Prohibido matar PIDs ajenos.
3. Verificar la URL real dentro del proceso (vars del proceso + SQL de identidad, sin secretos) y que NUNCA se use
   la heredada de `lm_prepare_test`; verificar `listen(port)`: en qué interfaz queda escuchando (loopback vs todas)
   y ajustar entry + test de forma mínima si no está limitado a loopback, antes del cierre (A6).
4. Ciclo: startup sano, SIGTERM cierra el pool de Prisma, reinicio, `detectOpenHandles` limpio.

**G4 (supervisor):** API y PG siguen activos al terminar la célula (PID vivo, listener loopback en 3000, log sano).
SIGTERM debe cerrar correctamente; después del reinicio se registra el nuevo PID y se repite el smoke.

### A5 — Verificación HTTP en el listener real (DS + QA)

1. Smoke **read-only** contra la DB app real (UC-1, UC-2 read paths), sin contaminar datos runtime.
2. Semánticas de escritura y colecciones contra copia de test (55432), nunca la DB app del runtime.
3. Yahoo **en vivo sin fixtures**: precio último de sesión, `previousClose` de la sesión anterior, fecha de fuente.
   Cobertura: extraer tickers de una **copia** del seed de instruments y medir N cubiertos / total real — sin
   mapping, sin ingesta, sin inventar datos ni asumir cantidades. Un 503 del proveedor NO es un éxito con array
   vacío; distinguir "servidor local arriba + 503 del proveedor" de "integración exitosa completa"; si el mercado está cerrado, reportar la última sesión honestamente.
4. Yahoo externo indisponible desde esta red → reportar BLOQUEO de precio real, sin fingir verificación.

**G5 (supervisor/QA):** endpoints evidenciados, cobertura medida, veredicto honesto de Yahoo y suite completa verde
contra la DB de test.

### A6 — Loop de ajustes por fallos comprobados (DS, scope dueño del archivo)

Sólo fallos reproducidos: issue con repro mínimo → owner del archivo → rojo → fix de 1–2 archivos → verde + gate
re-corrido por el padre. Prohibido borrar escenarios, aflojar asserts o refactor general. Si el fix exige
dependencia nueva, cambio de contrato, migración distinta o altera saldos → humano. QA independiente final antes de
cerrar.

**Gate final (supervisor):** main limpio y mergeado; `PROGRESS.md` del padre; evidencia: SHA mergeado, migraciones
aplicadas + host/puerto/db de la DB app, PID/puerto/log de la API, gates con outputs reales. Sin push sin pedido.

## Interpretaciones a confirmar en la validación del plan (no reabren contratos firmados)

- **(a) Numérico externo:** el JSON de Yahoo ya es `number` (vía `response.json`);
  `FinancialDecimal(String(value))` no recupera dígitos que se perdieron al parsear el JSON como IEEE-754. Propuesta: mantener el parser del
  adaptador aprobado + validación Zod (ARS, finitos), operar con precisión de **64 cifras significativas decimales**, sin prometer exactitud
  del texto externo, sin parser raw ni deps nuevas. No relaja los strings strict del input de usuario ni toca UC-1/3/4/5; limitación expresa.
- **(b) Timeout:** 5 s por cotización, secuencial con `concurrency: 1` (ya en la rama). Mantener el comportamiento
  aprobado y medir latencia en vivo; sin deadline global, caché ni batching inventados. Si la medición muestra
  impedimento real → escalar con repro y presupuesto humano nuevo. Sin SLA instantáneo.
- **(c) Docs firmados no recortables:** INCLUIR el sync UC-2 en `specs/trading-api-domain.md` y
  `docs/arquitectura-implementada.html` sin pérdida D1–D5; las dos specs firmadas quedan read-only. Updates
  derivados según el contrato ya aprobado, sin reabrirlo. En CODEMAP/api/DECISIONS/README/legacy: sólo secciones UC-2, con el wire monetario de main intacto.

## Puntos de parada (detener y escalar, nunca continuar)

1. Anomalía financiera en el inventario A0 (valores imposibles, auditoría truncada, montos que no cierran).
2. Writer/PID desconocido conectado a la DB destino.
3. Legacy sin history de Prisma o DDL divergente (sin baseline ni `migrate resolve` automáticos).
4. Fix que exija dependencia nueva, contrato distinto, migración distinta o altere saldos.
5. Yahoo externo no disponible: BLOQUEO declarado, nunca verificación fingida.
6. Conteo de escenarios previos (< 515) cayendo sin cambio UC-2 aprobado.

## Aceptación verificable

1. UC-2 portado por alcance sobre grandes montos, comparado contra `60b3764`; cero toques en el núcleo congelado; 515 escenarios previos preservados (conteo medido).
2. Contratos: dinero string / `FinancialDecimal` 64 / size cash string / quantity string conviven con default 10, omisión de faltantes y 503 de UC-2.
3. DB app local (`cocos_challenge` en 5433) migrada con `migrate deploy`, history consistente, CHECKs reales en
   PostgreSQL, segundo deploy idempotente; backup revalidado antes del deploy si la DB ya existía y seed trazado si es nueva.
4. API viva al fin de la célula y tras un reinicio (PID/puerto/log verificados por el supervisor), conectada a la
   DB app confirmada dentro del proceso; escucha real verificada.
5. Smoke HTTP real: read-only sobre DB app; escrituras en copia de test; Yahoo en vivo con cobertura medida (N/total del catálogo) o BLOQUEO declarado.
6. Gates G0–G5 con outputs reales pegados; QA independiente ACCEPT antes de cada merge; main limpio; sin push sin pedido.

## Pendientes de humano (una validación inicial; hechos nuevos o cambios de alcance vuelven al humano)

- Validar este plan Rev. 3 y su topología: cluster `~/.pg/cocos` en 5433, DB app `cocos_challenge`, HTTP loopback 3000,
  rutas/ramas de worktree (detalles operativos: responsabilidad del orq, no exigen firma independiente).
- Política de seed si la DB app NO existiera y quedara vacía (jamás sobre una preexistente).
- Las interpretaciones (a) numérico externo y (b) timeout, tal como están enunciadas.
- No se pide: autorización por cancelación/timeout, scope de push, ni opinión humana sobre la existencia/estado de la DB (la descubre el operador con tools en A0).

## Changelog

- Rev. 1: borrador inicial delegado; sin autorización de ejecución.
- Rev. 2: revisión del borrador por hallazgos contrastados del supervisor; sin firma humana nueva.
- Rev. 3: revisión final del supervisor: rutas compartidas y scopes sin contradicciones, worktree por célula,
  aislamiento de tests, precisión Decimal de 64 cifras (no bits), listener sólo local y gates sin mutar datos de la DB app antes de migrar. Sigue pendiente de validación humana.
