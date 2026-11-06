# Decisiones de arquitectura (ADR)

Lista normativa de las decisiones del build. Cada una tiene **Contexto** (la restricción que obligó a
decidir), **Decisión** (la regla vigente, verificable en el código) y **Consecuencias** (qué habilita,
qué cuesta y qué queda fuera de alcance). El [README](README.md) resume estas reglas para quien recién
llega; acá está el porqué. Un cambio de decisión se registra en este archivo, no en un commit suelto.

| # | Decisión | Ámbito |
| - | -------- | ------ |
| D1 | Dinero y cantidades como strings decimales exactos | contrato HTTP + persistencia |
| D2 | Cash, reservas y posiciones derivadas de `orders` | dominio + esquema |
| D3 | Ejecución de órdenes contra un precio de referencia estático | órdenes + precios |
| D4 | Transferencias de cash como órdenes del instrumento `ARS` | transferencias |
| D5 | Idempotencia por header y lock por usuario | escrituras |
| D6 | Contrato HTTP: rutas, status y errores | borde HTTP |

## D1 — Dinero y cantidades como strings decimales exactos

**Contexto.** El challenge pide montos con centavos y el build debía soportar importes grandes. Un
`number` de JavaScript pierde exactitud por encima de 2^53 y el parser JSON ya redondea antes de que
la aplicación vea el dato: recuperarlo después es imposible. Un `float` no representa `0.1`. Además,
`orders.size` tiene doble uso (acciones de trading y pesos de transferencias), y un solo formato por
tipo de dato evita que el cliente tenga que adivinar.

**Decisión.**

- Interno: constructor `Decimal` financiero aislado (clone de decimal.js, precisión 64,
  `ROUND_HALF_UP`) alimentado **sólo por strings**; las cantidades agregadas viven en `bigint`.
- Entrada monetaria: **string decimal estricto** — hasta 22 dígitos enteros y 2 decimales, punto
  decimal; sin exponente, separadores, `+`, espacios ni ceros iniciales (salvo el `0` propio). Un JSON
  `number` ⇒ 400.
- Salida monetaria: **string con exactamente 2 decimales**, cuantizado en `Decimal` antes de
  serializar, sin notación científica ni `-0.00`; `null` donde significa ausencia. Los porcentajes
  (`totalReturnPct`, `dailyVariationPct`) siguen siendo `number`.
- Persistencia: `NUMERIC(24,2)` para precios y montos (`orders.size`, `orders.price`,
  `orders.filledPrice`, columnas de `marketdata`); máximo por fila `9999999999999999999999.99`.
  Los agregados (`cash`, `totalAccountValue`) pueden superarlo por suma y siguen exactos.
- Unidades separadas aunque compartan columna: acciones por orden acotadas a INT4 (`size` de trading
  entra y sale como `number` entero), `quantity` del portfolio como string entero con signo, y `size`
  de una transferencia como string monetario.

**Consecuencias.**

- El cambio de `number` a string es **incompatible** con el contrato anterior: se despliega en una
  ventana coordinada, sin convivencia rolling ni promesa de downtime cero.
- No hay endpoint paralelo ni formato según el tamaño: un solo formato para todo cliente nuevo.
- `NUMERIC(24,2)` puede redondear una escritura SQL externa con más de 2 decimales antes de que un
  `CHECK` la evalúe; los CHECKs garantizan el valor almacenado, no la precisión de escrituras que no
  pasan por la API. El borde Zod rechaza esa entrada antes de persistir.

## D2 — Cash, reservas y posiciones derivadas de `orders`

**Contexto.** El dataset sólo trae `users`, `instruments`, `orders`, `order_events` y `marketdata`.
Una tabla de saldos o de posiciones duplicaría el estado y podría desincronizarse de las órdenes, el
único registro de lo que realmente pasó.

**Decisión.**

- No hay tabla de cash ni de posiciones: se **derivan** de `orders`.
- `cashSettled` = suma de movimientos `FILLED` (`CASH_IN`/`SELL` suman `size × price`;
  `CASH_OUT`/`BUY` restan).
