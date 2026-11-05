# Agentificación de la documentación — docs como fuente de verdad operativa

> Estado: **BORRADOR — A1 y A2 resueltos por el humano (2026-11-03); A3 pendiente.**
> A1: dinero = número JSON con 2 decimales (se alinea la regla escrita al código).
> A2: OpenAPI 3.1 **generado desde los schemas Zod** (`z.toJSONSchema`, sin dependencias nuevas):
> el contrato machine-readable es un artefacto derivado, no una copia a mano.
> Fuente del diagnóstico: `AGENTS.md`, `README.md`, `DECISIONS.md`, `PROGRESS.md`, `docs/**`,
> `src/**` (35 archivos), `tests/**` (27 archivos), `jest.config.js`, `tsconfig.json`, `Makefile`.
> Alcance: **sólo documentación + un test estático**. No toca runtime.

## Estado de ejecución

| pieza | estado | verificación |
|---|---|---|
| `docs/CODEMAP.md` (T1) | **hecho** — 166 líneas, 35 archivos, 6 capas | `npx jest tests/docs` (4/4) |
| `tests/docs/docs-consistency.test.ts` D1–D3 (T3) | **hecho** — incluye `AGENTS.md` en D1 | prueba negativa: archivo fantasma en `src/` ⇒ D2 falla |
| `AGENTS.md` (T2) | **hecho** — reescrito (estructura, comandos, protocolo, reglas A1) | D1 verde |
| T11 (`tsconfig`) | **hecho** — fuera los aliases `@/*` muertos y los flags de decoradores | `tsc` + 163 tests verdes |
| T12 (headers de `src/`) | **hecho** — los 35 archivos sin vocabulario de fases/células | `grep -rE "FASE \d\|Célula\|orquestador" src` vacío |
| T9/T10 (banners) | **hecho** — `PROGRESS.md` histórico + glosario, `specs/*` con estado real, HTML etiquetado como objetivo | lectura |
| T4a (schemas representables) | **hecho** — `money.ts` con `z.number()` + `.meta()`, validación idéntica | `z.toJSONSchema` OK; 168 tests |
| T4b/T4c (generador + `api.md`) | **hecho** — `npm run openapi` → `openapi.json` (5 operaciones, 3.1) + `docs/api.md` en prosa | 9 tests de contrato |
| T4d (deriva) | **hecho** — `tests/docs/openapi.test.ts` D4a–D7 | 5 tests |
| new: `docs/legacy.md` | **hecho** — qué está deprecado y qué usar en su lugar | D1 |
| T5 (DECISIONS promovido) | pendiente (P1) | — |
| T7/T8 (use-cases, testing) | pendiente (P2) | — |

## Why

Hoy iterar es caro porque los MD no son confiables y la única forma de responder una pregunta
es leer código:

- `AGENTS.md` describe una estructura que **no existe** (vertical slices `src/<dominio>/*.routes.ts`)
  y manda a leer `docs/CODEMAP.md`, que **no existe**.
- Las mismas reglas viven en **tres lugares** con distinto nivel de detalle y ya divergieron:
  `DECISIONS.md` (23 bullets, sin porqué) · `README.md` §Supuestos (27 puntos, con porqué) ·
  `AGENTS.md` §Reglas financieras (8 reglas, dos de ellas **contradichas por el código**:
  dinero como string/integer vs `number` JSON, y `CHECK` de estados en DB que no está en la migración).
- `PROGRESS.md` (tabla de células) dice que el build está incompleto; git dice que terminó.
- `docs/arquitectura-componentes.html` dibuja Yahoo, cron, `price_ticks` y sweep: nada de eso existe.
- `tsconfig.json` declara aliases `@/services`, `@/controllers`, `@/middleware` para directorios
  inexistentes: un agente puede crear código ahí "porque el config lo sugiere".

Consecuencia medible: para responder "¿qué devuelve POST /orders si no hay marketdata?" un agente
hoy lee 3–5 archivos (routers + use case + contracts + repo). El objetivo es que esa respuesta
esté en **un** documento normativo, y que el documento no pueda quedar desactualizado en silencio.

## What

**Principio: una pregunta → un documento dueño.** Cada archivo declara qué preguntas responde y
cuáles NO; nadie duplica una regla. Lo que se agrega:

| # | Artefacto | Dueño único de | Estado |
|---|---|---|---|
| 1 | `AGENTS.md` (reescritura) | proceso: comandos reales, estructura real, protocolo de lectura, límites, tabla "pregunta → doc" | reescribir |
| 2 | `docs/CODEMAP.md` | topología: archivo → responsabilidad → exports/firmas → quién llama → test que lo cubre | **nuevo** |
| 3 | `openapi.json` (generado) + `docs/api.md` (prosa) | contrato de cable: el JSON Schema de cada request/response y los status/códigos viven en `openapi.json`; `api.md` sólo aporta semántica, ejemplos y cuándo usar cada endpoint | **nuevos** |
| 4 | `docs/use-cases.md` | flujo: UC-1..UC-5, orden de pasos, frontera de transacción, transiciones, matriz de decisión | **nuevo** |
| 5 | `docs/testing.md` | verificación: suites, DBs, fixtures, correr una suite, trampas de Jest | **nuevo** |
| 6 | `DECISIONS.md` (promoción) | negocio: reglas con porqué (absorbe README §Supuestos) | reescribir |
| 7 | `tests/docs/docs-consistency.test.ts` | guardia mecánica: las referencias de los docs existen | **nuevo** |
| 8 | Banners de estado | `PROGRESS.md` y `specs/*` = artefactos históricos, no normativos | editar |

**Matriz de propiedad (lo que NO se duplica):**

| Si la pregunta es… | Se responde en | No se responde en |
|---|---|---|
| "¿qué archivo hace X?" | `CODEMAP.md` | api.md, README |
| "¿qué devuelve este endpoint?" | `docs/api.md` | README, CODEMAP |
| "¿en qué orden se ejecutan los pasos y dónde abre la tx?" | `docs/use-cases.md` | api.md |
| "¿por qué el precio es la última vela por `date`?" | `DECISIONS.md` | README (queda un resumen + link) |
| "¿cómo corro esta suite / qué DB usa?" | `docs/testing.md` | AGENTS |
| "¿qué comando uso para typecheck?" | `AGENTS.md` | testing.md |
| "¿qué columnas tiene `orders`?" | `docs/database.md` | api.md (sólo lo que viaja por HTTP) |

## Guardia mecánica (por qué estos docs sí se pueden confiar)

`tests/docs/docs-consistency.test.ts` — estático, sin DB, < 1 s, corre en el proyecto `app` de Jest:

- **D1 — referencias:** todo path en backticks que empiece con `src/`, `tests/`, `prisma/`, `db/`,
  `scripts/`, `docs/` (en `AGENTS.md` y `docs/*.md`) existe en disco.
- **D2 — cobertura de CODEMAP:** el conjunto de `src/**/*.ts` == el conjunto de archivos listados
  en `docs/CODEMAP.md`. Agregar o borrar un archivo sin actualizar el mapa **falla**.
- **D3 — exports:** cada `export (const|class|interface|type|function) X` de cada archivo listado
  aparece nombrado en `CODEMAP.md`. Cambiar la superficie pública sin documentarla **falla**.
- **D4 — rutas:** el conjunto de `router.<verbo>("<path>")` de `src/http/**` == las rutas de la
  tabla de `docs/api.md`.
- **D5 — códigos de error:** los valores de `API_ERROR_CODES` + `INSTRUMENT_NOT_FOUND`
  (hoy fuera del contrato, `src/application/orders/submit-order.ts:61`) están en `docs/api.md`.

Regla cultural que lo acompaña (va en `AGENTS.md`): **si el doc y el código difieren, gana el código,
y el mismo commit arregla el doc.** La guardia verifica estructura; la semántica la sostiene esa regla.

## Constraints (qué NO se hace)

- **`src/` casi no se toca**: única excepción prevista, `src/contracts/money.ts` (A2). `MoneyArsSchema` y
  `PctSchema` usan `z.custom`, que `z.toJSONSchema` no puede representar ("Custom types cannot be
  represented in JSON Schema"). Se les agrega `.meta()` con la anotación JSON Schema (múltiplo de 0.01,
  descripción) **sin cambiar la validación en runtime**. Cualquier otro cambio de `src/` exige spec aparte.
  Los hallazgos
  de arquitectura (UC-1/UC-2 sin caso de uso, error handler ausente, N+1, cast de `ApiErrorCode`,
  `marketdata-price-source` sin cablear) quedan listados como backlog, **no** se corrigen acá.
- **Sin dependencias nuevas.** Nada de OpenAPI, typedoc, mkdocs, mermaid-cli, ajv.
- **Sin generación automática de docs**: la fuente sigue siendo el código, pero el doc se escribe a mano
  y la guardia detecta la deriva. Generar docs desde Zod se evalúa recién si la deriva semántica se
  vuelve un problema real (ver A2).
