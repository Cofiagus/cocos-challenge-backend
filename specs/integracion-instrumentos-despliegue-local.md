# Spec — plan de delegación: integrar instrumentos sobre grandes montos, migrar sólo DB local, arrancar API y verificar con supervisión estricta

> **Rev. 1 — BORRADOR pendiente de validación humana.** Este documento es un PLAN de delegación:
> no autoriza migraciones, arranques de servicios, escrituras en DB ni merges. Cada fase arranca
> sólo tras su gate humano; el padre orquestador verifica outputs reales (read-back), re-corre
> gates y es el único que mergea a main. Este plan NO declara decisiones firmadas como pendientes:
> UC-2 Rev. 2 y D1–D5 de grandes montos están firmadas y se toman como dado.
>
> Base: `main` en `8d1475f` (grandes montos integrados y probados: 37 suites / 515 tests, 0 handles
> abiertos). Rama de este plan: `plan/instruments-local-rollout`. UC-2: `specs/instruments-current-quotes.md`
> Rev. 2 firmada (default 10 con query ausente/vacía, query opcional, Yahoo último dato de sesión +
> `previousClose` de la sesión anterior, símbolo directo `ticker + ".BA"`, omisión de faltantes
> completando el límite, 503 `MARKET_DATA_SERVICE_UNAVAILABLE` ante indisponibilidad — sin seed
> fallback). Grandes montos: `specs/datos-financieros-grandes-montos.md` Rev. 2 firmada (D1–D5).

## Why

UC-2 (cotizaciones actuales de Yahoo) vive en `feature/instruments-current-quotes` (`4541d1c`) y **no
está integrado** a main: esa rama nació de `60b3764` (pre-grandes-montos) y su diff borra archivos de
grandes montos (`prisma/migrations/20261105104903_large_money/`, `specs/datos-financieros-grandes-montos.md`,
`tests/unit/large-money-arithmetic.test.ts`, `tests/integration/infra/large-money-storage.test.ts`,
`docs/references/*precision*`) y revierte `prisma/schema.prisma`. Un merge ingenuo destruiría el
trabajo firmado D1–D5; una reconciliación coordinada puede conservar ambos. Además, la entrega exige
una DB app local real migrada con `prisma migrate deploy`, una API corriendo en el puerto 3000 y
verificación HTTP en vivo — todo con supervisión estricta, sin tocar el PG del sistema (5432) ni DBs
remotas, y sin excluir de la verificación el comportamiento monetario ya probado (515 escenarios previos).

## What

Secuencia A0→A6 con gates. Delegación a subagentes (DS = `ds_flash`, GLM) bajo un padre orquestador;
máximo **4 subagentes activos**, rutas de worktree disjuntas y **un único DB writer** a la vez.

### Inventario medido (fuente: mediciones del padre, 2026-11-05)

| Hecho | Valor |
|---|---|
| `main` | `8d1475f`, limpio; grandes montos integrados; 37 suites / 515 tests verdes |
| `feature/instruments-current-quotes` | `4541d1c`, base `60b3764`, UC-2 Rev. 2 completo; **no integrado**; borra artefactos de grandes montos |
| `.env` (main worktree) | existe, `PORT=3000`, **sin `DATABASE_URL`** |
| Proceso heredado (env del padre) | `DATABASE_URL` → `127.0.0.1:55432/lm_prepare_test` (PREPARACIÓN, **no** es la DB app) y `TEST_DATABASE_URL` → `127.0.0.1:55432/cocos_challenge_test`; no se imprime ni se usa ninguna URI heredada para migrar por default |
| `.env.test` en archivo | apunta a `localhost:5433/cocos_challenge_test` |
| Listeners | 5432 sistema activo (sin ownership confirmado) · 55432 cluster de pruebas con usuarios activos · 5433 libre · 3000 libre |
| Cluster local | `~/.pg/cocos` existe, `PG_VERSION 18`, `pg_ctl status` dice NO servidor |
| Toolchain | `psql`/`pg_dump`/`pg_restore` disponibles; `npm ci` hecho en este worktree; **Prisma generate aún no corrido** |

### Topología operativa propuesta (confirmable por el validador; nada se ejecuta sin esa confirmación)

