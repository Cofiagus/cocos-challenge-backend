---
id: limpieza-final-2026-11-06
title: Plan de limpieza final y entrega
status: PLAN FIRMADO — EN EJECUCIÓN
rev: 1
fecha: 2026-11-06
owner: cofi (humano) · orquestador: Hermes
---

# Plan de limpieza final y entrega — `cocos-challenge-backend`

## Why

El repo está funcional y verde (49 suites / 656 tests, typecheck y lint limpios), pero la
auditoría del 2026-11-06 detectó **7 defectos** —2 de ellos verificados ejecutando— y **docu-
mentación/specs que mienten sobre el estado real**. El objetivo de hoy es dejarlo
**entregable**: sin bugs conocidos, con un único estado verdadero y una documentación que
cualquier lector nuevo entienda sin ayuda.

## What (alcance)

Cerrar **7 defectos (D-01…D-07)**, resolver **12 ítems de deuda (E-01…E-12)**, corregir
**10 defectos documentales (DOC-01…DOC-10)**, podar `specs/` de 9 a 3 archivos vivos y
dejar el repo con gates verdes, ramas limpias y PRs separados por etapa.

## Constraints (qué NO)

1. **No** aplicar migraciones a la DB de la app sin el backup `pg_dump` previo y verificado.
   *(Autorizado explícitamente por el humano para la DB local.)*
2. **No** cambiar la semántica del dinero: sigue entrando como string y saliendo como string
   de 2 decimales. Nada de `Float`, `parseFloat` ni `Number()` sobre plata.
3. **No** cambiar el contrato público salvo donde el plan lo firma (sólo se agregan códigos de
   error y se corrige el path de health).
4. **No** desactivar reglas de ESLint para pasar un gate. Superar un umbral ⇒ extraer función.
5. **No** tocar `src/http/server.ts` ni `src/index.ts` salvo la célula que los tiene asignados.
6. **No** editar tests de otra célula para que pasen. Rojo ajeno ⇒ reportar `OPEN`.
7. **No** regenerar `openapi.json` salvo la célula dueña en esa etapa.

---

## Mapa de fases y paralelismo

```
FASE 0  SNAPSHOT            [orquestador]        ~10 min
   │
FASE 1  BUGS P0   ┌ f1-edge ─┐                  ~60 min
                  ├ f1-idem ─┤ 4 células        (paralelo)
                  ├ f1-time ─┤
                  └ f1-num  ─┘
   │ GATE 1: typecheck + lint + suite completa
FASE 2  ROBUSTEZ  ┌ f2-errors  ─┐               ~60 min
                  ├ f2-uc2    ──┤ 3 células     (paralelo)
                  └ f2-migrate ─┘
   │ GATE 2
FASE 3  DEUDA      ┌ f3-app    ─┐               ~90 min
                   └ f3-clean  ─┘ 2 células     (paralelo)
   │ GATE 3
FASE 4  DOCS      ┌ f4-readme ─┐                ~90 min
                  ├ f4-docs   ─┤ 3 células      (paralelo)
                  └ f4-specs  ─┘
   │ GATE 4
FASE 5  CIERRE                [orquestador]       ~30 min
        gate final + ramas + PRs por etapa
```

**Regla de despacho:** máximo **4 células en vuelo**. Una fase no arranca hasta que el gate
de la anterior esté verde y mergeado en `main`.

### Matriz de rutas (cada célula escribe SÓLO las suyas)

