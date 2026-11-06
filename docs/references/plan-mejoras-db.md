# Borrador — Plan de mejoras de DB y arquitectura (fundamentado en casos de uso)

> **Archivado 2026-11-06 — documento histórico; no es fuente de verdad ni plan vigente.**
> Motivo: su contenido ya se ejecutó en las migraciones `20261106154910_db_integrity_constraints`
> y `20261106180000_db_write_invariants`. Esquema vigente: `prisma/schema.prisma` y
> `docs/database.md`.

> Estado: **parcialmente implementado**. M3 (idempotencia en DB) se implementó; M1 se resolvió
> con `Decimal(10,2)` + `decimal.js` en lugar de centavos `BigInt`; M2 (CHECKs e índices extra)
> **no** se aplicó — es deuda conocida (`docs/CODEMAP.md` §Deuda). Se conserva como registro del
> análisis que originó el build, no como plan vigente.
> Puntos abiertos **P1** (matching de LIMIT) y **P2** (reserva de cash) no se asumen:
> se cierran cuando el humano decide. Alcance del cambio de schema también abierto (ver §Puntos abiertos).
> Fuente: `specs/trading-api-domain.md` (UC-1..UC5), `docs/database.md` (§4/§5/§7), `AGENTS.md`, `db/indexes.sql`.

## Why

La base funciona como libro de movimientos (cash y posiciones son proyecciones de `orders FILLED`)
y ese eje ya está verificado contra el seed. Lo que falta es la **capa de garantías**: sin constraints,
idempotencia, lock de concurrencia ni contrato de unidad de dinero, cada caso de uso es vulnerable a
sobre-giro, ejecución duplicada o pérdida de centavos — errores financieros que no fallan ruidosamente.

---

## M1 — Capa de dinero en centavos enteros (BigInt / Decimal-from-string)

**Porqué**: `AGENTS.md` lo marca no negociable. Hoy `numeric(10,2)` llega a JS como string o Decimal
según config; cualquier path que pase por `number` (o `parseFloat`) introduce IEEE-754. Como `src/`
se reescribe, es el momento de fijar la convención antes de publicar un endpoint.

**Cómo**: montos/precios como `BigInt` en centavos (`amountCents`, `priceCents`) o Decimal de Prisma
leído SIEMPRE como string y convertido con `new Decimal(str)`. Funciones puras (T2: `deriveCash`,
`derivePositions`, `weightedAverageCost`) operan solo en enteros/Decimal. Salida JSON: string, nunca número.
Prohibido `parseFloat`/`Number()` sobre columnas monetarias.

**Casos de uso**: UC-1 (cash, marketValue, totalReturnPct), UC-3 (validación `cash ≥ size×price`,
`floor(amountArs/close)`), UC-5 (CASH_OUT vs cash disponible).

**Tareas**: fijar representación única en la spec → `src/shared/money.ts` (`MoneyCents`, mul/div con
ROUND_DOWN, parse desde string) → unit tests de T2 contra los valores de §3 (cash 753.000,00 user 1).

**Verificación**: `tsc --noEmit` sin errores de money; tests exactos a centavos; grep sin `parseFloat`
sobre dinero.

**Riesgo si no se hace**: diferencias de centavos en P&L y validaciones de fondo; un BUY que "alcanza"
por redondeo float genera saldo negativo silencioso.

## M2 — Aplicar los constraints e índices de `db/indexes.sql` como migración Prisma

**Porqué**: la base real es varchar libre y todo nullable: un INSERT sin `status` rompe la proyección
de cash/posiciones y nada impide un `side` inventado. `db/indexes.sql` ya está redactado y validado
sin conflictos contra el snapshot; falta solo el vehículo (migración Prisma versionada, no psql suelto).

**Cómo**: traducir a la migración de T1: `CHECK` de `side`/`type`/`status`, `size > 0`,
`status NOT NULL DEFAULT 'NEW'`, `datetime DEFAULT now()`, índices `orders(userid, datetime DESC)`,
parcial `orders(status) WHERE status='NEW'`, `orders(instrumentid)`,
`UNIQUE marketdata(instrumentid, date)`, `UNIQUE instruments(upper(ticker))`, `UNIQUE users(lower(email))`.
Sin tocar `db/schema.sql` ni `db/seed.sql` (generados) ni aplicar sobre Neon.

**Casos de uso**: UC-1/UC-2 (queries calientes), UC-3 (validación dura en DB, no solo Zod), UC-4 (índice parcial para `NEW`).