| Recurso | Propuesta | Condición previa |
|---|---|---|
| PG app local | reutilizar el cluster `~/.pg/cocos` en loopback **5433** | confirmar ownership y config ANTES; **no** inicializar/borrar el cluster existente, **no** asumir el contenido de sus DBs |
| DB app | `cocos_challenge` en ese cluster | inventariar ANTES si existe: si existe se preserva todo (sin seed, sin reset); si no existe y hay aprobación, crear/migrar/seed **sólo si está vacía** |
| Tests | cluster separado `55432` con DBs propias aisladas (nunca la DB app) | ya activo con usuarios; crear DBs de test propias sin alterar ajenas |
| HTTP | puerto **3000** | libre hoy; no ocupar puertos ajenos |
| Prohibido | tocar PG sistema 5432; escribir DB app fuera de A3/A5 controlados | — |

### Roles y delegación

| Rol | Modelo | Responsabilidad |
|---|---|---|
| Orquestador (padre) | humano + supervisor | gates, verificación read-back de outputs, merges a main, PROGRESS; comprueba que el proceso de API SOBREVIVE al fin de la célula antes de declarar la API arriba |
| Células de código | DS (`ds_flash`) | A1 reconciliación, A2 suites, A6 fixes acotados |
| Operador DB | GLM (único, exclusivo) | A0 auditoría read-only y A3 migración; **ningún otro rol escribe DB** |
| Runtime | DS | A4 proceso de API, A5 smoke HTTP |
| QA independiente | célula distinta del autor | califica ACCEPT/SIN BLOQUEANTES antes de cada merge a main |

### Scopes — rutas de worktree disjuntas (propuestas, confirmables)

| Scope | Worktree | Rama propuesta | Archivos dueños |
|---|---|---|---|
| S-PLAN (esta fase) | `coccb-wt-local-rollout-plan` | `plan/instruments-local-rollout` | sólo `specs/integracion-instrumentos-despliegue-local.md` |
| S-AUDIT | `coccb-wt-local-rollout-audit` (nuevo) | sin código: audit read-only | reporte en workspace privado, no en repo |
| S-INT | `coccb-wt-local-rollout-int` (nuevo) | `feature/instruments-local-rollout` | integración UC-2 (1–2 archivos por tarea) |
| S-QA | `coccb-wt-local-rollout-qa` (nuevo) | checkout del SHA del candidato | no edita src: corre gates |
| S-DB | `coccb-wt-local-rollout-db` (nuevo) | checkout del SHA aprobado | operador DB: migración y verificación |
| S-RT | `coccb-wt-local-rollout-runtime` (nuevo) | checkout del SHA migrado | runtime + smoke |

Reglas transversales: sin secretos en nariz ni Git; sin `env` reales versionados (`.env`/`.env.test`
se crean por worktree desde `*.example`, fuera de Git); sin dinero en float; sin reescribir auditoría
(`order_events`) ni datos financieros históricos; sin suite contra la DB app; backups **privados y
durables** (fuera de `/tmp` y del cache 24 h) con restore ensayado; no prometer duración de lock ni
los 95 ms de ensayo de producción; cada ejecutor con timebox + pregunta cerrada al final + outputs
reales; máximo 1–2 archivos por tarea; nada de lanzar todo en paralelo sin dependencias.

## Constraints

- **Esta fase (S-PLAN) no ejecuta nada**: sin DB writes, sin arrancar servicios, sin merges a main ni
  push remoto sin pedido explícito. Sólo crea y comitea este md.
- No DB remota ni producción. No tocar PG sistema 5432. No inicializar/borrar el cluster `~/.pg/cocos`
  ni asumir su contenido. Sin migrar antes de G1 aprobado.
- No reescribir specs firmadas (`instruments-current-quotes.md`, `datos-financieros-grandes-montos.md`);
  no marcar este plan como aprobado; no pasar a ejecución sin validación humana.
- Mantener fuente Yahoo **sólo para UC-2**, sin influir ejecución/portfolio; sin mapping de tickers,
  sin dependencias nuevas, sin migraciones nuevas en A1; fallo de proveedor → 503 honesto, nunca seed
  fallback ni reemplazo de fuente.