- Reservas derivadas de las órdenes `NEW`: BUY reserva `limit × size` de cash; SELL reserva `size`
  acciones. **`cash` del portfolio = `cashSettled − cashReserved`** (disponible), y `reservedCash`
  se reporta aparte para que la resta sea auditable.
- **`totalAccountValue = cashSettled + Σ marketValue`** de las posiciones con precio. Como
  `cashSettled` ya incluye disponible **y** reservado, equivale a `cash + reservedCash + Σ
  marketValue`: abrir o cancelar una orden no mueve el total, sólo reparte plata entre disponible,
  reservado y posición.
- BUY valida fondos contra el cash disponible; SELL contra las acciones vendibles (posición `FILLED`
  del instrumento − reservadas por `NEW` del mismo instrumento); `CASH_OUT` contra el disponible.
- `amountArs` de trading deriva `size = floor(amount / precio)` (con `LIMIT` el precio de sizing es
  el límite; con `MARKET`, la referencia). `size` 0 ⇒ orden `REJECTED` con `ZERO_SIZE`; un `size`
  derivado por encima de INT4 ⇒ 400 **antes** de convertir a `number` y sin ninguna escritura.
- P&L no realizado sobre costo promedio ponderado: vender cambia la cantidad, no el costo unitario
  de lo que queda. El retorno usa denominador `|costo|`. Posición con cantidad 0 no se lista; la
  posición negativa heredada del seed (BMA −10) se lista tal cual y resta del total.
- Índices con una sola fuente, `prisma/schema.prisma`: `(status, instrumentId)`, `(userId, status)`,
  `marketdata(instrumentId, date DESC)`, `UNIQUE(userId, idempotencyKey)` y `order_events(orderId)`.

**Consecuencias.**

- Todo saldo es explicable por la lista de órdenes y sus eventos; no existe un estado que se pueda
  "corregir por fuera" de las órdenes.
- Las lecturas recalculan agregados en vez de leer un saldo materializado: costo en CPU a cambio de
  una única fuente de verdad.
- El dataset no se corrige: la posición negativa del seed se muestra como está. La validación de
  venta **la habría rechazado** de entrar hoy (`REJECTED INSUFFICIENT_POSITION`), porque el seed es
  un dataset de ejemplo y no un oráculo de negocio.
- `db/schema.sql` es un snapshot legacy generado y desactualizado: el DDL real son las migraciones de
  Prisma y la fuente de índices es `prisma/schema.prisma`.

## D3 — Ejecución de órdenes contra un precio de referencia estático

**Contexto.** El dataset son velas diarias (`marketdata`); el challenge dice que no hace falta
simular un mercado continuo. El build necesitaba una semántica de "último precio" defendible y un
lugar único donde resolverla, sin inventar cotizaciones cuando falta el dato. La búsqueda de
instrumentos es la única reapertura autorizada de Yahoo Finance.

**Decisión.**

- Precio de referencia = **última fila de `marketdata` por `date`** (no por `datetime`: empataría
  fechas por la hora), para portfolio y órdenes. Sin precio: `marketValue: null`,
  `priceAvailable: false`, la posición no suma al total y las órdenes que lo necesitan se rechazan
  con `NO_PRICE`. Nunca se inventa un precio.
- `MARKET` se ejecuta al precio de referencia y queda `FILLED` en la misma transacción; no hay motor
  de matching.
- `LIMIT GTC` siempre queda `NEW` al enviarse (una orden *resting*), reservando cash en BUY y acciones
  en SELL para que el usuario no comprometa dos veces los mismos recursos.
- `LIMIT IOC`/`FOK` se evalúan **una sola vez** contra la referencia: si cruza ⇒ `FILLED` **con
  mejora** (BUY paga `min(límite, ref)`, SELL cobra `max(límite, ref)`); si no cruza ⇒ `CANCELLED`
  con razón `NO_IMMEDIATE_MATCH`, persistida con 201. Sin fills parciales: todo-o-nada.