| Ruta | F1-edge | F1-idem | F1-time | F1-num | F2-errors | F2-uc2 | F2-mig | F3-app | F3-clean | F4-readme | F4-docs | F4-specs |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `src/contracts/money.ts` | | | | | | | | | ✎ | | | |
| `src/contracts/portfolio.ts` | | | | ✎ | | | | | ✎ | | | |
| `src/contracts/orders.ts` | | | | ✎ | | | | | ✎ | | | |
| `src/contracts/errors.ts` | | | | | ✎ | | | | | | | |
| `src/contracts/index.ts` | | | | | | | | | ✎ | | | |
| `src/domain/matching/index.ts` | | | | ✎ | | | | | | | | |
| `src/application/orders/decide-order.ts` | | ✎ | | ✎ | | | | ✎ | | | |
| `src/application/orders/persist-order-decision.ts` | | ✎ | | | | | | ✎ | | | |
| `src/application/orders/submit-order.ts` | | ✎ | | | | | | ✎ | | | |
| `src/application/cancel/**` · `transfers/**` · `portfolio/**` | | | | | | | | ✎ | | | |
| `src/application/instruments/**` · `src/infra/yahoo/**` | | | | | | ✎ | | | | | | |
| `src/http/shared/edge.ts` | ✎ | | | | ✎ | | | ✎ | | | |
| `src/http/error-handler.ts` | ✎ | | | | ✎ | | | | | | | |
| `src/index.ts` · `docker-compose.yml` · `.env*.example` | | | ✎ | | | | | | | | | |
| `prisma/**` (DB app) | | | | | | | ✎ | | | | | |
| `openapi.json` | | | | | | | | | | | | |   ← **lo regenera el ORQUESTADOR en el gate de cada fase**
| `tests/unit/http/**` | ✎ | | ✎ | | ✎ | | | | | | |
| `tests/unit/application/**` | | ✎ | | ✎ | | ✎ | | ✎ | ✎ | | |
| `tests/functional/**` | | ✎ | | | | ✎ | | ✎ | | | |
| `tests/integration/**` | | ✎ | | | | | ✎ | | | | | |
| `tests/docs/**` | | | | ✎ | ✎ | | | | ✎ | ✎ | ✎ | ✎ |
| `README.md` · `DECISIONS.md` | | | | | | | | | | ✎ | | |
| `docs/database.md` | | | ✎ | | | | ✎ | | | | ✎ | |
| `docs/api.md` · `docs/legacy.md` | | | | | | | | | | | ✎ | |
| `specs/**` · `docs/references/**` | | | | | | | | | | | | ✎ |

> **CODEMAP:** cada célula actualiza **sólo las filas de `docs/CODEMAP.md` correspondientes a
> sus propios archivos** (renombres, exports agregados/eliminados). La guardia D1–D3 falla si no.
> Una etapa de reconciliación final (Fase 5) verifica 48/48.

---

# FASE 0 — Snapshot y andamiaje

**Ejecuta:** orquestador · **~10 min** · **Gate G0**

| Paso | Comando / acción | Criterio |
|---|---|---|
| 0.1 | `git add -A && git commit -m "chore: snapshot pre-limpieza-final"` | índice limpio |
| 0.2 | `git tag -a audit-2026-11-06 -m "Auditoría: 7 defectos, 12 deudas, 10 defectos docu"` | tag creado |
| 0.3 | `git branch backup/pre-limpieza-final-20261106` | rama de respaldo |
| 0.4 | Backup privado de `.env` y `.env.test` fuera del repo, con SHA256 verificado (NO commitear, NO imprimir) | 2 archivos copiados |
| 0.5 | `npm run test:db:reset` | DB de test normalizada |
| 0.6 | Gate G0: `npm run typecheck && npm run lint` | exit 0 |

**Regla de trabajo por célula** (se copia en cada brief):

```
worktree:  git worktree add ../coccb-wt-<celula> -b <rama> main
setup:     cd ../coccb-wt-<celula> && npm ci && npx prisma generate
primer comando de CADA terminal: cd <worktree-absoluto> && pwd && git branch --show-current
tests:     correr SOLO el patrón propio (npm test -- <ruta>), nunca la suite completa
commits:   chicos, uno por tarea atómica
prohibido: tocar rutas ajenas · desactivar reglas ESLint · editar tests ajenos · crear skills
```

⚠️ **Pitfall crítico:** nunca symlinear `node_modules` al worktree. Al hacer
`git worktree remove --force` puede vaciar el `node_modules` real del repo principal.
Antes de remover un worktree: `rm -f <wt>/node_modules`.