- **Sin duplicar reglas.** Si un dato aparece en dos docs, uno de los dos es un link.
- **Sin documentar lo que no existe.** `arquitectura-componentes.html` se etiqueta como objetivo;
  no se "documenta" Yahoo, cron ni `price_ticks` como si estuvieran.
- No reescribir `docs/database.md` (está bien); sólo se linkea.

## Tasks

Cada tarea es 1–2 archivos y se verifica sola. Orden = orden de ejecución sugerido.

### Fase P0 — navegabilidad (máximo ROI, cero riesgo)

**T1 — `docs/CODEMAP.md`.** Una entrada por archivo de `src/` (35): responsabilidad en una línea,
exports con firma resumida, quién lo llama, test que lo cubre, y una sección final de **trampas**
(`TransactionContext` brand/unbrand, `tx` opcional, singleton lazy, `DISTINCT ON`, advisory lock,
`ON CONFLICT` count, `CorruptRowError`, `MoneyArs` = number).
Verificación: `node -e` que compare el set de archivos con los headings (preludio de D2).

**T2 — `AGENTS.md` reescrito.** Estructura real por capas; comandos reales
(`dev` = `tsx watch`, no nodemon; `test:db:reset`; suite única; PostgreSQL de test configurado
por `TEST_DATABASE_URL`, separado de la conexión runtime `DATABASE_URL`); protocolo de lectura
(CODEMAP → un doc → código); tabla "pregunta → doc"; límites y reglas financieras **referenciando** `DECISIONS.md` en vez de
repetirlas; nota de que `specs/` y `PROGRESS.md` son históricos.
Verificación: D1 verde; ningún comando del doc falla al copiarse (los de sólo lectura se ejecutan).

**T3 — `tests/docs/docs-consistency.test.ts` con D1+D2+D3.** Verificación: `npx jest tests/docs` verde;
prueba negativa: agregar un `.ts` vacío en `src/` y ver el test **fallar** (después borrarlo).

### Fase P1 — contrato y reglas (mata las tres fuentes de verdad)

**T4a — schemas representables (`src/contracts/money.ts`).** `MoneyArsSchema`/`PctSchema` pasan a
`z.number()` + `refine` equivalente + `.meta({ multipleOf: 0.01, description })`. Verificación:
`z.toJSONSchema(MoneyArsSchema)` devuelve `{type:"number", multipleOf:0.01}`; los 163 tests siguen verdes;
el refine sigue rechazando `NaN`, `Infinity` y 3 decimales.

**T4b — registro de rutas + generador.** `scripts/generate-openapi.ts`: un registro declarativo
(método, path, params/query/header/body, respuesta por status, ejemplo) que importa los schemas de
`src/contracts` y emite **OpenAPI 3.1** (JSON Schema 2020-12 embebido en `components.schemas`).
Comando: `npm run openapi`. Artefacto: `openapi.json` commiteado. Verificación: `npm run openapi`
idempotente (correr dos veces no cambia el archivo) y el JSON valida contra el meta-schema de OpenAPI 3.1.

**T4c — `docs/api.md` (prosa, sin duplicar campos).** Por endpoint: cuándo se usa, semántica de estados
(201 también para órdenes persistidas REJECTED/CANCELLED), `Idempotency-Key` (replay vs 409), formato de
dinero y timestamps, y **link** a `openapi.json` para la forma de cada campo. El estado de
`INSTRUMENT_NOT_FOUND` (fuera de `API_ERROR_CODES`, decisión 27 del README) se documenta explícitamente.
Verificación: D4 (rutas del registro == rutas de los routers) y D5 (códigos) verdes; los ejemplos se
corren contra el server.

**T4d — test de deriva del OpenAPI.** El test regenera el documento en memoria y lo compara con
`openapi.json` commiteado; si un schema cambió y nadie regeneró, **falla**. Reemplaza a la guardia
manual y es lo que hace que el contrato machine-readable sea confiable.

**T5 — `DECISIONS.md` promovido.** Absorbe los 27 puntos del README §Supuestos (con porqué),
agrega los 3 huecos detectados: formato de dinero (resuelve la contradicción con `AGENTS.md`),
ausencia de `CHECK` en la migración (se documenta como deuda, no como regla cumplida), y
`INSTRUMENT_NOT_FOUND` fuera del contrato. El README §Supuestos queda como resumen de 5 líneas + link.
Verificación: D1; grep de "no duplicar": cada regla aparece una sola vez en `docs|*.md`.

**T6 — Decidir A1 (formato de dinero) y dejar el doc alineado con el código elegido.**
Verificación: la frase de la regla en `DECISIONS.md` y el tipo `MoneyArs` coinciden (lectura + D5).