- `matchRestingOrders(refPrice, orders)` es una función pura, testeada y **sin disparador**: ningún
  flujo de producción la llama. Queda como punto de enchufe documentado.
- `timeInForce` es `NOT NULL DEFAULT 'GTC'` en la base y se ignora en `MARKET`.
- `orders.price` = límite enviado; `orders.filledPrice` = precio de ejecución. El mapper de lectura
  usa `filledPrice ?? price` para las filas legacy del seed, cuyo `price` ya trae la ejecución.
- La búsqueda (`GET /instruments`) es la excepción: consume **cotizaciones actuales de Yahoo** por el
  port `InstrumentQuoteSource`, con símbolo directo `ticker + ".BA"`. `price` = último precio de
  sesión disponible, `previousClose` = cierre de la sesión anterior, `dailyVariationPct` =
  `(price − previousClose) / previousClose × 100`. Un instrumento sin cotización válida se omite y
  el cupo se completa con los siguientes candidatos; el proveedor caído responde 503
  `MARKET_DATA_SERVICE_UNAVAILABLE`, nunca un array vacío que disimule la falla.

**Consecuencias.**

- Las `NEW` no se llenan cuando cambia el precio: el matching continuo, el job que lo dispara y las
  `DAY`/`EXPIRED` quedan fuera de alcance.
- `IOC`/`FOK` no ejecutan parcial: una orden que cruza se llena completa o se cancela.
- El portfolio y las órdenes no siguen al mercado real: usan el dataset estático (la última vela del
  seed). Yahoo está fuera de ingesta, matching y ejecución; sólo alimenta la búsqueda.
- `datetime` y `filledAt` se serializan ISO 8601 **sin offset** porque la columna es `timestamp` sin
  zona, en hora local del mercado; agregarle un offset sería mentir sobre el dato.

## D4 — Transferencias de cash como órdenes del instrumento `ARS`

**Contexto.** El cash no es una posición operable, pero tiene que entrar y salir de la cuenta. El
seed ya modela el efectivo como una orden del instrumento `MONEDA` `ARS` con `price = 1`, y la
proyección de cash sabe procesar cualquier orden `FILLED`. La spec de grandes montos (D4) exigió que
el monto se mueva exacto, con centavos.

**Decisión.**

- Una transferencia es una **orden** del instrumento MONEDA resuelto por ticker `"ARS"` (no por id
  hardcodeado: el id 66 es dato del seed, el ticker es el identificador estable), con `price = "1.00"`.
- `CASH_IN` acredita el `amountArs` exacto ⇒ `FILLED` inmediata. `CASH_OUT` compara **ese monto
  exacto** contra el disponible leído dentro de la transacción ⇒ `REJECTED INSUFFICIENT_FUNDS`
  persistida con 201 si no alcanza.
- `"0.01"` es válida: no hay floor ni `ZERO_SIZE` para cash (ese rechazo queda para el sizing de
  acciones y los históricos).
- En la respuesta, `size` es string monetario de 2 decimales con el monto movido o pedido; una
  transferencia `REJECTED` informa el monto pedido, no `0`.
- Keys idempotentes de cash histórico: se compara el monto original documentado en
  `metadata.amountArs` del evento de origen. Mismo pedido ⇒ la fila original; monto distinto o
  evidencia insuficiente ⇒ 409. El residuo descartado **no** se reacredita.

**Consecuencias.**

- Cash y trading comparten tabla y columna `size` pero no unidad: el dominio las separa en tipos
  discriminados (monto `Decimal` para cash, acciones enteras para trading).
- Un `CASH_IN` histórico pedido por `123.45` pero persistido como 123 pesos sigue representando
  `"123.00"`; es deuda documentada, no un bug a "arreglar" reescribiendo dinero ya movido.
- No hay endpoint ni tabla de saldo aparte: cualquier movimiento de cash es auditable como una orden
  con su evento.

## D5 — Idempotencia por header y lock por usuario