---

# FASE 1 — BUGS P0

4 células en paralelo. **Gate G1** al cerrar.

---

## F1-EDGE · Borde HTTP y errores transversales

**Rama:** `fase-1-edge` · **Worktree:** `../coccb-wt-edge` · **Timebox:** 45 min

**Rutas propias:** `src/http/shared/edge.ts` · `src/http/error-handler.ts` ·
`src/contracts/errors.ts` · `tests/unit/http/**`

**Contexto (verificado):**
- `edge.ts:169-179` — `toHttpError` enumera **a mano** las clases de error.
- Confirmado: ni `error-handler.ts` ni `edge.ts` clasifican `57014` / `P2028` / pool-timeout.
- `src/lib/prisma-client.ts` configura `statement_timeout`; esperar el advisory lock dispara
  SQLSTATE `57014` ⇒ hoy cae en **500 `INTERNAL_ERROR`**.
- Express 5 no propaga automáticamente errores async ⇒ verificar que el wrapper cubre todo.

**Tareas atómicas (un commit cada una):**

1. Agregar al enum de códigos de error un código para degradación del proveedor de datos y uno
   para contención (ver `API_ERROR_CODES` y la tabla de 12 códigos en `docs/api.md`; mantener la
   tabla exacta, la guardia la compara).
   - **NOTA:** este cambio altera el contrato ⇒ `openapi.json` lo regenera **F1-NUM** (dueña en Fase 1).
     Reportar `NEEDS_OPENAPI_REGEN: yes` al cerrar.
2. Clasificar timeout/lock en `toHttpError` y en el manejador: `57014`, `P2028`, `ETIMEDOUT`,
   pool-timeout ⇒ **503** con `Retry-After`. Nunca 500.
3. Asegurar que la traducción preserve `{ error: { code, message } }` (contrato uniforme) y que
   ningún camino nuevo arme su propio 500.

**Criterios de aceptación:**
- Un `statement_timeout` real responde 503, no 500.
- El body mantiene exactamente `{ error: { code, message } }`.
- Cero `any`; cero `eslint-disable`.

**VERIFY:**
```bash
cd <worktree> && npm run typecheck && npm run lint && npm test -- tests/unit/http
```

---

## F1-IDEM · Idempotencia de persistencia (replay que no pierde información)

**Rama:** `fase-1-idem` · **Worktree:** `../coccb-wt-idem` · **Timebox:** 60 min

**Rutas propias:** `src/application/orders/persist-order-decision.ts` ·
`src/application/orders/submit-order.ts` · `src/infra/prisma/order-repository.ts` ·
`src/infra/prisma/cash-idempotency.ts` · `tests/unit/application/**` ·
`tests/functional/orders-submit/**` · `tests/integration/infra/**`

**Contexto (verificado):**
```ts
// src/application/orders/persist-order-decision.ts:134-138
if (created.outcome === "IDEMPOTENT_REPLAY") {
  // …(el reason del original vive en order_events)
  return { order: created.order, reason: null };
}
```
`OrderResponse.reason` es `OrderRejectionReasonSchema.nullable()` (`contracts/orders.ts:138`),
así que tipa — pero **misma key ⇒ cuerpo distinto**, contra la promesa documentada
"devuelve la orden original".
Además `R-02`: el monto original del cash vive sólo en `metadata` de auditoría, no en
`requestFingerprint`, lo que debilita la detección de conflicto.

**Tareas:**

1. En el camino de replay, recuperar la razón desde el evento de origen (~1 query extra,
   sólo ejecutada en replay) y devolverla. Actualizar el test que hoy **documenta el defecto
   como esperado**.
2. Incluir el monto original del cash en la huella del request (`request-fingerprint.ts`),
   preservando la comparación estricta de evidencia histórica de `cash-idempotency.ts`.
3. Mantener invariante: **el replay nunca acredita ni revierte plata**.

**Criterios:**
- Replay de una REJECTED devuelve la misma `reason` que el original (test funcional).
- Doble submit concurrente ⇒ exactamente UNA escritura y UN evento (ya existe; no regredir).

