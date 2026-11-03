# Cocos Challenge — Backend

API REST para consultar el portfolio de un usuario, buscar instrumentos, enviar órdenes al mercado (`MARKET` / `LIMIT`), cancelar órdenes en estado `NEW` y registrar transferencias de cash (`CASH_IN` / `CASH_OUT`).

> Resolución del challenge técnico. **No hay tabla de cash ni de posiciones: ambas son proyecciones de `orders`** (ver [docs/database.md](docs/database.md)). Todo lo documentado acá fue ejecutado contra una base real: los comandos del quickstart y los ejemplos de los endpoints salen de corridas contra PostgreSQL 18 con el seed cargado.

## Stack

| Capa | Tecnología |
| ---- | ---------- |
| Runtime | Node.js 26 (verificado: v26.12.1) · TypeScript 5.9 (ESM, `module=nodenext`) |
| Framework HTTP | Express 5 |
| Acceso a datos | Prisma 7 (`@prisma/client` 7.10.1 + `@prisma/adapter-pg` driver adapter) |
| Validación | Zod 4 (borde HTTP estricto) |
| Dinero | `decimal.js` — **nunca float** (ver [Supuestos](#supuestos-y-decisiones)) |
| Base de datos | PostgreSQL 18 (verificado en un cluster userspace local; `docker-compose.yml` con Postgres 16 para otros entornos) |
| Testing | Jest 30 + ts-jest + supertest (15 suites / 159 tests verdes) |

## Quickstart

Secuencia **corrida y verificada** en una base scratch (`cocos_challenge_readme`) sobre el Postgres 18 local (`localhost:5433`, auth trust). Salidas reales de esa corrida en [Verificación del quickstart](#verificación-del-quickstart-corrida-real).

### Requisitos previos

- Node.js ≥ 20 (verificado con v26.12.1) y npm ≥ 10 (verificado con 12.0.2).
- Un PostgreSQL ≥ 15 accesible (verificado con 18.6) con el cliente `psql`.
- `npm install` instala dependencias y genera el cliente de Prisma (`allowScripts` del `package.json` habilita los postinstall de `prisma` y `@prisma/engines`, necesarios para que el CLI 7.x baje binarios).

### Base de datos — vía con docker (estándar del repo)

`docker-compose.yml` define un Postgres 16 en el puerto **5433** (para no chocar con un Postgres instalado):

```bash
docker compose up -d db     # Postgres en localhost:5433, user postgres, DB cocos_challenge
```

> En la máquina donde se verificó esta entrega **no hay docker**: la vía verificada es la de abajo. `docker compose up -d db` queda como la vía estándar para entornos con docker.

### Base de datos — vía sin docker (verificada en esta entrega)

Acá corre un **cluster userspace de PostgreSQL 18** en `localhost:5433` con auth trust (sin password). Si tenés un Postgres instalado que escucha en otro puerto, vale igual: todo lo que sigue sólo depende de la `DATABASE_URL`.

```bash
# (sólo si el cluster userspace está apagado — no corre en la máquina de verificación)
/usr/lib/postgresql/18/bin/pg_ctl -D ~/.pg/cocos -o '-p 5433 -k /tmp' -l ~/.pg/cocos.log start
```

### 1. Instalar

```bash
npm install
```

### 2. Crear la base vacía

```bash
psql postgresql://postgres@localhost:5433/postgres -c 'DROP DATABASE IF EXISTS cocos_challenge_readme'
psql postgresql://postgres@localhost:5433/postgres -c 'CREATE DATABASE cocos_challenge_readme TEMPLATE template0'
```

> ⚠️ **No uses `make db-load` para cargar una base nueva**: aplica `db/schema.sql`, que es el **snapshot legacy SIN** las columnas nuevas (`"timeInForce"`, `filledPrice`, `filledAt`, `idempotencyKey`) ni la tabla `order_events` — la app no funciona contra ese esquema. El esquema vigente sale de las **migraciones de Prisma** (ver [docs/database.md](docs/database.md)).

### 3. Aplicar la migración

```bash
DATABASE_URL=postgresql://postgres@localhost:5433/cocos_challenge_readme npx prisma migrate deploy
```

### 4. Cargar los datos del seed

```bash
psql postgresql://postgres@localhost:5433/cocos_challenge_readme -v ON_ERROR_STOP=1 -q -f db/seed.sql
```

Verificación de la carga (salida real de la corrida): 4 usuarios, 66 instrumentos, 11 órdenes, 126 filas de `marketdata`.

### 5. Correr los tests

Los tests de integración/DB corren contra `cocos_challenge_test`; las suites funcionales se auto-resetean contra sus propias bases (ver [Tests](#tests)). Flujo completo:

```bash
npm run test:db:reset   # (re)crea cocos_challenge_test desde la migración + seed, sin docker
npm test                # 15 suites / 159 tests
```

### 6. Levantar el servidor y probarlo

`npm run dev` lee `PORT` y `DATABASE_URL` de un `.env` en la raíz (no se versiona; tomá `.env.example` como referencia):

```env
PORT=3000
DATABASE_URL=postgresql://postgres@localhost:5433/cocos_challenge_readme
```

```bash
npm run dev
# ✓ cocos-challenge-backend escuchando en http://localhost:3000
```

Request exitoso contra la base con seed (user 1):

```bash
curl http://localhost:3000/api/users/1/portfolio
```

```json
{
  "cash": 627500,
  "reservedCash": 125500,
  "totalAccountValue": 764256,
  "positions": [
    { "ticker": "BMA",  "name": "Banco Macro S.A.",   "quantity": -10, "marketValue": -15028,  "priceAvailable": true, "totalReturnPct": -2.42 },
    { "ticker": "PAMP", "name": "Pampa Holding S.A.", "quantity": 40,  "marketValue": 37034,   "priceAvailable": true, "totalReturnPct": -0.45 },
    { "ticker": "METR", "name": "MetroGAS S.A.",      "quantity": 500, "marketValue": 114750, "priceAvailable": true, "totalReturnPct": -8.2 }
  ]
}
```

`cash` = disponible (`cashSettled − cashReserved`), no el settled: 753000 − 125500 = 627500. `totalAccountValue` = cash + Σ `marketValue` de las posiciones con precio (la negativa BMA resta).

### Verificación del quickstart (corrida real)

Pasos 2–4 y 6 corridos por el autor de esta entrega contra `cocos_challenge_readme`:

```
$ psql ... -c 'DROP DATABASE IF EXISTS cocos_challenge_readme'
DROP DATABASE
$ psql ... -c 'CREATE DATABASE cocos_challenge_readme TEMPLATE template0'
CREATE DATABASE

$ DATABASE_URL=... npx prisma migrate deploy
Datasource "db": PostgreSQL database "cocos_challenge_readme", schema "public" at "localhost:5433"
Applying migration `20261103003419_init_trading_api`
All migrations have been successfully applied.

$ psql ... -v ON_ERROR_STOP=1 -q -f db/seed.sql
seed OK   (4 users · 66 instruments · 11 orders · 126 marketdata)

$ npm run dev
✓ cocos-challenge-backend escuchando en http://localhost:3000

$ curl http://localhost:3000/api/users/1/portfolio
→ 200 {"cash":627500,"reservedCash":125500,"totalAccountValue":764256,...}

$ curl -X POST http://localhost:3000/api/users/2/transfers \
    -H 'Content-Type: application/json' -d '{"amountArs":123.45,"side":"CASH_IN"}'
→ 201 {"id":20,"instrumentId":66,"side":"CASH_IN","type":"MARKET","timeInForce":"GTC",
       "status":"FILLED","size":123,"price":1,"filledPrice":1,...,"reason":null}
```

## Endpoints

Base URL: `http://localhost:3000/api`. Colección lista para disparar (VS Code REST Client): [`collection/`](collection/).

Body de error uniforme (todos los 4xx):

```json
{ "error": { "code": "USER_NOT_FOUND", "message": "No existe el usuario 999." } }
```

| Código | Status | Cuándo |
| ------ | -----: | ------ |
| `VALIDATION_ERROR` | 400 | Body/params/query/header inválidos (Zod) — **sin crear nada** |
| `INSTRUMENT_NOT_OPERABLE` | 400 | El instrumento es `MONEDA` (ej. ARS) |
| `USER_NOT_FOUND` | 404 | `userId` inexistente |
| `ORDER_NOT_FOUND` | 404 | `orderId` inexistente (DELETE) |
| `INSTRUMENT_NOT_FOUND` | 404 | `instrumentId`/`ticker` inexistente en POST /orders |
| `IDEMPOTENCY_CONFLICT` | 409 | Misma `Idempotency-Key` con payload distinto |
| `ORDER_NOT_CANCELLABLE` | 422 | Cancelar una orden que no está `NEW` |

> `INSTRUMENT_NOT_FOUND` es el único código fuera de `API_ERROR_CODES` (los estables del contrato): `DECISIONS.md` no fija status para instrumento inexistente; se resolvió 404 y se documenta acá.

### 1. Portfolio — `GET /api/users/:userId/portfolio`

**Response 200** (ejemplo real arriba):

| Campo | Significado |
| ----- | ----------- |
| `cash` | Disponible para operar = `cashSettled − cashReserved` |
| `reservedCash` | Reservado por órdenes `NEW` BUY (`limit × size`) |
| `totalAccountValue` | `cash + Σ marketValue` de las posiciones **con** precio |
| `positions[]` | `{ticker, name, quantity, marketValue, priceAvailable, totalReturnPct}` |

- Sin precio de referencia: `marketValue: null`, `priceAvailable: false`, `totalReturnPct: null`, y **no suma** al total.
- `MONEDA` (ARS) nunca aparece; posición con cantidad 0 no se lista; la negativa del seed (BMA −10) se lista tal cual.
- Errores: `400 VALIDATION_ERROR` (userId no entero > 0) · `404 USER_NOT_FOUND`.

### 2. Buscar instrumentos — `GET /api/instruments?query=<texto>&limit=20`

Match parcial case-insensitive sobre `ticker` **y/o** `name`. `limit` opcional (1–100, default 20). **Respuesta: array plano** (sin wrapper). `MONEDA` no aparece.

```bash
curl "http://localhost:3000/api/instruments?query=METR"
```

```json
[
  {
    "ticker": "METR",
    "name": "MetroGAS S.A.",
    "type": "ACCIONES",
    "price": 229.5,
    "previousClose": 232,
    "dailyVariationPct": -1.08
  }
]
```

`price` = `close` de la última fila de `marketdata` por `date`; sin marketdata (ej. `PGR`, `IRCP`) → `price`/`previousClose`/`dailyVariationPct` en `null`.

Errores: `400 VALIDATION_ERROR` — `query` vacía o ausente (`?query=` → 400), `limit` fuera de 1..100.

### 3. Enviar orden — `POST /api/users/:userId/orders`

**Request** (body JSON):

| Campo | Regla |
| ----- | ----- |
| `instrumentId` \| `ticker` | exactamente **uno** de los dos |
| `size` \| `amountArs` | exactamente **uno**: acciones enteras > 0, o monto en ARS > 0 (número o string) del que se deriva `size = floor(amountArs / precio)` |
| `side` | `BUY` \| `SELL` |
| `type` | `MARKET` \| `LIMIT` |
| `price` | > 0 **obligatorio si `LIMIT`** · **prohibido si `MARKET`** (se ejecuta al precio de referencia) |
| `timeInForce` | opcional: `GTC` (default) \| `IOC` \| `FOK` |

**Header opcional:** `Idempotency-Key` (string de 1–64; ausente ⇒ sin idempotencia, inválido ⇒ 400).

**Response 201** — `OrderResponse`, **siempre que la orden se persistió** (`FILLED`, `NEW`, `REJECTED` o `CANCELLED`):

```json
{
  "id": 13,
  "instrumentId": 47,
  "side": "BUY",
  "type": "MARKET",
  "timeInForce": "GTC",
  "status": "FILLED",
  "size": 1,
  "price": null,
  "filledPrice": 925.85,
  "filledAt": "2026-11-02T23:29:32",
  "datetime": "2026-11-02T23:29:32",
  "reason": null
}
```

| Campo | Significado |
| ----- | ----------- |
| `price` | **límite enviado** (`LIMIT`); `null` en `MARKET` |
| `filledPrice` | **precio de ejecución** si `FILLED`; `null` si no ejecutó |
| `reason` | `INSUFFICIENT_FUNDS` · `INSUFFICIENT_POSITION` · `ZERO_SIZE` · `NO_PRICE` · `NO_IMMEDIATE_MATCH`; `null` en `NEW`/`FILLED` y en la respuesta de un DELETE |
| `datetime`/`filledAt` | ISO 8601 **sin offset** (timestamp sin zona, hora local del mercado) |

Comportamiento por tipo (precios de referencia del seed: PAMP 925.85, METR 229.50, BMA 1502.80 — última `marketdata` por `date`):

- `MARKET` → `FILLED` al precio de referencia en la misma transacción.
- `LIMIT GTC` → siempre `NEW` (reserva `limit × size` de cash en BUY; `size` acciones en SELL).
- `LIMIT IOC/FOK` → una evaluación contra la referencia: cruza → `FILLED` **con mejora** (BUY a `min(límite, ref)`; SELL a `max`); no cruza → `CANCELLED` con `reason NO_IMMEDIATE_MATCH` (201).

Errores: `400 VALIDATION_ERROR` (XORs, `LIMIT` sin `price`, `MARKET` con `price`, header inválido) · `400 INSTRUMENT_NOT_OPERABLE` (MONEDA) · `404 USER_NOT_FOUND` · `404 INSTRUMENT_NOT_FOUND` · `409 IDEMPOTENCY_CONFLICT`. El rechazo del negocio **se persiste** (`201 REJECTED` con `reason`), no es error HTTP: fondos/tenencia insuficientes, `ZERO_SIZE`, `NO_PRICE`.

**Idempotencia** (ejemplos verificados, user 2 del seed):

```bash
# 1º envío con key → crea la orden (acá REJECTED por fondos: user 2 no tiene cash)
curl -X POST http://localhost:3000/api/users/2/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-key-1' \
  -d '{"ticker":"PAMP","side":"BUY","type":"LIMIT","size":1,"price":100}'
→ 201 {"id":14,...,"status":"REJECTED","reason":"INSUFFICIENT_FUNDS"}

# Misma key + MISMO payload → la orden ORIGINAL (201, id 14, sin nuevo evento)
→ 201 {"id":14,...,"reason":null}     # reason null en el replay: la razón vive en order_events

# Misma key + OTRO payload → 409
curl -X POST http://localhost:3000/api/users/2/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-key-1' \
  -d '{"ticker":"PAMP","side":"BUY","type":"LIMIT","size":2,"price":100}'
→ 409 {"error":{"code":"IDEMPOTENCY_CONFLICT","message":"Idempotency-Key ya usada con otro payload (orden existente 14)."}}
```

### 4. Cancelar orden — `DELETE /api/orders/:orderId`

Sólo órdenes `NEW`. **Response 200** con la `OrderResponse` cancelada (201 es para creaciones; el status de cancelación no estaba fijado y se firmó 200):

```bash
curl -X DELETE http://localhost:3000/api/orders/5   # orden NEW del seed (LOMA BUY LIMIT 50 @ 710)
→ 200 {"id":5,"instrumentId":45,"side":"BUY","type":"LIMIT","timeInForce":"GTC",
       "status":"CANCELLED","size":50,"price":710,...,"reason":null}
```

Al cancelar una `NEW` **se libera su reserva** (visible en `reservedCash` del portfolio). Errores: `400 VALIDATION_ERROR` (orderId no entero > 0) · `404 ORDER_NOT_FOUND` · `422 ORDER_NOT_CANCELLABLE` (ej. `DELETE /api/orders/6`, la orden `REJECTED` del seed).

### 5. Transferencias — `POST /api/users/:userId/transfers`

**Request:** `{"amountArs": <monto en ARS > 0, número o string>, "side": "CASH_IN" | "CASH_OUT"}` · header `Idempotency-Key` opcional.

Transferencia = **orden** del instrumento MONEDA del cash (ticker `ARS`, id 66) con `price = 1.00` y `size` = pesos (convención del seed). `CASH_IN` → `FILLED` inmediata; `CASH_OUT` valida contra el **disponible** (`settled − reservas`) → `REJECTED INSUFFICIENT_FUNDS` persistida (201) si no alcanza.

```bash
curl -X POST http://localhost:3000/api/users/2/transfers \
  -H 'Content-Type: application/json' -d '{"amountArs":123.45,"side":"CASH_IN"}'
→ 201 {"id":20,"instrumentId":66,"side":"CASH_IN","type":"MARKET","timeInForce":"GTC",
       "status":"FILLED","size":123,"price":1,"filledPrice":1,...,"reason":null}

curl -X POST http://localhost:3000/api/users/2/transfers \
  -H 'Content-Type: application/json' -d '{"amountArs":1000000,"side":"CASH_OUT"}'
→ 201 {"id":21,...,"status":"REJECTED","size":1000000,...,"reason":"INSUFFICIENT_FUNDS"}
```

Errores: `400 VALIDATION_ERROR` (monto ≤ 0 o basura, side inválido) · `404 USER_NOT_FOUND` · `409 IDEMPOTENCY_CONFLICT`. `size` es entero en pesos: `CASH_IN 123.45` acredita **123** (el residual `0.45` queda en la metadata del evento — ver [Límites](#límites-conocidos)). `0 < amountArs < 1` → `REJECTED ZERO_SIZE` (201).

## Supuestos y decisiones

Decisiones de diseño con su porqué. La lista inmutable de decisiones del build vive en `DECISIONS.md`; acá se explica cada una y se agregan las firmadas por el orquestador durante la integración.

### Precios y ejecución

1. **Precio de referencia = última fila de `marketdata` por `date`** (no `datetime`). Es la semántica de "último precio" del dataset (velas diarias): por `datetime` empataría fechas por la hora. Sin precio: `marketValue: null`, `priceAvailable: false`, la posición no suma al total, y las órdenes que lo necesitan se rechazan con `NO_PRICE` — nunca se inventa un precio (`PGR`/`IRCP` del seed no tienen marketdata).
2. **`MARKET` se ejecuta al precio de referencia y queda `FILLED` en la misma transacción.** No hay motor de matching (el challenge dice que no hace falta simular el mercado); el `close` de la última vela es el "mercado".
3. **`LIMIT GTC` siempre queda `NEW` al enviarse** (nunca se llena en el envío). Un `GTC` es una orden *resting*: se graba con su límite y **reserva** los recursos (cash en BUY, acciones en SELL) para que el usuario no pueda comprometerlos dos veces.
4. **`LIMIT IOC/FOK` se evalúan una única vez contra el precio de referencia.** Cruza → `FILLED` **con mejora**: BUY paga `min(límite, ref)` (nunca más caro que su límite), SELL cobra `max(límite, ref)`. No cruza → `CANCELLED` con razón `NO_IMMEDIATE_MATCH`, persistida (201). **Sin fills parciales**: `IOC/FOK` son todo-o-nada en esta implementación.
5. **`matchRestingOrders(refPrice, orders)` es una función pura, testeada, sin disparador automático.** Existe y está testeada como punto de enchufe para la evolución (matching de las `NEW` contra nuevos precios), pero ningún código la llama en el flujo de producción: el alcance quedó cerrado sin matching continuo. Ver [Evolución propuesta](#evolución-propuesta).

### Cash, reservas y posiciones

6. **No hay tabla de cash ni de posiciones: se derivan de `orders`.** Cash = Σ movimientos `FILLED` (`CASH_IN`/`SELL` suman `size × price`; `CASH_OUT`/`BUY` restan). Derivar de la única fuente de verdad evita saldos desincronizados entre una tabla y las órdenes.
7. **Reservas derivadas de las órdenes `NEW`, sin tabla.** BUY `NEW` reserva `limit × size` de cash; SELL `NEW` reserva `size` acciones. **`cash disponible = cashSettled − cashReserved`** (el portfolio reporta `cash` disponible y `reservedCash` por separado). **`CASH_OUT` valida contra el disponible**, no contra el settled: las `NEW` son compromisos reales de plata ya prometida.
8. **BUY valida fondos contra el cash disponible; SELL contra las acciones vendibles** (posición `FILLED` del instrumento − acciones reservadas por `NEW` del mismo instrumento). Es la misma lectura que el punto anterior aplicada a ambos lados: dos submits que juntos exceden el cash dejan una `FILLED` y una `REJECTED` (testeado).
9. **P&L no realizado sobre costo promedio ponderado; las ventas no tocan el promedio.** El costo de la posición es el de las compras que la forman; vender cambia la cantidad, no el costo unitario de lo que queda. **Posición con cantidad 0 no se lista** (dejar de existir no es tenerla en 0). **Posición negativa heredada del seed (BMA −10) se lista tal cual** — ver [Posición negativa del seed](#posición-negativa-del-seed-bma--10).
10. **`amountArs`: `size = floor(amount / precio)`; `size 0` → `REJECTED ZERO_SIZE`.** El challenge pide "la cantidad de acciones máximas que puede enviar, sin fracciones": el `floor` garantiza que nunca se compromete más que el monto (el residuo queda como cash). Con `LIMIT` el precio de sizing es el **límite** (el peor precio aceptable para un BUY: nunca se compromete más que el monto a ese precio); con `MARKET`, la referencia.
11. **El dinero nunca es float.** Interno: `Decimal` (decimal.js). Entrada: número o string parseado con `Decimal` (un JSON `number` se convierte con `String(value)` — la repr más corta exacta — jamás `new Decimal(number)`). Salida: números con 2 decimales (`serializeMoneyArs` cuantiza a 2 decimales **antes** de serializar). El float no puede representar `0.1` y rompe cualquier aritmética de plata.
12. **`orders.price` = límite enviado; `orders.filledPrice` = precio de ejecución.** Una sola columna `price` perdería el límite original al llenar la orden. La migración agrega `filledPrice`/`filledAt`; el mapper de lectura aplica `filledPrice ?? price` para las filas legacy del seed (su `price` ya trae la ejecución y su `filledPrice` es `NULL`).

### Idempotencia y concurrencia

13. **Idempotencia por header `Idempotency-Key` (opcional), `UNIQUE(userId, idempotencyKey)` en la tabla.** El `INSERT` de la orden es la **primera escritura** de la transacción, con `ON CONFLICT DO NOTHING`: si la key ya existe no se crea nada (el payload ya se comparó en el repositorio) → misma key + mismo payload devuelve la **orden original** (201, sin evento nuevo); misma key + payload distinto → **409**. Así un retry de red nunca duplica una orden ni inventa un resultado.
14. **Validación + inserción en una transacción con lock por usuario** (`pg_advisory_xact_lock(userId)` dentro de `withUserTransaction`). Los submits/cancelaciones/transferencias de un usuario se serializan: dos requests concurrentes que juntos exceden el cash no pueden ambos pasar la validación (el segundo ya ve el cash debitado). Lock por usuario, no global: usuarios distintos no se bloquean entre sí.

### HTTP y contratos

15. **Éxito `201` también para `REJECTED`/`CANCELLED` persistidas.** El endpoint cumplió: recibió la orden, la evaluó y la grabó con su estado. Reservar 4xx para eso confundiría "input inválido" con "orden válida rechazada por el negocio". En cambio: **input inválido → 400 sin crear nada** (ni orden ni evento), **usuario inexistente → 404**, **cancelar una no-`NEW` → 422**. Body de error uniforme `{"error":{"code","message"}}`.
16. **Las razones viven en `order_events`** (auditoría append-only): `INSUFFICIENT_FUNDS`, `INSUFFICIENT_POSITION`, `ZERO_SIZE`, `NO_PRICE`, `NO_IMMEDIATE_MATCH` — con metadata del porqué (precio de referencia, requerido vs disponible, residuo de sizing). Un rechazo sin explicación es indepurable.
17. **`timeInForce` `NOT NULL DEFAULT 'GTC'` en DB.** Toda orden conoce su TIF; las filas del seed (copiadas sin la columna) quedan en `GTC`, que es el comportamiento resting correcto de una LIMIT legacy; el TIF se ignora para `MARKET`.
18. **`datetime`/`filledAt` serializan ISO 8601 sin offset.** La columna es `timestamp` sin zona, en hora local del mercado; inventarle un offset al dato sería mentir sobre el dataset.
19. **MONEDA no es operable** (ni `BUY`/`SELL` de ARS, ni en búsqueda, ni en `positions`): el cash no es una posición de trading, es el saldo — operarlo sería mover el saldo "comprándose" a sí mismo. Las transferencias (`CASH_IN`/`CASH_OUT`) son el único camino legítimo, y modeladas como órdenes del instrumento ARS con `price=1.00, size=pesos` (la convención del seed) para que la proyección de cash las procese como cualquier otra orden.
20. **Índices: una sola fuente (`prisma/schema.prisma`).** Mínimos: `orders(status, instrumentId)` (consultas por estado+instrumento), `orders(userId, status)` (fondos/tenencia de un usuario por estado), `marketdata(instrumentId, date DESC)` ("último precio" sin escanear velas viejas), más `orders(userId, idempotencyKey)` UNIQUE (la idempotencia) y `order_events(orderId)` (la auditoría). El DDL real es la migración de Prisma; `db/schema.sql` es un snapshot generado desactualizado (ver [docs/database.md](docs/database.md)).

### Rutas

21. **Las 5 rutas** (`GET /api/users/:userId/portfolio`, `GET /api/instruments?query=`, `POST /api/users/:userId/orders`, `DELETE /api/orders/:orderId`, `POST /api/users/:userId/transfers`) siguen la convención REST de recursos: `userId` en el path de sus órdenes/transferencias, `orderId` en el path del DELETE, `query` como parámetro de búsqueda.

### Decisiones firmadas por el orquestador en integración

22. **DELETE exitoso → `200`** (no 201): el 201 quedó reservado para creación; la cancelación devuelve la orden `CANCELLED` con 200.
23. **Evento `CANCELLED` por usuario con `reason: null` y metadata `{origin: "USER"}`**: las razones del contrato son de rechazo/no-cruce, no de una cancelación pedida; el origen viaja en metadata.
24. **El instrumento del cash se resuelve por ticker `"ARS"`** (vía port), no por id hardcodeado: el id 66 es un dato del seed, el ticker es el identificador estable.
25. **`size` en una transferencia `REJECTED` = el monto pedido** (no 0): el `floor` no interviene (price 1.00) y la orden se rechaza por fondos — registrar `size 0` escondería qué se pidió. El `ZERO_SIZE` de una transferencia (`0 < amountArs < 1` peso) **sí** persiste `size 0` como sub-caso de la misma regla de `DECISIONS.md` (rama testeada).
26. **El replay idempotente devuelve `reason: null`**: la respuesta re-envía la fila original; la razón de su rechazo ya vive en `order_events` (verificado en vivo arriba).
27. **`INSTRUMENT_NOT_FOUND` → 404** (no fijado por `DECISIONS.md`; la spec sugería 400): "no existe el recurso apuntado" es semántica de 404, igual que el usuario.

## Posición negativa del seed (BMA −10)

El dataset trae una **inconsistencia documentada, no corregida**: el usuario 1 vendió 30 BMA (orden 11, `FILLED`) con sólo 20 compradas `FILLED` (orden 9); la compra de 60 (orden 7) quedó en `NEW`. La posición resultante es **−10**.

- La API **la lista tal cual** (`quantity: -10`, `marketValue: -15028`) y **resta** del `totalAccountValue`. Corregirla en la lectura sería falsificar el dataset.
- La validación de venta (`SELL` contra posición `FILLED` − reservadas) **la habría rechazado** de entrar hoy: con la posición en −10 y 60 acciones reservadas, cualquier `SELL` de BMA sale `REJECTED INSUFFICIENT_POSITION`. El seed no es oráculo de negocio, es un dataset de ejemplo (más inconsistencias en [docs/database.md §4](docs/database.md)).

## Límites conocidos

- **Transferencias fraccionarias:** `size` es entero en pesos ⇒ `CASH_IN 123.45` acredita **123** (verificado en vivo). El residuo queda registrado (`residualArs: "0.45"`) en la metadata del evento, **no** acreditado al cash.
- **Fills parciales no modelados:** una `IOC` que cruza se llena completa o se cancela (todo-o-nada), sin ejecución parcial del tamaño.
- **Matching sin disparador:** `matchRestingOrders` existe (función pura testeada) pero **nada la llama en producción** — las `NEW` no se llenan cuando cambia el precio de referencia. Punto de enchufe documentado.
- **Sin autenticación:** `userId` viene del path y se confía (el challenge lo explicita). Cualquier `userId` del seed opera su cuenta.
- **Warning preexistente de Jest:** al correr `npm test`, Jest 30 + ts-jest emite un warning de "worker process" heredado de la config (`jest.config.js` con `projects`); no afecta los 159 tests ni sus resultados.
- **`make db-load` / `db/schema.sql` cargan el snapshot legacy** (sin `"timeInForce"`/`filledPrice`/`filledAt`/`idempotencyKey` ni `order_events`): usar `prisma migrate deploy` + `db/seed.sql` (como en el quickstart). El target queda para recargar el dataset original de referencia.
- **`npm run build` compila también `tests/`** (no hay `tsconfig.build.json` con rootDir): el build de producción no está en el alcance de esta entrega.
- **Docker no verificado en esta máquina** (no hay docker): la vía de base de datos verificada es el cluster userspace PG 18; `docker-compose.yml` queda como referencia para otros entornos.

## Evolución propuesta

Fuera del alcance firmado (`DECISIONS.md`); cada ítem con su vía de enchufe:

- **Fuente de precios real (Yahoo/PriceSource):** hoy la referencia sale de `marketdata` (dataset estático); un `PriceSource` como puerto alternativo inyectable devolvería cotizaciones vivas sin tocar los casos de uso.
- **`price_ticks` e ingesta:** una tabla de ticks + un ingesto periódico daría precio intra-diario (hoy la "última" vela es del 14-jul del seed); la resolución de la referencia ya está aislada en `getLatestSnapshot`.
- **Disparador de `matchRestingOrders`:** el paso que falta del matching — un job (o el alta de cada vela) que llame a la función pura ya testeada y llene/cancele las `NEW` según cruce, con su evento `FILLED` en `order_events`.
- **`DAY` / `EXPIRED`:** nuevo valor de `TimeInForce` + nuevo `OrderStatus`; las `DAY` no cruzadas al cierre expiran. Es literalmente el `EXPIRED` que `DECISIONS.md` dejó fuera.
- **`ExpirationSweep`:** el barrido que pasa `DAY` vencidas a `EXPIRED` (y libera su reserva), espejo del disparador de matching.
- **Fills parciales:** ejecución por tramos contra el book (o contra el precio de referencia); requiere modelar múltiples fills por orden (hoy `filledPrice`/`filledAt` son uno solo).
- **Prioridad precio-tiempo:** ordenar el cruce de las `NEW` por `price` (más agresiva primero) y `datetime`; hoy `matchRestingOrders` no garantiza ese orden porque no hay matching real.

## Tests

```bash
npm run test:db:reset   # (re)crea cocos_challenge_test desde la migración versionada + seed (sin docker)
npm test                # 15 suites / 159 tests — verificado verde en esta entrega
```

- **Unit** (`tests/unit/domain`): funciones puras (derivación de cash/posiciones/reservas, `evaluateCross`, `matchRestingOrders`, sizing).
- **Integration** (`tests/integration/infra` + smoke): repos Prisma contra Postgres real, con `cocos_challenge_test` (la crea `npm run test:db:reset`).
- **Functional** (`tests/functional/**`): los 5 endpoints vía supertest; cada suite **se auto-resetea** su propia base (`TEST_DB_NAME`) en `beforeAll` — correr `npm test` dos veces seguidas da verde.
- `npm run typecheck` (`tsc --noEmit`, nodenext) y `npm run lint` (eslint 9 flat config) completan el gate local.

## Estructura del proyecto

```
src/
  contracts/     # shapes de request/response + enums + dinero (Zod) — única fuente de los payloads
  domain/        # funciones puras (deriveCash, derivePositions, evaluateCross, matchRestingOrders)
  domain/ports/  # interfaces de los repos (DI: nunca concreciones)
  infra/prisma/  # repos Prisma (mappers fila ↔ record) + tx con pg_advisory_xact_lock
  application/   # casos de uso: orders/submit, cancel, transfers/submit
  http/          # routers Express por slice (finos: Zod → use case → status) + server.ts (composición)
  index.ts       # entry: dotenv + listen
prisma/          # schema.prisma (fuente única de índices) + migrations/
db/              # snapshot legacy (schema.sql), seed.sql (datos del challenge), queries/, indexes.sql
collection/      # ejemplos REST Client (.http) — ver arriba
tests/           # unit / integration / functional (auto-reset por suite)
docs/            # database.md (esquema legacy vs migrado, semántica de orders)
```

## Autor

David — [@Cofiagus](https://github.com/Cofiagus)