# AGENTS.md — cocos-challenge-backend

API REST financiera: portfolios, instrumentos, órdenes de mercado.
Stack: Node.js 22 · TypeScript (strict) · Express 5 · Prisma · PostgreSQL 16 · Zod · Jest.

## Comandos

```bash
npm run dev                # servidor con nodemon
npm run build              # tsc
npm test                   # jest completo
npx jest src/orders/orders.service.test.ts   # test de UN archivo
npx tsc --noEmit                             # typecheck de UN archivo: npx tsc --noEmit <archivo>
npx eslint <archivo> --fix                   # lint de UN archivo
npx prisma migrate dev --name <cambio>       # migración versionada
docker compose up -d                         # Postgres local
```

Antes de terminar cualquier tarea: typecheck + lint + tests del archivo tocado, y del build si se tocó más de un módulo.

## Estructura (vertical slices)

```
src/<dominio>/           # orders/, portfolios/, instruments/
  <dominio>.routes.ts    # rutas, nada de lógica
  <dominio>.service.ts   # lógica de negocio, sin HTTP
  <dominio>.repository.ts# acceso Prisma, sin lógica
  <dominio>.schema.ts    # Zod, parse estricto (no cast)
src/shared/              # money, errors, idempotency, audit
src/lib/                 # prisma client singleton, config, logger
specs/                   # specs versionadas (fuente de verdad)
docs/CODEMAP.md          # índice de módulos — leer ANTES de explorar el repo
```

Flujo por slice: route → Zod → service → repository. No carpetas globales por tipo (controllers/, services/).

## Workflow obligatorio

1. **Spec antes de código.** Toda feature/cambio no trivial empieza con una spec en `specs/`: Why / What (alcance explícito) / Constraints (qué NO hacer) / Tasks (tareas de 1–2 archivos, cada una con comando de verificación). El humano edita la spec; el agente la ejecuta.
2. **TDD por criterio de aceptación.** Escribir el test de integración que falla → ejecutarlo y mostrar que falla → implementar lo mínimo → refactor → commit. Prohibido afirmar "los tests pasarían": correrlos siempre y mostrar output. Si un test falla, se arregla el código, nunca el assertion.
3. **Tareas atómicas.** Un cambio grande = muchas tareas chicas. Diffs focalizados; nunca reescrituras repo-wide sin pedido explícito.

## Reglas financieras (no negociables)

- **Dinero NUNCA en float/double.** TS: `Int` en centavos (`amountCents`), `bigint` para magnitudes altas, `decimal.js` solo para rates/cálculos intermedios, construido desde strings (`new Decimal("0.1")`), jamás desde `number`. Prisma/Postgres: `Int`/`BigInt`/`Decimal` — `Float` prohibido.
- **Nombres con unidad**: `amountCents`, `priceMicros` — nunca `amount` ambiguo. Moneda ISO 4217 siempre junto al monto.
- **Serialización**: el dinero viaja como string o entero-en-unidad-menor, nunca como número JSON.
- **Idempotencia en la DB, no en el código**: `UNIQUE(portfolioId, idempotencyKey)` + claim con `ON CONFLICT DO NOTHING` como primera escritura de la misma transacción que la operación. Cliente genera la clave (UUID v4). Test de doble-submit concurrente obligatorio por endpoint de escritura.
- **Toda multi-escritura en transacción** con aislamiento explícito; concurrencia sobre saldos con `SELECT FOR UPDATE` o version column. Nunca read-modify-write ingenuo.
- **Máquina de estados explícita** para órdenes: transiciones válidas codificadas + CHECK en DB.
- **Auditoría**: `audit_log` append-only, escrita en la misma transacción de la mutación. Sin UPDATE/DELETE sobre registros financieros (correcciones = entradas de reversa). Zod `strict()` en el borde; nunca confiar en el body directo.

## Límites

✅ **Siempre**: typecheck+lint+tests antes de terminar; transacciones en multi-escritura; constraints en DB, no solo en la app.
⚠️ **Preguntar antes**: nuevas dependencias, cambios en `prisma/schema.prisma`, migraciones, borrar/modificar tests existentes.
🚫 **Nunca**: `any` (usar `unknown` + narrowing), `Float` para dinero, editar `migrations/` a mano, `prisma db push`, commitear secretos, saltarse tests.

## Estilo de código

- Código autodescriptivo: nombres largos y específicos (`validateOrderByAvailableAmount` > `validate`). Comentarios solo para el *por qué*, nunca para el *qué*.
- `strict: true` + `noUncheckedIndexedAccess`. Named exports only. ESM.
- Archivos enfocados por dominio (no por límite arbitrario de líneas). Cadenas de llamadas planas, jerarquías shallow.
- Ejemplos de dinero:

```ts
// ✅ Bien
const totalCents = order.quantity * order.priceCents;      // entero × entero
const fee = new Decimal(totalCents).mul(FEE_RATE).toDecimalPlaces(0, Decimal.ROUND_DOWN);

// ❌ Mal
const total = quantity * price;                             // float ambiguo
const fee = total * 0.001;                                  // IEEE-754, error acumulado
```

## Eficiencia de contexto (para agentes)

- Leer `docs/CODEMAP.md` antes de explorar; leer solo los archivos que la tarea toca.
- Referenciar archivos y líneas en vez de pegar código en chat/specs.
- Reglas por dominio viven junto al dominio o enlazadas desde acá — no duplicar: una sola fuente por regla.
- Diffs mínimos; no re-formatear código no tocado.

## Escape hatch

Si algo es ambiguo o faltan datos (casos de uso, contratos de API, schema de DB): preguntar o proponer un plan — no inventar supuestos silenciosamente.