**VERIFY:**
```bash
cd <worktree> && npm run typecheck && npm run lint && \
  npm test -- tests/unit/application && npm test -- tests/functional/orders-submit
```

---

## F1-TIME · Zona horaria del proceso (D-01)

**Rama:** `fase-1-time` · **Worktree:** `../coccb-wt-time` · **Timebox:** 45 min

**Rutas propias:** `src/index.ts` · `docker-compose.yml` · `.env.example` ·
`.env.test.example` · `package.json` · `docs/database.md` (sólo la fila de TZ) ·
`tests/unit/contracts-*`

**Contexto (VERIFICADO, medición real):**
```
### TZ del sistema (ART, offset +180) ###
{ id: 5, datetime: 'Wed Jul 12 2023 12:14:20 GMT-0300 (Argentina Standard Time)' }
### con TZ=UTC ###
{ id: 5, datetime: 'Wed Jul 12 2023 15:14:20 GMT+0000 (Coordinated Universal Time)' }
```
`db/seed.sql:93` ⇒ orden `id 5` = `2023-07-12 15:14:20`.
`@prisma/adapter-pg` interpreta `timestamp without time zone` como **UTC**;
`serializeLocalTimestamp` re-serializa desde componentes **locales** ⇒ desplazamiento de 3 h.
Y **no hay TZ fijada en ningún artefacto versionado** (grep limpio).

**Decisión firmada:** fijar **UTC** (coincide con el texto del dataset y unifica la columna).

**Tareas:**
1. Fijar `process.env.TZ = "UTC"` al inicio de `src/index.ts` (antes de cualquier import que
   cachee la TZ), con comentario que explique **por qué**.
2. `TZ=UTC` en `docker-compose.yml` y en los `*.example`.
3. Propagar `TZ=UTC` a los scripts de `package.json` si hace falta para que CI y local
   coincidan.
4. Documentar en `docs/database.md`: "`timestamp without time zone` se lee como UTC".
5. Test de invariancia: `serializeLocalTimestamp` debe dar el mismo resultado con
   `TZ=UTC`, `TZ=America/Argentina/Buenos_Aires` y `TZ=Asia/Tokyo`.

**VERIFY:**
```bash
cd <worktree> && npm run typecheck && npm run lint && npm test -- tests/unit/contracts
TZ=UTC npm test -- tests/unit/contracts && TZ=Asia/Tokyo npm test -- tests/unit/contracts
```

---

## F1-NUM · Cotas numéricas e invariante de precio (D-06, D-07)

**Rama:** `fase-1-num` · **Worktree:** `../coccb-wt-num` · **Timebox:** 60 min
**No edita `openapi.json`:** lo regenera el orquestador en el gate (ver §Ownership).

**Rutas propias:** `src/contracts/orders.ts` · `src/contracts/portfolio.ts` ·
`src/domain/matching/index.ts` · `src/application/orders/decide-order.ts` ·
`tests/unit/**` · `openapi.json`

**Contexto:**
- `contracts/orders.ts:33-36` ya documenta el patrón a seguir: *"Sin esta cota el valor pasa
  Zod y llega como 500 del INSERT en vez de 400"* — pero la cota existe **sólo para `size`**.
  `userId` / `orderId` / `instrumentId` pasan hasta 2^53−1 y golpean columnas `Int` (int4).
  ⚠️ **No confirmado end-to-end por el supervisor** (la célula de auditoría no pudo, `P1001`);
  verificar primero y reportar la medición.
- `evaluateCross` no exige precio de referencia `> 0`: con `ref = 0.00` devuelve `FILLED` a `0.00`.
  `marketdata.close` admite `0` (CHECK `>= 0`) pero `orders.filledPrice` exige `> 0`.

**Tareas:**
1. **Verificar** el 500 real con un id fuera de INT4 contra la DB de test; pegar SQLSTATE.
2. Extraer un `PositiveIntParam` compartido (cota 1..2147483647) y usarlo en los 3 identificadores
   de los routers/contratos afectados ⇒ 400 (o 404) en vez de 500.