- `prisma migrate deploy` como único comando de despliegue (nunca `migrate dev`, `db push` ni `reset`
  contra la DB app); no editar la migración inicial ni migraciones ya aplicadas.
- Si la DB legacy no tiene history de Prisma o el DDL diverge: **detener y pedir estrategia humana**;
  prohibido baseline automática y SQL normalizador por defecto.
- `src/index.ts` escucha en `listen(port)`, no en HOST: no asumir que `HOST` env funciona; cualquier
  ajuste de red local se reporta como mínimo y justificado (sin new health route ni framework nuevo).
- Conteo final de tests **medido**, no hardcodeado: los 515 previos deben conservarse salvo cambio
  UC-2 aprobado; puede crecer, no puede caer sin justificación auditada.

## Tasks

### A0 — Inventario de DB local real y preparación (paralelizable con A1, read-only)

Dueño: GLM (operador DB único), scope S-AUDIT. Sin migrar hasta G1.

1. Levantar (o no) el cluster `~/.pg/cocos` en 5433 **sólo tras** confirmar ownership y config; antes
   de cualquier SQL, confirmar localidad de la URL contra la que se va a conectar (nunca una URI
   heredada del proceso).
2. Inventario read-only de la(s) DB(s) existentes: migraciones aplicadas (`_prisma_migrations`),
   presencia y conteo de users/orders/order_events/instruments/marketdata, preflight especial de
   grandes montos (size/precios nulos, cero, negativos, cash con precio ≠ 1.00, keys cash sin evidencia
   de `metadata.amountArs`), secuencias, PIDs de writers activos.
3. Neutralizar la influencia del env de test heredado para el runtime futuro: definir explícitamente
   qué `DATABASE_URL` usará la API (la DB app en 5433) y qué `TEST_DATABASE_URL` usarán los tests
   (cluster 55432), documentándolo como confirmable; en el proceso de runtime se valida la URL real
   dentro del proceso (A4), no se confía en el entorno heredado.
4. Backup privado durable de la(s) DB(s) existentes + **restore ensayado en un clon** (verificado por
   conteos/fingerprints, no por mensaje de éxito).

**Gate G0 (humano):** inventario leído y confirmado; anomalías resueltas o escaladas; propuesta de
DB app confirmada. Si hay anomalías financieras, writers desconocidos o legacy sin history de Prisma:
**punto de parada** — sin baseline automática, sin SQL normalizador.

### A1 — Integración de UC-2 en el candidato (desde main 8d1475f)

Dueño: DS, scope S-INT. Dependencia: contratos/ports **antes** de cualquier célula paralela.

1. Crear `feature/instruments-local-rollout` desde `main` `8d1475f`; integrar de
   `feature/instruments-current-quotes` **sólo el alcance UC-2** (archivos nuevos:
   `src/application/instruments/search-instruments.ts`, `src/infra/yahoo/yahoo-instrument-quote-source.ts`,
   `src/contracts/instruments.ts` ya existente adaptado, ports, router, tests unitarios/funcionales
   de UC-2, OpenAPI/docs de UC-2), **sin arrastrar** el snapshot/config viejo ni el envfile de la rama
   origen, y **sin aceptar** sus borrados de grandes montos (migración `20261105104903_large_money`,
   spec firmada, tests y docs de grandes montos, `schema.prisma` NUMERIC).
2. Reconciliar en los archivos que ambas líneas tocaron (`decide-order`, `persist-order-decision`,
   `submit-order`, `get-portfolio`, `edge`, mappers, contratos de dinero, OpenAPI, CODEMAP, DECISIONS):
   preservar `FinancialDecimal` 64 / dinero string / `quantity` string / size cash string de D1–D5 y
   sumar la política UC-2 Rev. 2 (default 10, 503, omisión de faltantes).
3. Mantener Yahoo sólo UC-2; sin seed fallback; sin mapping de tickers; sin dependencias ni
   migraciones nuevas; sin tocar otras UC.
4. Un DS auditor paralelo entrega el informe de riesgos/rutas del diff; el integrador **no inventa**
   resultados del review: lo que no esté en el informe no se cita.