**Verificación**: `prisma validate` + `migrate dev` sin errores; INSERT con `side` inválido o `status`
NULL falla a nivel DB; `EXPLAIN` confirma índices en la query de portfolio.

## M3 — Idempotencia en la DB: UNIQUE + ON CONFLICT DO NOTHING

**Porqué**: la spec exige `Idempotency-Key` opcional y devolver la orden original al repetir; `AGENTS.md`
fija el mecanismo (clave en DB, no en memoria). Un doble-submit o retry duplica una ejecución financiera real.

**Cómo**: `UNIQUE(userid, idempotencyKey)` en orders (o tabla aparte); el INSERT de claim con
`ON CONFLICT DO NOTHING` es la **primera** escritura de la misma transacción que ejecuta la orden;
si conflicta → leer y devolver la original. Key la genera el cliente (UUID v4); Zod valida formato.

**Casos de uso**: UC-3 y UC-5.

**Tareas**: constraint en schema de T1 (preguntar antes, `AGENTS.md`) → patrón claim-and-execute en
services → test de doble-submit concurrente (`Promise.all` de dos POST con misma key) por endpoint de escritura.

**Verificación**: dos POST simultáneos con la misma key → una sola orden FILLED; la segunda devuelve la
original con mismo id. Sin key, comportamiento normal.

**Riesgo si no se hace**: ejecución duplicada → cash debitado dos veces, posición inflada.

## M4 — Concurrencia sobre el débito de cash: lock explícito

**Porqué**: `docs/database.md` §7.2 lo llama "el punto más delicado del challenge": derivar saldos de
orders hace del débito un INSERT, y sin lock dos requests concurrentes validan el mismo cash → sobre-giro.

**Cómo**: toda la ejecución en UNA transacción con aislamiento explícito — `SERIALIZABLE` con retry,
o `SELECT … FOR UPDATE` sobre la fila del user como gate antes de validar fondos. Nunca
read-modify-write ingenuo. Cuidado con el pooler (PgBouncer transaction mode): sin advisory locks de
sesión; `FOR UPDATE` de fila y `SERIALIZABLE` funcionan bien.

**Casos de uso**: UC-3 (BUY con validación de fondo, SELL con validación de posición), UC-5, y P2 si se
implementa reserva.

**Tareas**: elegir estrategia y documentarla en la spec de T3 → un solo `prisma.$transaction` →
test de concurrencia: dos MARKET BUY simultáneos que juntos exceden el cash → exactamente uno FILLED.

**Verificación**: con cash justo para una sola orden: 1 FILLED y 1 REJECTED persistidos; proyección
consistente después de ambas.

## M5 — Precio límite separado del precio de ejecución

**Porqué**: una sola columna `price` que se sobrescribe al llenar una LIMIT contradice el append-only
de la spec (solo `status` es mutable) y borra evidencia de a qué se operó. D1 llena LIMIT "al precio
límite", así que el número no cambia, pero el patrón UPDATE-financiero es una puerta abierta.

**Cómo**: en el schema de T1 agregar `limitPrice` (o fijar semántica: `price` = límite en LIMIT,
ejecución en MARKET) de modo que llenar una LIMIT sea un UPDATE acotado a `status`. Opcional: tabla
`executions` append-only. **Cambio de schema → necesita validación humana** (`AGENTS.md`).

**Tareas**: decidir (humano) precio único vs `limitPrice` vs `executions` → reflejar en migración de T1 →
test de inmutabilidad: al llenar una LIMIT, `size/price/side/type` quedan byte-idénticos.

## M6 — Máquina de estados: compare-and-set como única puerta de mutación

**Porqué**: hoy nada impide FILLED→NEW o cancelar una FILLED si hay un bug en el service. UC-4
prevé el caso (422) y AGENTS.md exige transiciones válidas codificadas + CHECK en DB.

**Cómo**: único UPDATE de status en el repository:
`UPDATE orders SET status=$nuevo WHERE id=$id AND status='NEW'` — `rowCount=0` → 422 sin mutar.
Complemento opcional (decisión humana): trigger de guard de transiciones.

**Tareas**: `updateStatusIfNew` (CAS) → test UC-4 completo → opcional trigger en migración.

**Verificación**: cancelar NEW → CANCELLED; cancelar FILLED/CANCELLED/REJECTED → 422 y fila intacta.