3. Invariante `precio de referencia > 0` en la decisión: si no hay precio válido ⇒ `REJECTED` con la
   razón correspondiente, nunca FILL a 0.

**VERIFY:**
```bash
cd <worktree> && npm run typecheck && npm run lint && npm test -- tests/unit
npm run openapi && git diff --stat openapi.json   # debe quedar determinista
```

---

# FASE 2 — ROBUSTEZ (P1)

3 células en paralelo. **Gate G2**.

> ⚠️ **F2-MIGRATE toca la DB de la app.** Requiere backup `pg_dump` verificado ANTES.

---

## F2-ERRORS · La otra mitad del borde

**Rama:** `fase-2-errors` · **Timebox:** 45 min
**Depende de:** F1-EDGE mergeado (ambos tocan `edge.ts`/`error-handler.ts`).

**Rutas propias:** `src/http/shared/edge.ts` · `src/http/error-handler.ts` ·
`src/contracts/errors.ts` · `tests/unit/http/**`

**Tareas:** idempotencia gestionada por la API (ver decisión firmada abajo), robustez de headers
duplicados, y cualquier hueco de `toHttpError` que F1-EDGE no haya cubierto.

### Decisión firmada sobre la `Idempotency-Key`

> El humano: *"el usuario no debería tener control sobre la key, nosotros a nivel de API
> deberíamos gestionarlo (…) está bien que sea opcional ya que es una extensión del challenge
> (…) si podemos manejarlo internamente a nivel de API como una mejora, joya"*.

Por tanto:

1. **El contrato NO cambia:** el header sigue siendo opcional.
2. **Mejora interna (D6):** cuando el cliente NO envía `Idempotency-Key`, la API **deriva** una
   clave internamente a partir de la huella canónica del request (usuario · instrumento · side ·
   type · timeInForce · dinero · tamaño). Así un retry exacto es seguro **sin exigir nada al
   cliente**.
3. **Guarda obligatoria antes de implementar:** comprobar si algún test existente envía **dos
   payloads idénticos sin key** esperando dos órdenes distintas. **Si existe ⇒ NO derivar
   automáticamente**; reportar `QUESTION: A) derivar igual y ajustar el test B) dejar opcional sin
   derivación` y seguir con el resto.
4. Header **duplicado** ⇒ **400** (detectar con `req.rawHeaders`; la rama `Array.isArray` de
   `edge.ts:54` es código muerto porque Node une con `", "`).

---

## F2-UC2 · Robustez de UC-2 (E-07, E-08)

**Rama:** `fase-2-uc2` · **Timebox:** 60 min

**Rutas propias:** `src/application/instruments/search-instruments.ts` ·
`src/infra/yahoo/yahoo-instrument-quote-source.ts` ·
`src/http/instruments/instruments-router.ts` · `tests/unit/**`

**Tareas:**
1. `AbortSignal` propagado al presupuesto: al vencer el deadline, **cancelar** el trabajo en vuelo
   en vez de abandonarlo. Sin leaks (verificar con `--detectOpenHandles`).
2. **Tope de candidatos**: acotar cuántos tickers se exploran para rellenar el cupo, evitando
   recorrer el catálogo completo.
3. **Deadline que escale con `limit`**: hoy `limit=100` con concurrencia 4 ⇒ 25 rondas ⇒
   ~320 ms/call de margen antes de 503. Escalar el presupuesto con el tamaño del cupo.
4. `User-Agent` en las llamadas a Yahoo (mitiga 429 medidos) y registro del motivo del 429.

**VERIFY:**
```bash
cd <worktree> && npm run typecheck && npm run lint && \
  npm test -- tests/unit/application/search-instruments && \
  npm test -- tests/unit/infra/yahoo && npm test -- tests/unit/http/instruments-search
```

---

## F2-MIGRATE · Deriva de esquema (2 de 4 migraciones aplicadas)