**Gate G1 (humano):** typecheck + lint + suite completa del candidato con conteo medido ≥ 515
escenarios previos preservados; diff revisado sin borrados de grandes montos; informe del auditor
entregado. Recién aquí se autoriza A2 (y la migración de A3 queda desbloqueada en su gate propio).

### A2 — Verificación determinista del candidato

Dueño: DS (+ QA independiente), scope S-QA. Pruebas contra PG de test aislado (55432), **nunca la
DB app**.

1. Prisma generate + build + typecheck + lint del SHA del candidato.
2. Unit + docs funcionales (`docs-consistency`, `openapi`) deterministas; E2E de máximos/centavos,
   concurrencia (doble submit, advisory lock), idempotencia histórica (§5 grandes montos), rollback
   de multi-escritura; `detectOpenHandles` limpio.
3. UC-2 funcional con fuente inyectada (sin Internet): contrato de default 10, omisión, 503.
4. OpenAPI determinista regenerado y tests de docs verdes; conteo final **medido y reportado**.

**Gate G2 (humano/supervisor):** QA independiente califica ACCEPT sin bloqueantes → recién entonces
el padre puede mergear el candidato a main. A3 no arranca sin este gate + confirmación humana.

### A3 — Migración única de la DB app local

Dueño: GLM (operador DB único, exclusivo durante toda la fase), scope S-DB. Precondición: main
mergeado con A1–A2 verdes, G0 sin anomalías.

1. Pausar escrituras del repo/proceso; verificar el backup de A0 (restore ensayado en clon) y
   registrar ANTES: conteos por tabla, IDs extremos, secuencias, filas de auditoría, montos
   canónicos de control (sin credenciales ni datos personales en el informe).
2. Aplicar **sólo migraciones versionadas** con `npx prisma migrate deploy` apuntando a la DB app
   local (5433). `migrate dev` no es comando de despliegue; prohibido `db push`/`reset`. Si la DB no
   existía y hay aprobación: crear + migrar + seed **sólo si quedó vacía**.
3. Después: verificar history consistente, CHECKs financieros presentes en PostgreSQL (no sólo
   mocks), tipos columnares NUMERIC(24,2), fingerprints económicos (cash/posiciones/patrimonio por
   valor) y **idempotencia de un segundo deploy** (sin cambios, sin error).
4. Si la DB es legacy sin history de Prisma o el DDL diverge del esperado: **detener, escalar
   estrategia humana**; prohibido `migrate resolve` automático.
5. Rollback: restauración probada en clon; tras almacenarse datos nuevos, prohibido un downgrade por
   cast/truncado — sólo restore aprobado, con costo e indisponibilidad explícitos.

**Gate G3 (humano):** fingerprints antes/después iguales, segundo deploy idempotente, evidencia de
migraciones aplicadas y URL de destino registrada.

### A4 — Arranque de la API local (dejarla corriendo)

Dueño: DS, scope S-RT. Precondición: G3.

1. En el worktree del SHA mergeado: `npx prisma generate` + `npm run build`; `.env` local creado
   desde `.env.example` con `DATABASE_URL` → DB app 5433 y `PORT=3000` (sin versionar, sin secretos
   en Git); **sin** heredar el `DATABASE_URL` de lm_prepare_test del proceso padre.
2. Arrancar `npm start` (o `node dist/index.js`) como proceso **administrado y documentado** (PID,
   puerto, log en archivo durable); PG queda activo también. Prohibido: matar PIDs desconocidos,
   `nohup` mágico, daemons incontrolables, ocupar puerto ajeno.
3. Verificar la URL real dentro del proceso: si las fuentes no la exponen, confirmar por variables
   del proceso y SQL de identidad (sin secretos); `src/index.ts` escucha `listen(port)` sin HOST —
   verificar el límite de red local y, si hiciera falta ajuste, reportarlo como mínimo y justificado
   (sin new health route ni framework).
4. Tests de ciclo: startup sano, shutdown ordenado (SIGTERM cierra el pool de Prisma), reinicio, y
   cierre de pools verificado (`detectOpenHandles` del smoke).

**Gate G4 (padre):** el orquestador comprueba que el proceso **SOBREVIVE al fin de la célula** antes
de declarar la API arriba (PID vivo, puerto 3000 escuchando, log sin errores).