**Riesgo si no se hace**: carrera entre match de LIMIT y cancelación → orden FILLED cancelada, doble movimiento de cash.

## M7 — "No vender lo que no tenés" dentro de la transacción; el seed es dato, no oráculo

**Porqué**: el seed deja BMA en −10 (vendió 30 FILLED con 20 FILLED). La regla dura no tiene CHECK
posible (§7.5): se resuelve dentro de la tx. Los datos históricos no se "arreglan".

**Cómo**: en `executeOrder` SELL, dentro de la tx (mismo gate de M4), calcular posición derivada
(Σ BUY − Σ SELL sobre FILLED); si `size > posición` → persistir REJECTED (hecho de mercado, HTTP 200).
UC-1 no lista posiciones de cantidad 0 y decide explícitamente qué hacer con la negativa heredada.

**Tareas**: validación dentro de la tx (no query previa suelta) → documentar tratamiento de posición
negativa en UC-1 → tests UC-3 (suficiente → FILLED; insuficiente → REJECTED; amountArs con floor).

**Verificación**: test obligatorio de UC-3 con sus 4 escenarios; BMA del seed se ve igual que §3.

## M8 — Lecturas portadas del SQL verificado (portfolio y búsqueda)

**Porqué**: `db/queries/portfolio.sql` ya reproduce exactamente §3 y está validado en Postgres limpio.
Reimplementar desde cero reintroduce drift. Con ~200ms de RTT contra Neon, UC-1 debe ser 1–2 queries,
no N+1 por posición.

**Cómo**: portar la query a Prisma raw (o vista) manteniendo semántica (DISTINCT ON para último precio,
LEFT JOIN por PGR/IRCP/ARS sin velas, exclusión de MONEDA, fallback a avg_price). Agregar
`totalReturnPct` (D2, costo promedio ponderado) y variación diaria (UC-2) sobre la misma base.
Búsqueda UC-2: una sola query ILIKE ticker+name, filtro `type <> 'MONEDA'`.

**Tareas**: portar a repository con extensión D2 (+cash reservado si P2 lo define) → búsqueda UC-2 →
test de contrato T4 con valores esperados calculados a mano.

**Verificación**: GET portfolio user 1 devuelve exactamente §3; "APPL" matchea por prefijo; ARS nunca
aparece en positions ni en búsqueda.

## M9 — Configuración separada de conexión runtime y tests

**Fundamento**: cualquier recomendación sobre DNS, pooling o URLs directas depende del proveedor elegido
y no forma parte del contrato de configuración genérico del repositorio.

**Cómo**: las pruebas de integración usan `TEST_DATABASE_URL` y runtime usa `DATABASE_URL`;
ambas aceptan PostgreSQL compatible con el esquema, sin asumir proveedor, host o puerto.

**Tareas**: config en `src/lib` → script de test DB con template → documentar separación pooler/host en README.

**Verificación**: `npm test` corre en segundos sin red; smoke contra Neon con ipv4first conecta en ~1s.

---

## Puntos abiertos (decisión humana)

1. **P1 — Matching de LIMIT**: D1 define *cuándo* se llena, no el mecanismo. Candidatos: (a) evaluar
   solo al envío contra el último close; (b) re-evaluar on-demand en cada consulta; (c) job contra
   marketdata. El diseño se estructura para que el evaluador sea **intercambiable**: el contrato de
   estados no cambia en ningún caso.
2. **P2 — Reserva de cash por NEW BUY**: recomendación de §7.1 es exponer `cash` + `cashReserved`
   separados (la query ya existe en `portfolio.sql`). No se aplica a la validación de fondos hasta que
   se confirme si el challenge espera reserva o cash simple.
3. **Alcance de la migración Prisma**: ¿solo índices/constraints (`db/indexes.sql`)? ¿También columnas
   nuevas (`limitPrice`, `idempotencyKey`) y/o tabla `audit_log`? Esto decide la forma de M2/M5/M3.
4. **Precio de un MARKET**: el seed sugiere que el precio viene de afuera (órdenes del 12-jul sin vela
   ese día, precios fuera del rango HIGH/LOW). UC-3 asume `close` del último día — supuesto documentado,
   se reabre si aparece otra fuente.
5. **Versión de Prisma**: `prisma@8-rc` (CLI de Platform, flujo `orm/contract/migration`) convive con
   `@prisma/client@7.10.1`. Antes de migrar hay que alinear versión (¿bajar CLI a 7.x o pasar todo a 8-rc?).