**Rama:** `fase-2-migrate` · **Timebox:** 45 min
**Autorizado por el humano para la DB local de la app.**

**Estado verificado:**
```bash
$ ls prisma/migrations
20261103003419_init_trading_api                 ✔ aplicada
20261105104903_large_money                      ✔ aplicada
20261106154910_db_integrity_constraints         ✘ pendiente
20261106180000_db_write_invariants              ✘ pendiente (+ trigger price→filledPrice)
$ psql "$URL" -tAc "select migration_name from _prisma_migrations where finished_at is not null"
20261103003419_init_trading_api
20261105104903_large_money
```

**Tareas (en orden, una por commit):**
1. Backup: `pg_dump` de la DB de la app a un path privado **fuera** del repo. Verificar bytes y
   permisos antes de continuar.
2. Verificar compatibilidad de datos contra los CHECKs nuevos (órdenes FILLED sin `filledPrice`,
   `size = 0` fuera de REJECTED, precios unitarios de cash ≠ 1.00). Reportar el conteo exacto.
3. Aplicar con `npx prisma migrate deploy` (NO `dev`, NO editar migraciones aplicadas).
4. Verificar: 10 CHECKs presentes + trigger activo + `_prisma_migrations` con 4 filas y 0
   `rolled_back_at`.
5. Actualizar `docs/database.md` con las 4 migraciones.

**⛔ BLOCKER (no forzar):** si algún CHECK falla por datos existentes ⇒ **parar**, no
"arreglar" datos a mano, y reportar el SQLSTATE y el plan propuesto. Se resuelve post-entrega.

---

# FASE 3 — DEUDA INTERNA (P2, sin cambio de contrato)

2 células en paralelo. **Gate G3**.

---

## F3-APP · Consolidar la capa de aplicación (E-01, E-02, E-03, E-04-application)

**Rama:** `fase-3-app` · **Timebox:** 90 min

**Rutas propias:** `src/application/**` · filas de CODEMAP §6

**Contexto (verificado):**
- **E-01** — la regla *cash disponible = settled − reservado* está en 3 archivos:
  `src/application/portfolio/get-portfolio.ts:171`, `src/application/orders/decide-order.ts:209`,
  `src/application/transfers/submit-transfer.ts:253`. Es la regla de dinero más delicada del
  sistema: debe quedar en **una sola función del dominio puro**.
- **E-02** — `SubmitOrderError` (`submit-order.ts:69`), `CancelOrderError` (`cancel-order.ts:36`),
  `SubmitTransferError` (`submit-transfer.ts:69`) son **idénticas**, y `toHttpError`
  (`edge.ts:170-174`) las enumera a mano.
- **E-03** — dos `buildAuditBase` / `buildDraftBase` con el mismo nombre y semántica distinta.

**Tareas:**
1. Extraer la regla de cash disponible al dominio puro (`src/domain/portfolio/index.ts`) y
   reemplazar las 3 copias por esa función. Sin cambio de comportamiento (los goldens
   889756 / 627500 / 125500 deben seguir dando igual).
2. Un único `ApplicationError(status, code, message)` en la capa de aplicación; las 3 clases
   pasan a ser alias finos o desaparecen.
3. Renombrar los `build*Base` duplicados con nombres que digan la unidad/propósito.
4. Podar exports muertos de `src/application/**`.

**VERIFY:**
```bash
cd <worktree> && npm run typecheck && npm run lint && \
  npm test -- tests/unit/application && npm test -- tests/unit/domain
```

---

## F3-CLEAN · Verdad de los contratos monetarios y limpieza (E-04, E-05, E-06)

**Rama:** `fase-3-clean` · **Timebox:** 90 min · **Dueña de `openapi.json` en esta fase**
**No edita `openapi.json`:** lo regenera el orquestador en el gate (ver §Ownership).

**Rutas propias:** `src/contracts/money.ts` · `src/contracts/portfolio.ts` ·
`src/contracts/index.ts` · `src/infra/prisma/mappers.ts` · `openapi.json` · CODEMAP §3/§8