### A5 — Verificación HTTP en el listener real

Dueño: DS (+ QA), scope S-RT. Sobre la API de A4 y la DB app migrada.

1. Smoke **read-only** contra la DB app real (UC-1, UC-2 read paths) sin contaminar datos runtime
   con órdenes.
2. Semánticas de escritura y colecciones contra una **copia de test restaurada** (55432), nunca contra
   la DB app del runtime; sin borrar auditoría.
3. Adaptador Yahoo **en vivo sin fixtures**: precio último de sesión, `previousClose` de la sesión
   anterior, fecha de fuente (no instantáneo); medir cobertura de tickers del catálogo (sin mapping);
   rate-limit/timeout → 503 `MARKET_DATA_SERVICE_UNAVAILABLE` real.
4. Si Yahoo externo no está disponible desde esta red: reportar **BLOQUEO de precio en real** — no
   fingir que el verde unitario demuestra conexión ni aflojar tests. Suite completa independiente y
   fixtures offline documentados para CI.

**Gate G5 (padre/QA):** evidencia de endpoints, cobertura de catálogo medida, estado real de Yahoo,
y suite completa verde contra la DB de test.

### A6 — Loop de ajustes por fallos comprobados

Dueño: DS en el scope dueño del archivo fallado. Para cada fallo comprobado: issue con repro mínimo →
archivo owner → rojo → fix de 1–2 archivos → verde + gate re-corrido por el padre. Prohibido refactor
general o diseño nuevo; si el fix requiere dependencia nueva, cambio de contrato, migración distinta o
altera saldos: **volver a humano**. QA independiente final antes de cerrar.

**Gate final (padre):** main limpio y mergeado; `PROGRESS.md` escrito por el padre; evidencia reunida:
SHA mergeado, migraciones aplicadas + URL de la DB app, PID/puerto/log de la API, gates con outputs
reales, enlace/estado de la API local. Sin push remoto sin pedido.

## Puntos de parada (detener y escalar, nunca continuar)

1. Anomalía financiera en el inventario A0 (valores imposibles, audit truncada, montos canónicos que
   no cierran).
2. Writer/PID desconocido conectado a la DB destino.
3. Legacy sin history de Prisma o DDL divergente (sin `migrate resolve` automático).
4. Cualquier fix que exija dependencia nueva, cambio de contrato firmado, migración distinta o altere
   saldos.
5. Yahoo externo no disponible: se reporta BLOQUEO, no se finge verificación.
6. Conteo de escenarios previos (< 515) cayendo sin cambio UC-2 aprobado.

## Aceptación verificable

1. UC-2 Rev. 2 integrado sobre grandes montos sin borrar migración/spec/tests de D1–D5; los 515
   escenarios previos preservados (conteo medido, no hardcodeado).
2. Contratos reconciliados: dinero string / `FinancialDecimal` 64 / size cash string / quantity string
   conviven con default 10, omisión de faltantes y 503 de UC-2.
3. DB app local (`cocos_challenge` en 5433, si el validador confirma) migrada con `migrate deploy`,
   history consistente, CHECKs financieros reales en PostgreSQL, segundo deploy idempotente.
4. API local viva al fin de la célula (PID/puerto/log verificados por el padre), conectada a la DB app
   confirmada dentro del proceso.
5. Smoke HTTP real: read-only sobre DB app; escrituras en copia de test; Yahoo en vivo con veredicto
   honesto (cobertura medida o BLOQUEO declarado).
6. Gates G0–G5 con outputs reales pegados; QA independiente ACCEPT sin bloqueantes antes de cada merge
   a main; main limpio; sin push sin pedido.

## Pendientes de humano (sólo operativos; ninguna decisión firmada se reabre)

- Validar/ajustar este plan Rev. 1 y marcarlo aprobado.
- Confirmar topología operativa: reutilizar `~/.pg/cocos` en 5433, nombre de DB app
  (`cocos_challenge`), puerto 3000, y las rutas de worktree/ramas propuestas.
- Confirmar si la DB app existe y si se permite seed en caso de crearla vacía.
- Aprobar cada gate G0–G5 y la ventana de pausa de escrituras de A3.
- Ordenar el push/remoto si se quiere (nunca por defecto).
