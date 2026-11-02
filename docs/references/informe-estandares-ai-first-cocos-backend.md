# Estándares AI-first para desarrollo con agentes — Backend Node.js + Express 5 + TypeScript + Prisma + PostgreSQL (dominio financiero)

Informe de investigación (2025–2026). Proyecto: cocos-challenge-backend. Objetivo: definir el estándar ANTES de escribir código nuevo, optimizado para trabajo con agentes LLM y máxima eficiencia de tokens.

---

## 1. Archivos de contexto: AGENTS.md / CLAUDE.md / .cursorrules

### Formato recomendado

- **AGENTS.md es hoy el estándar de facto** (60k+ repositorios, adoptado por OpenAI Codex, Claude Code, Cursor, Gemini CLI, Zed, etc.). `CLAUDE.md` y `.cursor/rules/*.mdc` son variantes tool-específicas; la práctica dominante es **un único AGENTS.md como fuente de verdad** y, si se usan otras herramientas, un archivo por herramienta que **importe/referencie** AGENTS.md en lugar de duplicar contenido.
- Markdown plano, sin schema obligatorio. La herramienta lee el archivo **más cercano** al archivo editado (la jerarquía gana: `src/orders/AGENTS.md` > `AGENTS.md` raíz). Archivos hijos contienen solo **deltas**, enlazan al padre.

### Qué INCLUIR (orden de impacto, según análisis de 2.500+ repos de GitHub)

1. **Comandos ejecutables al principio** — copy-paste tal cual, con flags: `pnpm test -- path/to/file.test.ts`, `pnpm typecheck`, `pnpm lint --fix`, `npx prisma migrate dev --name X`. Incluir **comandos por-archivo** (tsc/vitest/eslint sobre un solo archivo) para que el agente no corra builds completos en cada paso.
2. **Stack específico con versiones**: "Node 22, TypeScript 5.8 strict, Express 5, Prisma 6, Zod 4, PostgreSQL 16" — no "proyecto TypeScript".
3. **Estructura del proyecto como mini-índice**: 5–10 líneas tipo "ver `src/orders/service.ts` para lógica de órdenes; los esquemas Zod viven en `src/schemas/`". Ahorra al agente re-explorar el repo en cada sesión.
4. **Estilo de código por EJEMPLOS, no por prosa**: un snippet real vale más que tres párrafos. Incluir ejemplos "bueno/malo" (p. ej. cómo se calcula una comisión, cómo se maneja un error).
5. **Límites en tres tiers** (el patrón más efectivo de la guía de GitHub):
   - ✅ **Siempre**: correr typecheck+lint+tests por archivo antes de terminar; usar transacciones para multi-escritura.
   - ⚠️ **Preguntar antes**: nuevas dependencias, cambios de schema Prisma, migraciones, tocar `prisma/schema.prisma`, `DELETE` de tests.
   - 🚫 **Nunca**: commitear secretos, usar `float` para dinero, tocar `migrations/` a mano, saltarse tests.
6. **Sección financiera del dominio** (ver sección 4): reglas de dinero e idempotencia como reglas de lint conceptual.
7. **Escape hatch**: "si hay ambigüedad, pregunta o propone plan; no inventes supuestos silenciosamente".

### Qué NO incluir

- Prosa larga, filosofía, "sé un asistente útil". Vaguedades ("escribe buen código") no funcionan; reglas concretas y medibles sí ("complejidad ciclomática < 10").
- Documentación detallada de subsistemas → va a `docs/`, con **enlaces** (patrón puntero), no copiada. Target: **AGENTS.md < 200 líneas**. ~150–200 instrucciones permanentes es el tope práctico antes de que la adherencia se degrade ("curse of instructions": con demasiadas reglas el modelo empieza a ignorarlas).
- Comandos de ejemplo que no existen en el repo.
- Duplicar contenido entre README.md y AGENTS.md (si ambos documentan el mismo comando, deben coincidir).
- Archivos generados por LLM sin revisar humana: un estudio (ETH Zurich, 2026) mostró que archivos de contexto generados por LLM *reducen* la tasa de éxito ~3%, mientras que los curados por humanos la mejoran ~4% — la **calidad del contenido importa más que su presencia**.

### Evidencia de impacto