**Contexto:**
- `serializePct` acepta el `Decimal` **global** (prohibido por contrato).
- Las marcas `MoneyArs` / `Pct` se borran en las respuestas: `z.infer` devuelve `string` ⇒
  la marca no protege nada.
- `PortfolioPositionSchema` es el único `z.object` **no estricto** ⇒ OpenAPI sin
  `additionalProperties: false`.

**Tareas:**
1. `serializePct` acepta **sólo `FinancialDecimal`** (y `serializeMoneyArs` igual, si aplica).
2. **O** dotar de marca real (nominal, no estructural) **O** eliminarla explícitamente y
   documentar por qué. No dejar una marca que no garantiza nada.
3. `strictObject` en `PortfolioPositionSchema`.
4. Podar exports muertos de `src/contracts/**` e `src/infra/**`.

**VERIFY:**
```bash
cd <worktree> && npm run typecheck && npm run lint && npm test -- tests/unit && \
  npm test -- tests/unit/contracts
```

---

# FASE 4 — DOCUMENTACIÓN

3 células en paralelo. **Gate G4**.
**Regla:** el último commit de documentación pone los **números de la corrida final** (Fase 5),
no los de la corrida intermedia.

---

## F4-README · README minimal + DECISIONS como ADR

**Rama:** `fase-4-readme` · **Timebox:** 90 min

**Tareas:**
1. **README → ~60 líneas:** qué es la API · los 5 endpoints · cómo levantarla (4 comandos) ·
   link a `docs/api.md` / `openapi.json` · link a `DECISIONS.md`. Nada más.
2. **Eliminar la duplicación normativa:** hoy `DECISIONS.md` y README §Supuestos son **dos listas
   de las mismas ~30 reglas** (viola `AGENTS.md` §6.4). README §Supuestos pasa a ser un resumen
   de 5-10 ítems + link a `DECISIONS.md`.
3. **DECISIONS → ADR numerado** (`D1`, `D2`, … `D6`): contexto · decisión · consecuencias.
   La nueva D6 documenta la idempotencia gestionada por la API (ver Fase 2).
4. **Corregir conteos:** README hoy dice **44 suites / 596 tests** y **30/386**. Medido:
   **49/656** y **34/431**. Dejar los números de la corrida final de la Fase 5.

---

## F4-DOCS · `docs/` al día

**Rama:** `fase-4-docs` · **Timebox:** 90 min

**Tareas:**
1. **`docs/database.md`:** documentar las **4** migraciones (hoy describe 2) + la semántica UTC
   de `timestamp without time zone` (coordinar con F1-TIME).
2. **Podar Neon:** `database.md` §5 son 55 líneas sobre un proveedor (Neon/IPv6/91 s) que
   `runtime-db-cleanup` ya eliminó.
3. **Unificar el estado de Yahoo:** hoy hay tres versiones — `api.md:62` "no se probó en vivo" vs
   `README.md:140` y PROGRESS G5 "61/65 verificado" vs `legacy.md:15` que tercia en contra.
   **Una sola versión verdadera.**
4. **Documentar el riesgo de Yahoo** (DOC-10): sin User-Agent, sin reintentos, 429 medidos dos veces
   con resultados contradictorios y decisión de no mitigar. Debe quedar en un doc normativo.

---

## F4-SPECS · Podar `specs/` y corregir la fuente de verdad

**Rama:** `fase-4-specs` · **Timebox:** 90 min

**Inventario y veredicto:**