### Fase P2 — flujo y verificación

**T7 — `docs/use-cases.md`.** UC-1..UC-5: precondición, pasos numerados con el archivo que los
implementa, frontera de `withUserTransaction`, transiciones de estado, y la **matriz de decisión de
UC-3** (MARKET / LIMIT-GTC / LIMIT-IOC / LIMIT-FOK × precio disponible × fondos → estado + razón).
Verificación: la matriz se contrasta con `tests/functional/orders-submit/submit-order.test.ts`
(cada celda debe tener un `it` que la cubra; las que no, se listan como hueco).

**T8 — `docs/testing.md`.** Mapa suite → qué prueba → DB → cómo correrla sola. Documenta los dos
proyectos de Jest (`app` y `uc3-functional` y **por qué** existe el segundo), las DBs por suite
(`cocos_challenge_test`, `_read`, `_cancel`, `_transfer`, `_ftest`), el auto-reset de `beforeAll`,
`tests/helpers/{factories,fixtures,dbReset}`, y el warning de worker leak como trampa conocida.
Verificación: `npx jest <suite>` de cada suite citada arranca y pasa (o el doc dice explícitamente
que requiere DB y cómo levantarla).

### Fase P3 — higiene (opcional, decide el humano)

**T9 — Banners de estado** en `PROGRESS.md` y `specs/*.md` ("histórico: describe el proceso de
build, no el estado actual"). Verificación: D1.
**T10 — `arquitectura-componentes.html`** etiquetado como estado objetivo, con link al implementado.
Verificación: D1.
**T11 — `tsconfig.json`:** borrar los aliases `@/*` muertos y los flags de decoradores sin uso.
Verificación: `npx tsc --noEmit` + `npx jest` siguen verdes.
**T12 — Headers de código:** reemplazar el vocabulario de build ("FASE 3 — Célula E", "el orquestador")
por referencias a UC y a decisiones. Diff grande y puramente cosmético → **separado del resto**,
sólo si se aprueba.

## Definición de terminado (medible)

Con **sólo** `AGENTS.md` + `docs/CODEMAP.md` (+ un doc por pregunta) se responden estas 7, sin abrir `src/`:

1. ¿Qué status y body devuelve `POST /orders` con un body inválido? ¿Se persiste algo?
2. ¿De dónde sale el precio de un `MARKET` y qué pasa si el instrumento no tiene marketdata?
3. ¿Qué clase implementa `OrderRepository` y qué SQL crudo ejecuta, para qué?
4. ¿Qué suite cubre la idempotencia, contra qué DB corre y cómo la corro sola?
5. ¿Qué pasa si agrego un archivo a `src/` sin tocar los docs?
6. ¿Cómo viaja el dinero en la respuesta y por qué no es float?
7. ¿Cuál es la fórmula del cash disponible y en qué archivo vive la regla?

Y los gates de siempre: `npx tsc --noEmit`, `npx eslint .`, `npx jest` (159 + la nueva suite) verdes,
con el output pegado en el commit.

## Riesgos

- **La guardia no cubre semántica.** D1–D5 detectan archivos, exports, rutas y códigos; no detectan
  "el doc explica mal una regla". Mitigación: la regla del commit + revisión humana en los cambios de
  regla. No hay forma barata de automatizarlo sin generar docs (ver A2).
- **`docs/api.md` duplica a `contracts/`.** Es duplicación deliberada: el contrato TS es la
  implementación, `api.md` es la lectura humana/agente. El riesgo es que divergen; D4/D5 lo acotan a
  rutas y códigos, no a campos.
- **Costo de mantenimiento:** ~1.100–1.400 líneas de doc nuevas. Se paga en la primera iteración
  que un agente resuelva sin leer 5 archivos.

## Puntos abiertos (requieren decisión humana)

- **A1 — RESUELTO: número JSON con 2 decimales.** Se corrige la regla en `AGENTS.md`/`DECISIONS.md`
  (el cálculo sigue en `Decimal`; el `number` es sólo el vehículo de serialización, ya cuantizado).
- **A2 — RESUELTO: OpenAPI 3.1 generado desde Zod.** Sin dependencias nuevas: Zod 4.6.7 ya expone
  `z.toJSONSchema` (verificado en este repo). Costo real declarado: hay que hacer representables
  `MoneyArsSchema`/`PctSchema` (T4a) y escribir el registro de rutas (T4b).
- **A3 — alcance de P3.** ¿T11 (aliases muertos en tsconfig) y T12 (limpiar vocabulario de células en
  35 headers) entran ahora o quedan para después? Recomendación: T11 sí (10 líneas), T12 después.