Estudio sobre 10 repos y 124 PRs reales (arXiv 2601.20404): con AGENTS.md, **tiempo wall-clock mediano −28,6%** y **tokens de salida medios −16,6%** (p<0.05), manteniendo la tasa de finalización.

### Fuentes

- https://agents.md/ (especificación oficial)
- https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/
- https://www.builder.io/blog/agents-md
- https://arxiv.org/abs/2601.20404 (impacto en eficiencia)
- https://claude.com/resources/articles/using-claude-md-files
- https://arxiv.org/html/2510.21413 (estudio de adopción)

---

## 2. Metodologías: spec-driven development, design docs, descomposición, TDD

### Spec-driven development (SDD) — estándar vigente 2025–2026

Definición dominante (Böckeler, Thoughtworks/Martin Fowler, oct 2025): escribir una spec estructurada **antes** de que la IA escriba código, y mantenerla como fuente de verdad. Escalera de 3 niveles:

- **Spec-first**: spec antes del código, puede morir después del feature (el 90% de los equipos está aquí).
- **Spec-anchored**: la spec sobrevive al feature y evoluciona con él (recomendado para este proyecto).
- **Spec-as-source**: la spec es el artefacto primario; el código se regenera (postura radical de Tessl, no recomendada aún).

Herramientas: **GitHub Spec Kit** (open source, tool-agnostic: `/specify → /plan → /tasks → /implement` con `constitution.md` de gobierno del proyecto), **AWS Kiro** (Requirements → Design → Tasks), OpenSpec. Para un backend financiero: usar la estructura de Spec Kit (constitution + spec + plan + tasks) como documentos Markdown versionados en `specs/` — sin acoplarse a una herramienta.

### Estructura de spec que funciona para agentes (4 partes)

1. **Why**: 1–2 frases de contexto del problema.
2. **What**: alcance explícito; detalles que el agente adivinaría (p. ej. "JWT con access tokens de 1h y refresh de 7d").
3. **Constraints**: librerías permitidas, patrones obligatorios, fuera de alcance explícito ("NO agregar dependencias; NO persistir tokens").
4. **Tasks**: unidades pequeñas y verificables: cada tarea dice qué construir, qué archivos toca y **cómo verificar** ("Verificar: `pnpm vitest run orders.test.ts` pasa").

Workflow probado: (1) generar spec con agente → (2) **humano la edita y corrige supuestos** → (3) sesión fresca, "lee la spec e implementa T1" → revisar → commit → (4) adaptar la spec si el código revela defectos (iterativo, no waterfall). La spec vive en el repo, no en el chat.

### Design docs antes de código

Distinguir tres documentos: **PRD** (qué y por qué, debate), **Design doc técnico** (cómo: arquitectura, decisiones, seguridad), **Spec de agente** (ejecución: traducción de decisiones a tareas). Features grandes: PRD → design doc → specs. Features chicas: spec directa. Regla práctica de Anthropic/GitHub: usar **Plan Mode / modo read-only** para planear antes de escribir; el agente no toca código hasta que la spec esté validada.

### Descomposición de tareas

Pipeline Spec Kit: **Feature → user stories → tareas atómicas → implementación iterativa**. Cada tarea afecta 1–2 archivos y toma minutos, no horas. Esto evita el "big bang" de 10.000 líneas que luego hay que desenredar. Claves:

- Tareas **independientes** cuando sea posible (paralelizables entre subagentes con contextos aislados).
- Cada tarea con **criterio de verificación ejecutable**.
- GATES de revisión humana: revisión de spec → revisión de plan → ejecución autónoma.

### TDD con agentes

El debate 2025–2026 (Böckeler, "TDD inside the agent loop"): TDD clásico unit-first con agentes tiene evidencia mixta (los agentes a veces "fakean" el rojo o escriben la implementación antes). Consenso práctico emergente:

- **Subir en la pirámide**: el ciclo atómico ya no es el unit test sino el **test de integración/aceptación por criterio de aceptación**. "Escribe el test de integración que falla para este AC → correlo y muestra que falla → escribe el mínimo código → refactorea → commit."
- **Exigir ejecución real**: prohibir "los tests pasarían"; el agente debe correr el test y mostrar output en cada transición RED/GREEN/REFACTOR (3 corridas por ciclo).
- **Los tests son sagrados**: si el test falla, se arregla el código, nunca el assertion. Si el assertion parece malo, parar y preguntar.
- **Revisión humana del test rojo**: es el checkpoint donde el humano valida que el test prueba lo correcto.
- Doble escuela aplicable: dominio puro (Money, validadores) → Chicago (objetos reales, verificación de estado); controladores/infra → London (mocks del gateway de mercado).

