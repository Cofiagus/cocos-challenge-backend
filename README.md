# Cocos Challenge — Backend

API REST para consultar el portfolio de un usuario, buscar instrumentos, enviar órdenes al mercado (`MARKET` / `LIMIT`), cancelar órdenes en estado `NEW` y registrar transferencias de cash (`CASH_IN` / `CASH_OUT`).

> Resolución del challenge técnico. **No hay tabla de cash ni de posiciones: ambas son proyecciones de `orders`** (ver [docs/database.md](docs/database.md)). Los comandos del quickstart y los ejemplos de los endpoints salen de corridas contra PostgreSQL 18 con el seed cargado (contrato anterior al de grandes montos).

> **Grandes montos (spec aprobada):** [`specs/datos-financieros-grandes-montos.md`](specs/datos-financieros-grandes-montos.md) Rev. 2 (D1–D5 firmadas) cambia el formato del dinero en todo el contrato: entra como **string decimal estricto**, sale como **string con 2 decimales**, `quantity` del portfolio es **string entero** y el `size` de la respuesta es `number` en órdenes de trading pero **string monetario** en transferencias. Es un **cambio incompatible** con el contrato anterior (dinero `number`): los clientes se actualizan en coordinación con el despliegue (ver [Migración coordinada](#migración-coordinada-de-grandes-montos)). La implementación está **verificada por suites automatizadas contra DB de test real** (37 suites / 515 tests en verde, 0 open handles; comandos, matriz de aceptación y límites de esa evidencia en [`docs/references/large-money-verification.md`](docs/references/large-money-verification.md)). Esa verificación **no** incluye una corrida manual íntegra de [`collection/`](collection/) ni de los ejemplos `curl` de este README: los `id` de los ejemplos siguen siendo ilustrativos. Esta verificación **no** aplicó migraciones a la DB de la app: el despliegue requiere la ventana coordinada de [Migración coordinada](#migración-coordinada-de-grandes-montos) y el estado de células/gates lo registra `PROGRESS.md`.

## Quickstart

1. Configurá `DATABASE_URL` en `.env` para desarrollo o en el gestor de secretos de tu entorno de despliegue. `.env.example` sólo muestra el formato; no contiene credenciales reales.
2. Instalá dependencias y generá el cliente si hace falta:

```bash
npm install
npx prisma generate
```

3. Sobre una base vacía o preparada para esta versión, aplicá las migraciones y cargá el seed del challenge **sólo si corresponde a esa base**:

```bash
npx prisma migrate deploy
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f db/seed.sql
```

El seed modifica datos; no lo ejecutes sobre una base con datos que quieras conservar. La app acepta cualquier PostgreSQL compatible configurado en `DATABASE_URL`; no uses esa misma URL para suites de integración que resetean datos.

4. Iniciá el servidor:

```bash
npm run dev
```

Verificación: `curl http://localhost:3000/api/users/1/portfolio` → `200` con `"totalAccountValue": "889756.00"` **cuando** la DB contiene el seed del challenge.

**Configuración:** copiá `.env.example` a `.env` y reemplazá el placeholder de `DATABASE_URL` por la URL de la base elegida. En producción, configurá `DATABASE_URL` en el entorno/secret manager; no subas `.env` ni pegues credenciales en el repositorio. Para tests destructivos configurá una `TEST_DATABASE_URL` independiente, incluso si apunta a otra DB del mismo servidor PostgreSQL.

**Requisitos:** Node.js ≥ 22 (`engines` del `package.json`) · PostgreSQL compatible con el esquema/migraciones · `psql` para cargar el seed · `npm install` instala dependencias; `npx prisma generate` genera el cliente.

## Stack

| Capa | Tecnología |
| ---- | ---------- |
| Runtime | Node.js 26 (verificado: v26.12.1) · TypeScript 5.9 (ESM, `module=nodenext`) |
| Framework HTTP | Express 5 |
| Acceso a datos | Prisma 7 (`@prisma/client` 7.10.1 + `@prisma/adapter-pg` driver adapter) |
| Validación | Zod 4 (borde HTTP estricto) |
| Dinero | `decimal.js` con constructor financiero aislado de precisión 64 — **nunca float**; entrada y salida HTTP en **string** (ver [Supuestos](#supuestos-y-decisiones)) |
| Base de datos | PostgreSQL compatible con las migraciones de Prisma; la URL se configura por `DATABASE_URL` |
| Testing | Jest 30 + ts-jest + supertest |

## Endpoints

Base URL: `http://localhost:3000/api`. Colección lista para disparar (VS Code REST Client): [`collection/`](collection/).

Body de error uniforme (todos los errores, 4xx y 5xx):

```json
{ "error": { "code": "USER_NOT_FOUND", "message": "No existe el usuario 999." } }
```

| Código | Status | Cuándo |
| ------ | -----: | ------ |
| `VALIDATION_ERROR` | 400 | Body/params/query/header inválidos (Zod) — **sin crear nada** |
| `INVALID_JSON` | 400 | El body no parsea como JSON |
| `INSTRUMENT_NOT_OPERABLE` | 400 | El instrumento es `MONEDA` (ej. ARS) |
| `USER_NOT_FOUND` | 404 | `userId` inexistente |
| `ORDER_NOT_FOUND` | 404 | `orderId` inexistente (DELETE) |
| `INSTRUMENT_NOT_FOUND` | 404 | `instrumentId`/`ticker` inexistente en POST /orders |
| `NOT_FOUND` | 404 | Ruta o método inexistente |
| `IDEMPOTENCY_CONFLICT` | 409 | Misma `Idempotency-Key` con payload distinto |
| `PAYLOAD_TOO_LARGE` | 413 | Body por encima del límite de 100 KB |
| `ORDER_NOT_CANCELLABLE` | 422 | Cancelar una orden que no está `NEW` |
| `INTERNAL_ERROR` | 500 | Error inesperado: mensaje genérico, sin stack |

> Los 11 códigos son `API_ERROR_CODES` en [`src/contracts/errors.ts`](src/contracts/errors.ts). El 500 responde `Error interno del servidor.` y el detalle (stack en una línea) queda en stderr.

**Formato del dinero y las cantidades** (spec aprobada, D3):

| Dato | Entra | Sale |
| --- | --- | --- |
| Dinero (`price`, `amountArs`, `filledPrice`, `cash`, `reservedCash`, `totalAccountValue`, `marketValue`, `previousClose`) | **string decimal estricto**: hasta 22 dígitos enteros y 2 decimales, punto decimal; sin exponente, separadores, `+`, espacios ni ceros iniciales (salvo el `0` propio). Un JSON `number` ⇒ 400: el parser ya pudo perder cifras. | **string con exactamente 2 decimales**, sin notación científica ni `-0.00`; `null` donde significa ausencia. |
| `size` (trading) | `number` entero, 1..2147483647 (cota INT4 por orden, sin cambios) | `number` entero, o `null` según el caso vigente |
| `size` (transferencias) | — (el monto viaja en `amountArs` string) | **string monetario** de pesos con 2 decimales (ej. `"123.45"`) |
| `quantity` (portfolio) | — | **string entero canónico**, con signo para la negativa heredada |
| Porcentajes (`totalReturnPct`, `dailyVariationPct`) | — | `number` (sin cambios) |

El máximo por fila es `9999999999999999999999.99` (NUMERIC(24,2)); los agregados de dinero (`cash`, `totalAccountValue`) pueden superarlo por suma y siguen exactos. `quantity` no entra en esa frase: no es dinero sino un entero de tenencia (`bigint` en el dominio, string entero en la respuesta), sin máximo monetario que necesite superar.

### 1. Portfolio — `GET /api/users/:userId/portfolio`

**Response 200** (base recién migrada y seedeada, user 1):

```json
{
  "cash": "627500.00",
  "reservedCash": "125500.00",
  "totalAccountValue": "889756.00",
  "positions": [
    { "ticker": "BMA",  "name": "Banco Macro S.A.",   "quantity": "-10", "marketValue": "-15028.00",  "priceAvailable": true, "totalReturnPct": -2.42 },
    { "ticker": "PAMP", "name": "Pampa Holding S.A.", "quantity": "40",  "marketValue": "37034.00",   "priceAvailable": true, "totalReturnPct": -0.45 },
    { "ticker": "METR", "name": "MetroGAS S.A.",      "quantity": "500", "marketValue": "114750.00", "priceAvailable": true, "totalReturnPct": -8.2 }
  ]
}
```

| Campo | Significado |
| ----- | ----------- |
| `cash` | Disponible para operar = `cashSettled − cashReserved` |
| `reservedCash` | Reservado por órdenes `NEW` BUY (`limit × size`) |
| `totalAccountValue` | `cash + reservedCash + Σ marketValue` de las posiciones **con** precio |
| `positions[]` | `{ticker, name, quantity, marketValue, priceAvailable, totalReturnPct}` — `quantity` string entero, `marketValue` string monetario |

`cash` = disponible, no el settled: 753000.00 − 125500.00 = 627500.00. `totalAccountValue` = 627500.00 + 125500.00 + 37034.00 + 114750.00 − 15028.00 = **889756.00** (la negativa BMA resta). Los valores del seed no cambian: cambia su **forma JSON** (string con 2 decimales).

**Abrir o cancelar una orden no mueve el total**, sólo lo reparte: tras comprar 1 PAMP a mercado el `cash` baja a `"626574.15"` y la posición sube a `"41"` acciones (`marketValue` `"37959.85"`), con el total todavía en `"889756.00"`; al cancelar la orden 5 el `reservedCash` baja de `"125500.00"` a `"90000.00"` y el `cash` sube los mismos 35500, otra vez con el total en `"889756.00"`.

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
    "price": "229.50",
    "previousClose": "232.00",
    "dailyVariationPct": -1.08
  }
]
```

`price` = `close` de la última fila de `marketdata` por `date` (string monetario con 2 decimales; `dailyVariationPct` sigue siendo `number`); sin marketdata (ej. `PGR`, `IRCP`) → `price`/`previousClose`/`dailyVariationPct` en `null`.

Errores: `400 VALIDATION_ERROR` — `query` vacía o ausente (`?query=` → 400), `limit` fuera de 1..100.

### 3. Enviar orden — `POST /api/users/:userId/orders`

**Request** (body JSON):

| Campo | Regla |
| ----- | ----- |
| `instrumentId` \| `ticker` | exactamente **uno** de los dos |
| `size` \| `amountArs` | exactamente **uno**: acciones enteras 1..2147483647 (`size`, `number` — sin cambios), o monto en ARS > 0 como **string decimal estricto** (`amountArs`) del que se deriva `size = floor(amountArs / precio)` |
| `side` | `BUY` \| `SELL` |
| `type` | `MARKET` \| `LIMIT` |
| `price` | **string monetario** > 0, **obligatorio si `LIMIT`** · **en `MARKET` se omite o va `null`** (un precio ⇒ 400: se ejecuta al precio de referencia) |
| `timeInForce` | opcional: `GTC` (default) \| `IOC` \| `FOK` |

El dinero **nunca viaja como JSON `number`**: `"price": "900.00"`, `"amountArs": "1000.00"`. Gramática de entrada: hasta 22 dígitos enteros y 2 decimales, punto decimal; sin exponente, separadores, `+`, espacios ni ceros iniciales (salvo el `0` propio). `"123.0"` y `"123.00"` son el mismo monto.

**Header opcional:** `Idempotency-Key` (string de 1–64; ausente ⇒ sin idempotencia, inválido ⇒ 400).

**Response 201** — `OrderResponse`, **siempre que la orden se persistió** (`FILLED`, `NEW`, `REJECTED` o `CANCELLED`):

```bash
curl -X POST http://localhost:3000/api/users/1/orders \
  -H 'Content-Type: application/json' \
  -d '{"ticker":"PAMP","side":"BUY","type":"MARKET","size":1}'
```

```json
{
  "id": 12,
  "instrumentId": 47,
  "side": "BUY",
  "type": "MARKET",
  "timeInForce": "GTC",
  "status": "FILLED",
  "size": 1,
  "price": null,
  "filledPrice": "925.85",
  "filledAt": "2026-11-04T09:54:58",
  "datetime": "2026-11-04T09:54:58",
  "reason": null
}
```

| Campo | Significado |
| ----- | ----------- |
| `price` | **límite enviado** (`LIMIT`), string monetario; `null` en `MARKET` |
| `filledPrice` | **precio de ejecución** si `FILLED`, string monetario; `null` si no ejecutó |
| `reason` | `INSUFFICIENT_FUNDS` · `INSUFFICIENT_POSITION` · `ZERO_SIZE` · `NO_PRICE` · `NO_IMMEDIATE_MATCH`; `null` en `NEW`/`FILLED` y en la respuesta de un DELETE |
| `datetime`/`filledAt` | ISO 8601 **sin offset** (timestamp sin zona, hora local del mercado) |

**`size` de la respuesta, discriminado por side:** en `BUY`/`SELL` es `number` entero (o `null`); en transferencias `CASH_IN`/`CASH_OUT` es **string monetario** de pesos con 2 decimales — un cash histórico del seed de `size 123` se representa como `"123.00"`, sin cambiar el valor persistido.

Comportamiento por tipo (precios de referencia del seed: PAMP 925.85, METR 229.50, BMA 1502.80 — última `marketdata` por `date`):

- `MARKET` → `FILLED` al precio de referencia en la misma transacción.
- `LIMIT GTC` → queda `NEW` (reserva `limit × size` de cash en BUY; `size` acciones en SELL), o `REJECTED` si no alcanza el cash/tenencia.
- `LIMIT IOC/FOK` → una evaluación contra la referencia: cruza → `FILLED` **con mejora** (BUY a `min(límite, ref)`; SELL a `max`); no cruza → `CANCELLED` con `reason NO_IMMEDIATE_MATCH` (201).

Errores: `400 VALIDATION_ERROR` (XORs, `LIMIT` sin `price`, `MARKET` con `price`, dinero como `number` o fuera de la gramática monetaria, `size` fuera de 1..2147483647, `size` derivado de `amountArs` fuera de rango — 400 **sin ninguna escritura**, header inválido) · `400 INSTRUMENT_NOT_OPERABLE` (MONEDA) · `404 USER_NOT_FOUND` · `404 INSTRUMENT_NOT_FOUND` · `409 IDEMPOTENCY_CONFLICT`. El rechazo del negocio **se persiste** (`201 REJECTED` con `reason`), no es error HTTP: fondos/tenencia insuficientes, `ZERO_SIZE`, `NO_PRICE`.

**Idempotencia** (ejemplos verificados, user 2 del seed):

```bash
# 1º envío con key → crea la orden (acá REJECTED por fondos: user 2 no tiene cash)
curl -X POST http://localhost:3000/api/users/2/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-key-1' \
  -d '{"ticker":"PAMP","side":"BUY","type":"LIMIT","size":1,"price":"100.00"}'
→ 201 {"id":13,...,"status":"REJECTED","reason":"INSUFFICIENT_FUNDS"}

# Misma key + MISMO payload → la orden ORIGINAL (201, id 13, sin nuevo evento)
→ 201 {"id":13,...,"reason":null}     # reason null en el replay: la razón vive en order_events

# Misma key + OTRO payload → 409
curl -X POST http://localhost:3000/api/users/2/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-key-1' \
  -d '{"ticker":"PAMP","side":"BUY","type":"LIMIT","size":2,"price":"100.00"}'
→ 409 {"error":{"code":"IDEMPOTENCY_CONFLICT","message":"Idempotency-Key ya usada con otro payload (orden existente 13)."}}
```

> El replay y el 409 intentan el `INSERT ... ON CONFLICT DO NOTHING` y consumen dos valores de la secuencia: por eso la transferencia siguiente del ejemplo es `id` 16 y no 14.

### 4. Cancelar orden — `DELETE /api/orders/:orderId`

Sólo órdenes `NEW`. **Response 200** con la `OrderResponse` cancelada (201 es para creaciones; el status de cancelación no estaba fijado y se resolvió 200):

```bash
curl -X DELETE http://localhost:3000/api/orders/5   # orden NEW del seed (LOMA BUY LIMIT 50 @ 710)
→ 200 {"id":5,"instrumentId":45,"side":"BUY","type":"LIMIT","timeInForce":"GTC",
       "status":"CANCELLED","size":50,"price":"710.00","filledPrice":null,"filledAt":null,
       "datetime":"2023-07-12T12:14:20","reason":null}
```

Al cancelar una `NEW` **se libera su reserva** (visible en `reservedCash` del portfolio: 125500 → 90000 al cancelar la orden 5). Errores: `400 VALIDATION_ERROR` (orderId no entero > 0) · `404 ORDER_NOT_FOUND` · `422 ORDER_NOT_CANCELLABLE` (ej. `DELETE /api/orders/6`, la orden `REJECTED` del seed).

### 5. Transferencias — `POST /api/users/:userId/transfers`

**Request:** `{"amountArs": "<monto en ARS > 0 como string decimal estricto>", "side": "CASH_IN" | "CASH_OUT"}` · header `Idempotency-Key` opcional. Un JSON `number` ⇒ 400.

Transferencia = **orden** del instrumento MONEDA del cash (ticker `ARS`, id 66) con `price = 1.00` (string `"1.00"` en la respuesta). Con la spec aprobada (D4) la transferencia mueve el **monto exacto con centavos, sin floor**: `CASH_IN` acredita exactamente `amountArs` → `FILLED` inmediata; `CASH_OUT` compara **ese monto exacto** contra el disponible leído dentro de la transacción (`settled − reservas`) → `REJECTED INSUFFICIENT_FUNDS` persistida (201) si no alcanza. Una transferencia de `0.01` es válida: **ya no** existe el `ZERO_SIZE` de cash (ese rechazo queda para el sizing de acciones y los históricos).

En la respuesta, `size` es **string monetario** de pesos con 2 decimales (el monto movido o pedido):

```bash
curl -X POST http://localhost:3000/api/users/2/transfers \
  -H 'Content-Type: application/json' -d '{"amountArs":"123.45","side":"CASH_IN"}'
→ 201 {"id":16,"instrumentId":66,"side":"CASH_IN","type":"MARKET","timeInForce":"GTC",
       "status":"FILLED","size":"123.45","price":"1.00","filledPrice":"1.00",...,"reason":null}

curl -X POST http://localhost:3000/api/users/2/transfers \
  -H 'Content-Type: application/json' -d '{"amountArs":"0.01","side":"CASH_IN"}'
→ 201 {"id":17,...,"status":"FILLED","size":"0.01","price":"1.00","filledPrice":"1.00",...,"reason":null}

curl -X POST http://localhost:3000/api/users/2/transfers \
  -H 'Content-Type: application/json' -d '{"amountArs":"1000000.00","side":"CASH_OUT"}'
→ 201 {"id":18,...,"status":"REJECTED","size":"1000000.00",...,"reason":"INSUFFICIENT_FUNDS"}
```

Errores: `400 VALIDATION_ERROR` (monto ≤ 0, número JSON, fuera de la gramática monetaria, side inválido) · `404 USER_NOT_FOUND` · `409 IDEMPOTENCY_CONFLICT`.

**Idempotencia de cash histórico** (spec §5, política conservadora): una key cash histórica pedida por `123.45` pero persistida como 123 pesos **sigue moviendo `"123.00"`** — no se reacredita el residuo de `0.45`. El retry compara el monto original documentado en `metadata.amountArs` del evento de origen: mismo pedido original → la fila original (201, sin evento nuevo); monto distinto → **409**; si la evidencia del evento no alcanza para establecer el pedido exacto → **409** (no se adivina ni se vuelven a mover fondos).

## Supuestos y decisiones

Decisiones de diseño con su porqué. La lista inmutable de decisiones del build vive en `DECISIONS.md`; acá se explica cada una y se agregan las decisiones de integración (22–27).

### Precios y ejecución

1. **Precio de referencia = última fila de `marketdata` por `date`** (no `datetime`). Es la semántica de "último precio" del dataset (velas diarias): por `datetime` empataría fechas por la hora. Sin precio: `marketValue: null`, `priceAvailable: false`, la posición no suma al total, y las órdenes que lo necesitan se rechazan con `NO_PRICE` — nunca se inventa un precio (`PGR`/`IRCP` del seed no tienen marketdata).
2. **`MARKET` se ejecuta al precio de referencia y queda `FILLED` en la misma transacción.** No hay motor de matching (el challenge dice que no hace falta simular el mercado); el `close` de la última vela es el "mercado".
3. **`LIMIT GTC` siempre queda `NEW` al enviarse** (nunca se llena en el envío). Un `GTC` es una orden *resting*: se graba con su límite y **reserva** los recursos (cash en BUY, acciones en SELL) para que el usuario no pueda comprometerlos dos veces.
4. **`LIMIT IOC/FOK` se evalúan una única vez contra el precio de referencia.** Cruza → `FILLED` **con mejora**: BUY paga `min(límite, ref)` (nunca más caro que su límite), SELL cobra `max(límite, ref)`. No cruza → `CANCELLED` con razón `NO_IMMEDIATE_MATCH`, persistida (201). **Sin fills parciales**: `IOC/FOK` son todo-o-nada en esta implementación.
5. **`matchRestingOrders(refPrice, orders)` es una función pura, testeada, sin disparador automático.** Existe y está testeada como punto de enchufe para la evolución (matching de las `NEW` contra nuevos precios), pero ningún código la llama en el flujo de producción: el alcance quedó cerrado sin matching continuo. Ver [Evolución propuesta](#evolución-propuesta).

### Cash, reservas y posiciones

6. **No hay tabla de cash ni de posiciones: se derivan de `orders`.** Cash = Σ movimientos `FILLED` (`CASH_IN`/`SELL` suman `size × price`; `CASH_OUT`/`BUY` restan). Derivar de la única fuente de verdad evita saldos desincronizados entre una tabla y las órdenes.
7. **Reservas derivadas de las órdenes `NEW`, sin tabla.** BUY `NEW` reserva `limit × size` de cash; SELL `NEW` reserva `size` acciones. **`cash disponible = cashSettled − cashReserved`** (el portfolio reporta `cash` disponible y `reservedCash` por separado). **`totalAccountValue = cash disponible + cashReserved + Σ marketValue`** de las posiciones con precio: abrir o cancelar una orden no lo mueve, sólo mueve plata entre disponible, reservado y posición. **`CASH_OUT` valida contra el disponible**, no contra el settled: las `NEW` son compromisos reales de plata ya prometida.
8. **BUY valida fondos contra el cash disponible; SELL contra las acciones vendibles** (posición `FILLED` del instrumento − acciones reservadas por `NEW` del mismo instrumento). Es la misma lectura que el punto anterior aplicada a ambos lados: dos submits que juntos exceden el cash dejan una `FILLED` y una `REJECTED` (testeado).
9. **P&L no realizado sobre costo promedio ponderado; las ventas no tocan el promedio.** El costo de la posición es el de las compras que la forman; vender cambia la cantidad, no el costo unitario de lo que queda. **Posición con cantidad 0 no se lista** (dejar de existir no es tenerla en 0). **Posición negativa heredada del seed (BMA −10) se lista tal cual** — ver [Posición negativa del seed](#posición-negativa-del-seed-bma--10).
10. **`amountArs` de trading: `size = floor(amount / precio)`; `size 0` → `REJECTED ZERO_SIZE`.** El challenge pide "la cantidad de acciones máximas que puede enviar, sin fracciones": el `floor` garantiza que nunca se compromete más que el monto (el residuo queda como cash). Con `LIMIT` el precio de sizing es el **límite** (el peor precio aceptable para un BUY: nunca se compromete más que el monto a ese precio); con `MARKET`, la referencia. El floor **sólo aplica al trading**: con la spec aprobada, las transferencias de cash mueven el monto exacto con centavos (ver 29) — la rama cash no pasa por el sizing de acciones. Si el `size` derivado supera 2147483647, la orden se rechaza con 400 **antes** de convertir a `number` y sin ninguna escritura (ni una `REJECTED`).
11. **El dinero nunca es float y nunca se degrada a `number`.** Interno: `Decimal` construido con un **constructor financiero aislado** (clone de decimal.js, precisión 64, `ROUND_HALF_UP`), alimentado **sólo por strings**; las cantidades agregadas viven en `bigint`. Entrada HTTP: **string decimal estricto** (hasta 22 enteros + 2 decimales); un JSON `number` se rechaza con 400 — el parser JSON ya pudo perder cifras y la aplicación no puede recuperarlas. Salida: **string con exactamente 2 decimales** (cuantizado en `Decimal` antes de serializar), sin notación científica ni `-0.00`; porcentajes conservan su `number`. En DB, precios y montos: `NUMERIC(24,2)` (D1/D2). El float no puede representar `0.1` y el `number` de JS pierde exactitud por arriba de 2^53: ninguna plata cruza por `number`.
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

### Decisiones de integración

22. **DELETE exitoso → `200`** (no 201): el 201 quedó reservado para creación; la cancelación devuelve la orden `CANCELLED` con 200.
23. **Evento `CANCELLED` por usuario con `reason: null` y metadata `{origin: "USER"}`**: las razones del contrato son de rechazo/no-cruce, no de una cancelación pedida; el origen viaja en metadata.
24. **El instrumento del cash se resuelve por ticker `"ARS"`** (vía port), no por id hardcodeado: el id 66 es un dato del seed, el ticker es el identificador estable.
25. **`size` en una transferencia `REJECTED` = el monto pedido** (no 0): el `floor` no interviene (price 1.00) y la orden se rechaza por fondos — registrar `size 0` escondería qué se pidió. *(Histórico: describía el contrato con pesos enteros; con la spec aprobada el monto es exacto con centavos y el `ZERO_SIZE` de cash desaparece para transferencias nuevas — ver 29. La regla del monto pedido en la respuesta sigue vigente, ahora como string monetario.)*
26. **El replay idempotente devuelve `reason: null`**: la respuesta re-envía la fila original; la razón de su rechazo ya vive en `order_events` (verificado en vivo arriba).
27. **`INSTRUMENT_NOT_FOUND` → 404** (no fijado por `DECISIONS.md`; la spec sugería 400): "no existe el recurso apuntado" es semántica de 404, igual que el usuario.

### Grandes montos (spec aprobada — Rev. 2)

28. **Cambio incompatible de representación (D3):** dinero de entrada y salida como strings decimales, `quantity` agregada como string entero con signo, `size` de trading sigue `number` entero y el `size` de transferencias pasa a string monetario. No hay endpoint paralelo ni `number`/`string` según el tamaño: un solo formato. La fuente normativa es la spec firmada; `DECISIONS.md` registra la decisión.
29. **Transferencias exactas (D4):** el cash nuevo mueve el monto pedido con centavos, sin floor; `0.01` es válida. `CASH_OUT` valida el monto **exacto** contra el disponible dentro de la transacción. Para keys idempotentes cash históricas rige la política conservadora de la spec §5 (replay del monto original documentado, 409 ante montos distintos o evidencia insuficiente): el dinero ya movido no se reescribe ni se "regalan" los centavos históricos descartados.
30. **Unidades separadas aunque compartan columna (D2):** `orders.size` pasa a `NUMERIC(24,2)` pero BUY/SELL siguen siendo **acciones enteras** (acotadas a INT4 por orden) y CASH_IN/CASH_OUT **pesos con centavos**; el dominio los separa en tipos discriminados. La deuda del campo físico de doble propósito se mantiene visible, no se oculta.
31. **Migración coordinada (D5):** la nueva migración versionada (create-only, con CHECKs financieros acotados como única excepción autorizada a "no editar migraciones") se aplica con pausa de escrituras y reemplazo de todas las instancias viejas antes de habilitar cash fraccional/grande. No se promete despliegue rolling ni downtime cero. Procedimiento: [Migración coordinada](#migración-coordinada-de-grandes-montos).

## Posición negativa del seed (BMA −10)

El dataset trae una **inconsistencia documentada, no corregida**: el usuario 1 vendió 30 BMA (orden 11, `FILLED`) con sólo 20 compradas `FILLED` (orden 9); la compra de 60 (orden 7) quedó en `NEW`. La posición resultante es **−10**.

- La API **la lista tal cual** (`quantity: -10`, `marketValue: -15028`) y **resta** del `totalAccountValue`. Corregirla en la lectura sería falsificar el dataset.
- La validación de venta (`SELL` contra posición `FILLED` − reservadas) **la habría rechazado** de entrar hoy: con la posición en −10 y 60 acciones reservadas, cualquier `SELL` de BMA sale `REJECTED INSUFFICIENT_POSITION`. El seed no es oráculo de negocio, es un dataset de ejemplo (más inconsistencias en [docs/database.md](docs/database.md)).

## Límites conocidos

- **Replays cash históricos:** un `CASH_IN` histórico pedido por `123.45` pero persistido como 123 pesos sigue representando `123.00` — el residuo descartado **no** se reacredita ni se debita al recalcular (decisión 29). Las transferencias **nuevas** ya mueven el monto exacto con centavos.
- **Fills parciales no modelados:** una `IOC` que cruza se llena completa o se cancela (todo-o-nada), sin ejecución parcial del tamaño.
- **Matching sin disparador:** `matchRestingOrders` existe (función pura testeada) pero **nada la llama en producción** — las `NEW` no se llenan cuando cambia el precio de referencia. Punto de enchufe documentado.
- **Sin autenticación:** `userId` viene del path y se confía (el challenge lo explicita). Cualquier `userId` del seed opera su cuenta.
- **`make db-load` / `make db-reset` cargan el snapshot legacy** (sin `"timeInForce"`/`filledPrice`/`filledAt`/`idempotencyKey` ni `order_events`) y por eso **exigen `LEGACY=1`**: sin esa variable abortan sin tocar la base. El flujo vigente es `npx prisma migrate deploy` + `db/seed.sql` (como en el quickstart); los targets quedan para recargar el dataset original de referencia.
- **Docker sin verificar:** la secuencia del quickstart se corrió contra un PostgreSQL 18 local, no contra el contenedor de `docker-compose.yml` (Postgres 16). Es la vía estándar del repo, pero no se ejecutó en esta entrega.

## Migración coordinada de grandes montos

La ampliación a `NUMERIC(24,2)` es un cambio de esquema **y de contrato** a la vez; se despliega como una ventana coordinada, no como un deploy más. La migración es **versionada** (`prisma/migrations/**`, nueva, create-only) y se aplica recién en la ventana descrita abajo; el estado de su aplicación lo registra `PROGRESS.md`.

1. **Pausa de escrituras.** Se detiene la ingesta de órdenes/transferencias y se reemplazan **todas** las instancias del cliente viejo antes de habilitar cash fraccional/grande: el cliente anterior espera `size` entero y no es compatible con el nuevo tipo. No hay convivencia rolling; no se promete downtime cero — la ventana se mide y se anuncia.
2. **Backup y plan de restauración**, probados en el ensayo antes de fijar la ventana. Sin backup verificado no se arranca.
3. **Preflight de sólo lectura** sobre una copia o DB de test aislada: inventariar `size`/precios nulos, ceros, negativos, cash con precio distinto de 1.00 y keys cash sin evidencia del monto original (metadata del evento). Registrar conteos y valores de control; jamás credenciales ni datos personales en el informe. Ante inconsistencias se detiene y se pide una decisión — no se normaliza por defecto.
4. **Ensayo en DB de test:** aplicar la migración versionada y cargar `db/seed.sql` **sin editarlo**; verificar conservación exacta de valores, IDs, claves y eventos (mismo cash/posiciones/patrimonio por valor, aunque cambie la forma JSON).
5. **Aplicar la migración** en la ventana acordada y habilitar escrituras con los clientes ya actualizados al contrato string (misma ventana de coordinación).
6. **Rollback:** antes de aceptar datos nuevos, restaurar el estado ensayado. **Después** de almacenar fracciones o importes fuera del rango anterior **no existe downgrade por cast/truncado**: requiere restauración/reconciliación aprobada, con costo e indisponibilidad explícitos.

Límite honesto: `NUMERIC(24,2)` puede redondear una escritura SQL externa con más de 2 decimales **antes** de que un `CHECK` la evalúe; los CHECKs garantizan el valor almacenado, no la precisión original de escrituras que no pasan por la API. La gramática Zod del borde rechaza esa entrada antes de persistir.

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

Configurá una base exclusiva de pruebas en `.env.test` (copiá `.env.test.example` y completá `TEST_DATABASE_URL`). No uses la URL configurada para la app: el reset elimina y recrea las bases de test.

```bash
npm run test:db:reset   # requiere PostgreSQL de test y permiso para crear/eliminar bases
npm test
```

- **Unit** (`tests/unit/**`): funciones puras (derivación de cash/posiciones/reservas, `evaluateCross`, `matchRestingOrders`, sizing), casos de uso con fakes, contratos Zod, borde HTTP y contrato de errores.
- **Integration** (`tests/integration/infra`): repos Prisma contra la base indicada por `TEST_DATABASE_URL`.
- **Functional** (`tests/functional/**`): los 5 endpoints vía supertest; cada suite deriva y resetea su propia base desde `TEST_DATABASE_URL` antes de correr.
- `npm run typecheck` (`tsc --noEmit`, nodenext) y `npm run lint` (eslint 9 flat config) completan el chequeo.

## Estructura del proyecto

```
src/
  contracts/     # shapes de request/response + enums + dinero (Zod) — única fuente de los payloads
  domain/        # funciones puras: portfolio (cash/posiciones/reservas), sizing, matching
  domain/ports/  # interfaces de los repos (DI: nunca concreciones)
  infra/prisma/  # repos Prisma (mappers fila ↔ record) + tx con pg_advisory_xact_lock
  application/   # casos de uso: orders (submit/decide/persist), cancel, transfers, portfolio
  http/          # routers por slice + shared/edge.ts (borde Zod) + error-handler.ts + server.ts
  lib/           # cliente Prisma singleton
  index.ts       # entry: carga .env y levanta el servidor
prisma/          # schema.prisma (fuente única de índices) + migrations/
db/              # snapshot legacy (schema.sql), seed.sql (datos del challenge), queries/, indexes.sql
collection/      # ejemplos REST Client (.http)
tests/           # unit / integration / functional (auto-reset por suite)
docs/            # database.md (esquema legacy vs migrado, semántica de orders)
```

## Autor

David — [@Cofiagus](https://github.com/Cofiagus)
