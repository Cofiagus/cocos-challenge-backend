# AGENTS.md — cocos-challenge-backend

API REST financiera: portfolio, instrumentos, órdenes de mercado (MARKET/LIMIT con TIF), cancelación
y transferencias de cash. Node 26 · TypeScript strict (ESM, `nodenext`) · Express 5 · Prisma 7
(`@prisma/adapter-pg`) · PostgreSQL · Zod 4 · Jest 30.
Estado: build completo — 5 endpoints, 16 suites / 163 tests verdes.

## 1. Protocolo de lectura (esto es lo que ahorra el 80% del contexto)

1. **`docs/CODEMAP.md` primero, siempre.** Es el índice: archivo → responsabilidad → exports → quién lo
   llama → test que lo cubre, más las trampas y la deuda conocida. Se lee entero en ~165 líneas.
2. **Un doc por pregunta** (tabla abajo). No leas dos docs para una pregunta: si hace falta, el doc está mal.
3. **Código sólo si los docs no alcanzan**, y en ese caso: arreglar el doc en el mismo commit.

| La pregunta es… | Leé |
|---|---|
| ¿qué archivo hace X? ¿quién llama a esto? ¿qué test lo cubre? | `docs/CODEMAP.md` |
| ¿por qué esta regla de negocio es así? | `DECISIONS.md` |
| ¿qué columnas, índices y derivaciones SQL existen? | `docs/database.md` |
| ¿cómo levanto la base y el server? ¿qué comando uso? | este archivo §2 y §4 |
| ¿qué se decidió y por qué, en la entrega? | `README.md` §Supuestos |
| ¿qué devuelve exactamente cada endpoint? | `openapi.json` (contrato, generado) + `docs/api.md` (semántica) |
| ¿en qué orden corre un caso de uso? | el header del caso de uso en `src/application/` (el doc de casos de uso es P2) |
| ¿esto que estoy leyendo sigue siendo verdad? | `docs/legacy.md` (qué está deprecado y qué usar en su lugar) |

**No leas** `PROGRESS.md` ni `specs/**` para saber cómo está el código: son artefactos históricos del
build (marcados como tales). La verdad del estado es `git log` + `docs/CODEMAP.md`.

## 2. Comandos (verificados)

```bash
npm run dev                  # tsx watch src/index.ts (NO nodemon)
npm run build                # tsc → dist/
npm run typecheck            # tsc --noEmit (gate obligatorio)
npm run lint                 # eslint 9 flat config (gate obligatorio)
npm test                     # jest completo: 16 suites / 163 tests
npx jest tests/functional/cancel          # UNA suite
npx jest -t "doble submit"               # UN test por nombre
npm run test:db:reset        # (re)crea cocos_challenge_test desde migraciones + seed
npm run openapi              # regenera openapi.json desde los schemas Zod
npx prisma migrate dev --name <cambio>    # migración versionada (pide aprobación humana)
npx prisma generate          # regenerar el cliente tras tocar schema.prisma
```

Regla de cierre de cualquier tarea: **typecheck + lint + los tests de lo que tocaste**, con el output
pegado. Prohibido decir "debería pasar".

## 3. Estructura real (capas, dependencia en un solo sentido)

```
src/
  contracts/       # tipos + schemas Zod: el contrato de cable. Única puerta: contracts/index.ts
  domain/          # funciones PURAS (cash, posiciones, reservas, matching, sizing). Sin I/O, sin Prisma
  domain/ports/    # 4 interfaces de repositorio — la aplicación depende de éstas, no de Prisma
  application/     # 3 casos de uso: submitOrder (UC-3), cancelOrder (UC-4), submitTransfer (UC-5)
  infra/prisma/    # 5 repos que implementan los ports + tx con advisory lock + mappers
  http/            # 5 router factories (DI) + app.ts + server.ts (composition root)
  lib/             # singleton lazy de PrismaClient
  index.ts         # entry: dotenv + listen
prisma/            # schema.prisma (fuente única de índices) + migrations/ (DDL real)
db/                # snapshot legacy GENERADO (schema.sql viejo) + seed.sql (dataset del challenge)
tests/             # unit / integration / functional + helpers
docs/              # CODEMAP, api, database, legacy (+ use-cases / testing en P2)
```

El detalle archivo por archivo, con firmas y trampas, está en `docs/CODEMAP.md`. **No** hay vertical
slices por dominio ni capas `shared` / `controllers` / `services`: si un doc o el `tsconfig` sugieren
eso, está desactualizado.

## 4. Entorno local (esta máquina)

- La base de desarrollo/test es un **cluster PostgreSQL userspace en `localhost:5433`**, no docker
  (`docker compose` existe en el repo para otros entornos, pero acá no se usa). Si está caído:
  `/usr/lib/postgresql/18/bin/pg_ctl -D ~/.pg/cocos -o '-p 5433 -k /tmp' -l ~/.pg/cocos.log start`