### Fuentes

- https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html (Böckeler)
- https://github.com/github/spec-kit
- https://newsletter.aiengineer.co/p/how-i-code-with-ai-agents-spec-driven
- https://addyosmani.com/blog/good-spec
- https://martinfowler.com/articles/exploring-gen-ai/tdd-in-the-agent-loop.html
- https://kiro.dev/docs/specs/

---

## 3. Eficiencia de tokens para agentes

### Principio central: densidad semántica, no compresión

Hallazgo clave (arXiv 2604.07502, "Beyond Human-Readable"): **minimizar tokens brutos es contraproducente**. Comprimir información de alta densidad (nombres descriptivos, tipos, docstrings) aumenta los tokens de razonamiento downstream — en el experimento, comprimir agresivamente logs redujo input 17% pero **aumentó el costo total de sesión 67%**. El objetivo es maximizar la relación tokens-significativos/tokens-totales: eliminar tokens de **ceremonia** (boilerplate estructural, sintaxis redundante), nunca de **semántica**.

### Reglas prácticas para estructura de código

- **Archivos de tamaño moderado pero por límites de dominio**, no de cognición: la separación debe responder a deployment/testabilidad/concurrencia. Arquitectura **vertical slice** (todo el código de un feature junto) es naturalmente agent-friendly; jerarquías de paquetes profundas confunden a los agentes.
- **Nombres largos y autodescriptivos**: `validateOrderByAvailableAmount` es documentación comprimida que el modelo interpreta semánticamente. Nunca abreviar semántica.
- **Cadenas de llamadas planas** sobre jerarquías profundas. Minimizar el *ceremony-to-logic ratio* (un endpoint Spring típico: 170 líneas para 18 de lógica — 9 tool calls de puro boilerplate). Meta: "lo más simple que funcione" (Ronacher).
- **Índice de código versionado** (`CODEMAP.md`): artefacto propuesto por la investigación — topología de módulos, entry points, cadenas de llamada con descripciones de una línea, firmas de funciones, flujo de datos, ubicaciones de archivos; **sin** cuerpos de implementación ni imports. Un solo read le da al agente el mapa completo (vs. iterar leyendo archivos). Actualizarlo en cada cambio estructural.
- **Anti lost-in-the-middle**: los LLM atienden peor a la información enterrada en el medio del contexto (hasta −40%). Colocar lo crítico al inicio/fin del prompt; mantener contextos enfocados.
- **Carga progresiva de contexto**: AGENTS.md raíz siempre cargado (hot); docs por subsistema bajo demanda (cold). Un solo archivo monolítico no escala (evidencia del proyecto Codified Context, 108k líneas: constitución hot ~660 líneas + 19 agentes especializados + base de conocimiento on-demand).
- **Inyección de contexto modular** (MicroSkill Architecture, arXiv 2606.05720): entregar solo las cápsulas relevantes a la tarea en vez del contexto completo → −93% tokens por feature y +46% éxito en primera compilación en su evaluación. Para este proyecto: reglas de DB solo cuando se toca `prisma/`, reglas de dinero solo cuando se toca código de órdenes/pagos (reglas glob-scoped en `.cursor/rules/` o secciones enlazadas).
- **Evitar duplicación de contexto**: una sola fuente por regla; punteros, no copias. Duplicados divergen y cada copia cuesta tokens en cada sesión.
- **Comandos por archivo** (ver §1): `tsc --noEmit archivo.ts` en vez de build completo evita minutos de espera y tokens desperdiciados en output de build.
- **Diffs pequeños**: preferir cambios focalizados; reescrituras repo-wide solo a pedido explícito.

### Fuentes

- https://arxiv.org/html/2604.07502v1 (densidad semántica, CODEMAP)
- https://arxiv.org/pdf/2601.19929v2 (Stingy Context, compresión jerárquica 18:1)
- https://arxiv.org/html/2606.05720 (MicroSkill, −93% tokens)
- https://arxiv.org/html/2603.01012v1 (FastCode, scouting-first)
- https://arxiv.org/html/2602.20478v1 (Codified Context, infraestructura de contexto por tiers)