**Contexto.** Un retry de red no puede duplicar una orden ni inventar un resultado, y dos requests
concurrentes del mismo usuario no pueden pasar juntas una validación de fondos y sobregirar la
cuenta.

**Decisión.**

- Header opcional `Idempotency-Key` (1–64 caracteres) en `POST /orders` y `POST /transfers`, con
  `UNIQUE(userId, idempotencyKey)` en la tabla.
- El `INSERT` de la orden es la **primera escritura** de la transacción, con
  `ON CONFLICT DO NOTHING`; el payload se compara antes en el repositorio.
- Misma key + mismo payload ⇒ **201 con la orden original**, sin evento nuevo y con `reason: null`
  (la razón del rechazo vive en `order_events`). Misma key + payload distinto ⇒ **409**.
- Validación + inserción ocurren en **una transacción con lock por usuario**
  (`pg_advisory_xact_lock(userId)` dentro de `withUserTransaction`). El lock es por usuario, no
  global: usuarios distintos no se bloquean entre sí.

**Consecuencias.**

- Los submits, cancelaciones y transferencias de un mismo usuario se serializan; el segundo request
  ya ve el cash debitado por el primero.
- El replay y el 409 consumen valores de la secuencia: los huecos de `id` son esperados y no indican
  órdenes perdidas.
- Sin header no hay idempotencia: dos requests idénticos sin key crean dos órdenes.

## D6 — Contrato HTTP: rutas, status y errores

**Contexto.** Había que distinguir "el input está mal" de "la orden es válida pero el negocio la
rechaza", y dar un body de error uniforme que el cliente pueda consumir sin ramas por endpoint.
También había que decidir si `MONEDA` es operable y cómo se auditan las razones.

**Decisión.**

- Cinco rutas con convención REST de recursos: `GET /api/users/:userId/portfolio`,
  `GET /api/instruments?query=`, `POST /api/users/:userId/orders`, `DELETE /api/orders/:orderId`,
  `POST /api/users/:userId/transfers`.
- `201` **también** para `REJECTED`/`CANCELLED` persistidas: el endpoint recibió, evaluó y grabó la
  orden. Input inválido ⇒ `400` **sin crear nada** (ni orden ni evento); usuario o instrumento
  inexistente ⇒ `404`; cancelar una orden que no está `NEW` ⇒ `422`; DELETE exitoso ⇒ `200` (el 201
  queda reservado para creación).
- Body de error uniforme `{ "error": { "code", "message" } }`, con los códigos de `API_ERROR_CODES`
  en `src/contracts/errors.ts`. El 500 responde un mensaje genérico y deja el detalle en stderr.
- Las razones viven en `order_events` (auditoría append-only): `INSUFFICIENT_FUNDS`,
  `INSUFFICIENT_POSITION`, `ZERO_SIZE`, `NO_PRICE`, `NO_IMMEDIATE_MATCH`, con metadata del porqué. La
  cancelación pedida por el usuario graba `reason: null` y `{origin: "USER"}` en metadata.
- `MONEDA` no es operable: no se compra, no se vende, no aparece en búsqueda ni en
  `portfolio.positions`. Las transferencias son el único camino legítimo para mover cash.
- Precedencia de validación en `POST /orders` (el primer fallo gana): params → header → body (400) →
  usuario (404) → instrumento (404) → MONEDA (400) → precio → size → fondos.
- Un `instrumentId`/`ticker` inexistente responde `404 INSTRUMENT_NOT_FOUND` (semántica de recurso
  apuntado, igual que el usuario), aunque la spec sugiriera 400.

**Consecuencias.**

- El cliente trata `201` como "aceptada y registrada", y consulta el estado en el body: un rechazo de
  negocio no es un error HTTP y no se reintenta como si lo fuera.
- Cada rechazo es auditable: sin evento con su razón, un `REJECTED` sería indepurable.
- El contrato de forma (campos, tipos, status por operación) vive en `openapi.json`, generado desde
  los schemas Zod con `npm run openapi`; la semántica, en `docs/api.md`.