| Spec | Veredicto | Acción concreta |
|---|---|---|
| `trading-api-domain.md` | **QUEDA** (corregida) | Corregir la fórmula del patrimonio (§ abajo) y podar `DAY`, `EXPIRED`, `price_ticks`, `yahoo-finance2` |
| `datos-financieros-grandes-montos.md` | **QUEDA** (banner) | Encabezado: "EJECUTADA — D1–D5 vigentes" + fecha |
| `instruments-current-quotes.md` | **QUEDA** (banner) | Encabezado: "EJECUTADA" + fecha |
| `agentificacion-docs.md` | **ARCHIVAR** | → `docs/references/`. Fija el dinero como **número JSON**, contrario al contrato vigente. Es el origen de las refs "P2" a `docs/use-cases.md` y `docs/testing.md`, **que no existen** |
| `plan-mejoras-db.md` | **ARCHIVAR** | Su contenido ya se ejecutó (migraciones 3 y 4) |
| `remediacion-revision-calidad.md` | **ARCHIVAR** | Mergeada; quitarle el rótulo `"BORRADOR — requiere aprobación"` |
| `remediacion-wave-4.md` | **ARCHIVAR** | Ídem |
| `runtime-db-cleanup.md` | **ARCHIVAR** | Ejecutada (eliminó Neon) |
| `integracion-instrumentos-despliegue-local.md` | **ARCHIVAR** | Histórico del rollout → `docs/references/` |

**Borrar:** `docs/references/informe-estandares-ai-first-cocos-backend.md`
(245 líneas huérfanas, 0 referencias entrantes).

**Corrección obligatoria — la fórmula del patrimonio** (`specs/trading-api-domain.md:164-165`):

Hoy dice: `totalAccountValue = cash + Σ valor de mercado`, donde ese `cash` es el **disponible**
("ya descontadas reservas") ⇒ omite `reservedCash`. Aritmética con los goldens del seed:

```
cashSettled       = 753000        (= disponible 627500 + reservado 125500)
Σ marketValue     = 136756
correcto (código) = 753000 + 136756 = 889756  ✅
según la letra    = 627500 + 136756 = 764256  ❌
```

Reescribir como: `totalAccountValue = cashSettled (disponible + reservado) + Σ valor de mercado`
y aclarar la diferencia entre `cash` (disponible) y `cashSettled` en la salida.

---

# FASE 5 — CIERRE

**Ejecuta:** orquestador · **~30 min**

1. `npm run test:db:reset` con el `TEST_DB_NAME` de cada suite.
2. Gate final:
   ```bash
   npm run typecheck && npm run lint && npm test -- --runInBand --detectOpenHandles
   ```
3. **Reconciliar conteos reales** en README (`Tests` §) con esta corrida — son los únicos números
   que deben quedar.
4. **CODEMAP**: verificar 48/48 archivos y que ningún export inventado quede listado
   (guardia D1–D3 verde).
5. **PRs separados por etapa** (5 PRs: F1, F2, F3, F4 y CIERRE), cada uno con su gate pegado.
6. **Limpieza de ramas:** borrar `cell/*` ya integradas; **conservar** `backup/*`.
7. Merge a `main` **sólo** tras revisión del orquestador + confirmación explícita del humano.

---

## Orden de recorte si falta tiempo

Cortar **de abajo hacia arriba**. Irrenunciables (nunca se recortan): **D-01 … D-05** y **DOC-02**.

| Prioridad | Contenido |
|---|---|
| 🔴 Irrenunciable | D-01 (TZ), D-02 (OpenAPI health), D-03 (503), D-04 (idempotencia), D-05 (replay), DOC-02 (conteos) |
| 🟠 Alta | D-06, D-07, E-05, E-06, DOC-03, DOC-05, DOC-06 |
| 🟡 Media | E-07, E-08, E-01, E-02, DOC-04, DOC-08, DOC-09, DOC-10 |
| 🟢 Baja | E-03, E-04, E-09, E-10, poda de specs, limpieza de ramas |

## Deuda declarada que NO se toca (está documentada como tal)

- `src/infra/prisma/marketdata-price-source.ts` — implementa `PriceSource` y nadie lo cablea
  (punto de enchufe deliberado del matching).
- Sin `CHECK` de transiciones de estado: la guarda es de la aplicación, por diseño.

## Fuera de alcance

- Confirmar end-to-end D-06 si los datos no lo permiten (se reporta como limitación).
- `collection/` salvo el conteo de tests (DOC-02).
- Reescribir la suite: sólo se agregan tests por criterio de aceptación.