- `DATABASE_URL` sale de `.env` (dev) y `.env.test` (tests base). Cada suite funcional fija **su propia**
  DB y la resetea en `beforeAll`: correr `npm test` dos veces da verde.
- ESM + `nodenext`: los imports llevan extensión `.js` (`import … from "./x.js"`).
- Prisma 7: la URL no vive en `schema.prisma` sino en `prisma.config.ts`, y el cliente exige un driver
  adapter (`@prisma/adapter-pg`). El singleton es **lazy** a propósito.
- `db/schema.sql` es un snapshot generado y desactualizado: el DDL real son las migraciones.

## 5. Reglas no negociables (el porqué está en `DECISIONS.md`)

1. **Dinero nunca en float.** Cálculo y agregación SIEMPRE en `Decimal` (decimal.js), construido desde
   string. Entrada: número o string, normalizado con `String(value)`, **nunca** `new Decimal(number)`.
   Salida: **número JSON cuantizado a 2 decimales EN `Decimal` antes de serializar** (`serializeMoneyArs`).
   Prohibido: `Float` en Prisma/Postgres, `parseFloat` sobre dinero, aritmética de plata en `number`.
2. **Idempotencia en la DB, no en memoria.** `UNIQUE(userId, idempotencyKey)` en `orders` + `INSERT …
   ON CONFLICT DO NOTHING` como PRIMERA escritura de la transacción. Misma key + mismo payload → la
   orden original; payload distinto → 409. Todo endpoint de escritura necesita su test de doble submit.
3. **Toda multi-escritura en UNA transacción** con lock por usuario (`pg_advisory_xact_lock`). La
   validación de fondos lee DENTRO de esa tx. Nunca read-modify-write ingenuo.
4. **Auditoría append-only** en `order_events`, escrita en la MISMA tx que la mutación.
5. **Máquina de estados explícita**: transiciones válidas codificadas y guardadas por estado
   (`WHERE status='NEW'`). No hay `CHECK` en la migración — es deuda conocida, no una garantía.
6. **Zod `strict()` en el borde.** Nunca confiar en `req.body`. Input inválido → 400 **sin escribir nada**.
7. **Proyecciones, no tablas de saldo**: cash y posiciones se derivan de `orders FILLED`; las reservas,
   de las `NEW`. No agregar tablas de cash/posiciones.

## 6. Flujo de trabajo

1. **Spec antes de código.** Toda feature o cambio no trivial empieza con una spec en `specs/`:
   Why / What (alcance) / Constraints (qué NO) / Tasks (1–2 archivos, cada una con su verificación).
   El humano edita y aprueba la spec; el agente la ejecuta. `specs/trading-api-domain.md` es la fuente
   del dominio; `specs/agentificacion-docs.md` la de la documentación.
2. **TDD por criterio de aceptación**: test que falla → implementación mínima → refactor. Si un test
   falla, se arregla el código, nunca el assertion.
3. **Tareas atómicas**: un cambio grande = muchas tareas chicas, diffs focalizados.
4. **Una regla, un lugar.** Si una regla está en dos documentos, uno de los dos es un link.

## 7. Límites

✅ **Siempre**: typecheck + lint + tests antes de terminar; transacciones en multi-escritura;
constraints en DB, no sólo en la app; actualizar el doc dueño de lo que cambiaste.

⚠️ **Preguntar antes**: dependencias nuevas; cambios en `prisma/schema.prisma`; migraciones; borrar o
reescribir tests existentes; cambiar un contrato HTTP (afecta `openapi.json` y clientes).

🚫 **Nunca**: `any` (usar `unknown` + narrowing); `Float` para dinero; `prisma db push`; editar
`migrations/` a mano; cargar la DB desde `db/schema.sql`; commitear secretos; saltarse tests.

## 8. Estilo de código

- Código autodescriptivo: nombres largos y específicos (`validateOrderByAvailableAmount` > `validate`).
  Comentarios sólo para el *por qué*, nunca para el *qué*.
- Named exports, ESM, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Cadenas de llamadas planas; jerarquías shallow; archivos enfocados por responsabilidad.
- El header de cada archivo dice **qué UC sirve y qué decisión de `DECISIONS.md` implementa**, no en qué
  fase del build nació.

## 9. Mantenimiento de la documentación

`tests/docs/docs-consistency.test.ts` verifica mecánicamente que los docs no mientan sobre la
estructura: paths que existen, **todos** los archivos de `src/` listados en `CODEMAP.md`, todos los
exports nombrados (y que no haya exports inventados), rutas y códigos de error del contrato cuando
`openapi.json` exista.

Regla: **si el doc y el código difieren, gana el código y el mismo commit arregla el doc.** La guardia
detecta estructura (archivos, exports, rutas, códigos); la semántica la sostiene esta regla.

Si algo es ambiguo o faltan datos (casos de uso, contratos, schema): preguntar o proponer un plan —
nunca inventar supuestos en silencio.