---

## 4. Estándares del dominio financiero en TypeScript

### Manejo de dinero: NUNCA float

- **Regla #1**: `number` de JS es IEEE-754 binario (`0.1 + 0.2 ≠ 0.3`). Prohibido `float`/`double` tanto en TS como en columnas Postgres (`FLOAT`/`DOUBLE PRECISION`/`REAL` baneadas en lint/revisión).
- **Representación recomendada**: **entero en unidades menores** (centavos): `1234n` = $12.34. En TS: `number` para centavos mientras quepa en `Number.MAX_SAFE_INTEGER` (≈90 billones USD en centavos; paraInstrumentos de alta magnitud usar `bigint`). Para tasas, FX y cálculos intermedios con decimales: **decimal.js** (o dinero.js), operando siempre desde **strings**, nunca desde floats (`new Decimal("0.1")`, no `new Decimal(0.1)`).
- **En Postgres (Prisma)**: `Int` (centavos) para precios/totales chicos; `BigInt`/`bigint` por encima de ~$21M en centavos; `Numeric(p,s)`/`Decimal` para montos contables con decimales fijos o rates. **Nunca `Float`**. Documentación oficial: https://www.prisma.io/docs/orm/data-modeling/money
- **Serialización**: el dinero viaja como **string** o entero-en-unidad-menor, nunca como número JSON (cualquier parser lo convierte a double y reintroduce el error en el borde). Validar entrada con Zod: dinero como string con regex de precisión, o entero estricto.
- **Unidades en los nombres**: `amountCents`, `priceMicros`, `quantity` — nunca `amount` ambiguo. Tipos de dominio: `type Cents = number` mínimo; ideal un branded type o value object `Money { amount: bigint; currency: ISO4217; scale }`.
- **Moneda siempre junto al monto** (ISO 4217; ojo: no todas tienen 2 decimales — JPY=0, BHD=3, CLF=4).
- **Redondeo explícito y de negocio**: redondear lo menos posible, solo en límites (persistencia/display); decidir estrategia por caso (half-up vs banker's/half-even, round-down conservador para fees); las sumas de partes redondeadas deben reconciliar — usar cuenta/deuda explícita de residual, jamás "acuñar" dinero.

### Idempotencia de órdenes

- **La garantía vive en la base de datos, no en el código**: `UNIQUE` constraint sobre la clave idempotencia (scoped: `(portfolioId, idempotencyKey)` o `(tenantId, idempotencyKey)`), y el claim de la clave es la **primera escritura dentro de la misma transacción** que la operación de negocio. Éxito y marca de idempotencia committean juntos o no committean.
- En Postgres: `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` para reclamar atómicamente; el perdedor lee la fila del ganador y devuelve la respuesta almacenada. Nada de check-then-insert (carrera) ni Redis como fuente de verdad ("Postgres te hace correcto, Redis te hace rápido" — cache en frente, nunca detrás).
- **El cliente genera la clave** (UUID v4), una por operación lógica, misma clave en cada retry. **Request fingerprint** (hash estable, key-order-insensitive) para detectar misma clave + payload distinto → `409/422`, nunca re-procesar.
- Ciclo de vida: estados `in_progress → completed` con `CHECK` constraint; lease/timeout para filas `in_progress` abandonadas (proceso muerto a mitad de request no debe bloquear retries para siempre); TTL ~24h (Stripe usa 24h) con limpieza.
- Claves sin PII (aparecen en logs/auditoría); no reutilizar claves entre endpoints; `PUT`/upserts ya idempotentes no necesitan tabla extra — gastar el patrón donde paga (POST de órdenes, ejecuciones, transferencias).
- Test de concurrencia obligatorio: dos requests paralelos con la misma clave → exactamente una fila y una respuesta 201 (+ replay).

### Validación estricta y auditoría

- **Zod** en el borde: parse, no cast. Validar moneda, precisión, límites (orden mínima/máxima, ticks de precio), y rechazar campos extra (`strict()`). Nunca confiar en el body directo.
- **Estado de orden como máquina de estados explícita**: enum (`PENDING → FILLED / PARTIALLY_FILLED / CANCELLED / REJECTED`), transiciones válidas codificadas, CHECK constraint en DB. Imposible pasar de FILLED a PENDING.
- **Transacciones**: toda operación multi-escritura (reservar saldo + crear orden + registrar movimiento) en una transacción Prisma con nivel de aislamiento explícito; en concurrencia sobre saldos, `SELECT ... FOR UPDATE` o columnas de versión (optimistic locking) — nunca read-modify-write ingenuo.
- **Auditoría**: tabla append-only (`audit_log`) con quién/qué/cuándo/antes-después en JSONB, escrita en la misma transacción que la mutación; sin UPDATE ni DELETE sobre registros financieros (usar entradas de corrección/reversa). Ids inmutables; soft-delete explícito. Considerar constraints de balance invariante (sum(debits) = sum(credits)) verificable con queries de reconciliación en CI.
- **Logs estructurados** (JSON) con orderId/actor, sin PII ni datos sensibles de instrumentos.

### Fuentes

- https://www.prisma.io/docs/orm/data-modeling/money (guía oficial Prisma sobre dinero)
- https://handbook.fintechengineer.io/chapters/money/representing-money.html
- https://cardinalby.github.io/blog/post/best-practices/storing-currency-values-data-types/
- https://alexsavin.me/posts/2020-12-22-financials-best-practices/
- https://blog.openreplay.com/idempotency-api
- https://thetshaped.dev/p/how-to-stop-charging-customers-twice-practical-idempotency-guide-http-message-queues
- https://nerdleveltech.com/idempotency-keys-nodejs-postgres-api-tutorial
- https://docs.rokt.com/developer-reference/apis/partnerships-api/concepts/idempotency

---

## 5. Convenciones TS / Prisma / PostgreSQL

### TypeScript

- **`strict: true` y además**: `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes` (si el stack lo tolera). **`any` prohibido**; usar `unknown` + narrowing. `noUncheckedIndexedAccess` es especialmente valioso en dominio financiero (índices de arrays de legajos/pricing).
- **Named exports only**; sin default exports (imports consistentes para agentes y humans).
- ESM (`import`/`export`), no CommonJS. tsconfig con `module: NodeNext`/bundler.
- Zod como contrato único en el borde (request/response) + tipos derivados (`z.infer`); compartir schemas entre validación HTTP y persistencia.
- Lint con ESLint + typescript-eslint strict; formatter Prettier; **typecheck como gate obligatorio** en pre-commit y CI (`tsc --noEmit`).
- Naming: `camelCase` vars/funciones, `PascalCase` tipos/clases, `SCREAMING_SNAKE_CASE` constantes, kebab-case archivos (o singular PascalCase para módulos de clase); booleanos con prefijo `is/has/can/should`.

### Prisma

- **Migraciones versionadas siempre**: `prisma migrate dev --name <cambio>` para desarrollar, `prisma migrate deploy` en CI/producción. **`prisma db push` prohibido** fuera de descartes temporales. `prisma migrate status` antes de commit. Nunca editar `migrations/` a mano ni regenerar historial.
- Schema en `prisma/schema.prisma`; un solo cliente singleton (`src/lib/prisma.ts`) con log config apropiado; en Prisma ≥7 usar `prisma.config.ts`.
- Tipos de columna: dinero como arriba (Int cents / BigInt / Decimal); **nunca `Float`** para montos. Fechas `DateTime(3)` UTC; timestamps `createdAt`/`updatedAt` en toda tabla transaccional.
- Enums nativas de Prisma para estados (alineadas a CHECK de DB); constraints compuestos (`@@unique([portfolioId, idempotencyKey])`) e índices en toda FK y columna de filtrado frecuente.

### PostgreSQL

- Postgres 16/17; todas las conexiones con pool acotado; timeouts de query y de transacción explícitos.
- Multi-escritura → transacción; concurrencia de saldos → `SELECT FOR UPDATE` o version column; aislamiento READ COMMITTED por defecto + SERIALIZABLE solo donde se demuestre necesidad.
- Soft constraints en la app, **hard constraints en la DB**: NOT NULL, FK, UNIQUE, CHECK siempre en el schema; la app es segunda línea de defensa.
- Naming DB: `snake_case` para tablas/columnas, plural para tablas; sin ambigüedades (`orders`, `order_executions`).

### Estructura de carpetas (feature-sliced, la predominante hoy)

```
src/
├── orders/            # slice por dominio: route + controller + service + schemas + repo
│   ├── orders.routes.ts
│   ├── orders.service.ts      # lógica de negocio
│   ├── orders.repository.ts   # acceso Prisma
│   └── orders.schema.ts       # Zod
├── portfolios/
├── instruments/
├── shared/            # money.ts, errors.ts, idempotency middleware, audit
├── lib/               # prisma client, config, logger
└── server.ts
prisma/
├── schema.prisma
└── migrations/
specs/                 # specs versionadas (SDD)
docs/                  # CODEMAP.md, arquitectura
tests/ (o *.test.ts co-ubicados)
```

Capas por slice: route → validation (Zod) → service (lógica, sin HTTP) → repository (Prisma, sin lógica). Evitar carpetas globales por tipo técnico (controllers/, services/ sueltos) que dispersan un feature entre muchos archivos — mal para agentes y para revisión.

### Fuentes

- https://github.com/seanpmaxwell/Typescript-Best-Practices
- https://github.com/bradtraversy/ai-blueprint (context/coding-standards.md)
- https://github.com/directiveforge/directiveforge (patrón .cursor/rules)
- https://dharyl.online/blog/building-a-bulletproof-api-express-typescript-prisma-7-zod
- https://github.com/undp/carbon-footprint-program (codebase-map, feature-sliced con Prisma)

---

## 6. Recomendación priorizada: las 10 reglas más importantes

1. **Dinero = enteros en unidades menores + moneda explícita.** Cents en `Int`/`bigint`, decimal.js solo para rates/intermedios desde strings, `Float` prohibido en TS y en Postgres, serializar dinero como string/entero jamás como número JSON.
2. **Idempotencia por constraint, no por código**: `UNIQUE(portfolioId, idempotencyKey)`, claim con `ON CONFLICT DO NOTHING` como primera escritura de la misma transacción que la orden; fingerprint del payload; replay devuelve la respuesta original.
3. **Un único `AGENTS.md` < 200 líneas**: comandos copy-paste primero (incluidos comandos por-archivo), stack con versiones, mini-índice de estructura, ejemplos de código, límites en tres tiers (siempre/preguntar/nunca) y reglas financieras explícitas. Humano lo cura; el LLM nunca lo genera sin revisión.
4. **Spec antes de código, siempre, aunque sea corta** (Why/What/Constraints/Tasks con verificación por tarea); specs versionadas en `specs/` y actualizadas cuando el código las corrige. El humano edita la spec; el agente ejecuta tareas de 1–2 archivos.
5. **TDD pragmático con agentes**: ciclo rojo-verde-refactor **a nivel de test de integración por criterio de aceptación**, con ejecución real obligatoria en cada fase (prohibido "debería pasar"); los tests son inmutables ante fallos del código; revisión humana del test rojo.
6. **Densidad semántica sobre brevedad**: nombres descriptivos largos, tipos estrictos, cadenas planas, vertical slices; mantener un `CODEMAP.md` (índice de módulos/firmas sin implementación) actualizado.
7. **Contexto progresivo y sin duplicación**: reglas globales en AGENTS.md, reglas por dominio scoped (`.cursor/rules/*.mdc` o docs enlazadas), una sola fuente por regla, docs detalladas on-demand en `docs/`.
8. **TypeScript hard-mode**: `strict` + `noUncheckedIndexedAccess`, `unknown` sobre `any`, named exports, Zod en el borde con parse estricto; `tsc --noEmit` + lint + tests como gates por archivo antes de cada commit.
9. **Prisma con migraciones versionadas y DB como árbitro**: `migrate dev/deploy` únicamente, `db push` baneado, constraints (UNIQUE/FK/CHECK/NOT NULL) siempre en el schema, índices en FKs, máquina de estados de órdenes como enum + CHECK.
10. **Auditoría inmutable y transaccional**: `audit_log` append-only escrita en la misma transacción de cada mutación financiera, sin UPDATE/DELETE sobre registros monetarios, logs estructurados sin PII, y test de concurrencia de doble-submit obligatorio en CI para cada endpoint de escritura.
