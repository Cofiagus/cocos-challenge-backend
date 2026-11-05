# API — semántica de los endpoints

> **Este documento no repite campos ni tipos.** La forma exacta de cada request/response, los
> status y los códigos de error están en [`../openapi.json`](../openapi.json) (OpenAPI 3.1,
> generado desde los schemas Zod de `src/contracts`; `npm run openapi` lo regenera).
> Acá va lo que un schema no puede expresar: cuándo usar cada endpoint, qué significa cada
> estado y qué invariantes se cumplen.

Base: `http://localhost:3000/api` · JSON · errores siempre `{ "error": { "code", "message" } }`.

## Convenciones

| Tema | Regla |
|---|---|
| Dinero | Entrada: **string decimal estricto** — hasta 22 dígitos enteros y 2 decimales, punto decimal; sin exponente, separadores, `+`, espacios ni ceros iniciales (salvo el `0` propio). Un JSON `number` ⇒ 400: el parser ya pudo perder cifras y la aplicación no puede recuperarlas. Salida: **string con exactamente 2 decimales**, sin notación científica ni `-0.00`; `null` donde significa ausencia. Los agregados (`cash`, `totalAccountValue`) pueden superar el máximo de una fila por suma. Nunca se calcula en float: constructor `Decimal` financiero de precisión 64, alimentado por strings. |
| Timestamps | ISO 8601 **sin offset** (`2026-11-03T12:00:00`): la columna es `timestamp` sin zona, hora local del mercado. |
| `size` (órdenes) | Acciones enteras: entrada `number` 1..2147483647 (la cota INT4 por orden, sin cambios) y respuesta `number` entero o `null`. Un `size` derivado de `amountArs` fuera de ese rango es 400 `VALIDATION_ERROR` **sin ninguna escritura**, no un 500 del INSERT. |
| `size` (transferencias) | En la respuesta es **string monetario** de pesos con 2 decimales (el monto movido o pedido, ej. `"123.45"`); el monto entra por `amountArs` (string). |
| `quantity` (portfolio) | **String entero canónico**, con signo para la posición negativa heredada; el agregado interno es exacto (bigint) aunque supere el entero seguro de JS. |
| `reason` | Sólo en `REJECTED`/`CANCELLED`: `INSUFFICIENT_FUNDS`, `INSUFFICIENT_POSITION`, `ZERO_SIZE`, `NO_PRICE`, `NO_IMMEDIATE_MATCH`. En `NEW`/`FILLED` es `null`. |
| `Idempotency-Key` | Header opcional, 1..64 chars, en `POST /orders` y `POST /transfers`. |
| Validación | Zod `strict()`: campo desconocido o tipo inválido → **400 sin escribir nada**. |
| 500 | Manejador central (`src/http/error-handler.ts`): cualquier fallo que no sea de dominio responde JSON `{ "error": { "code": "INTERNAL_ERROR", "message": "Error interno del servidor." } }` — mensaje genérico, sin stack ni rutas del disco; el detalle (stack en una línea) queda en stderr del proceso. |

**Precedencia de validación en `POST /orders`** (el primer fallo gana): params → header → body
(400) → usuario (404) → instrumento (404) → MONEDA (400) → precio → size → fondos.

## 1. `GET /users/:userId/portfolio`

Proyección de `orders`, no una tabla de saldos. `cash` es **disponible** (`settled − reservado por
órdenes `NEW` de compra`); `reservedCash` viene aparte para que la resta sea auditable.

- Sin precio de referencia: `marketValue` y `totalReturnPct` son `null`, `priceAvailable` es
  `false` y la posición **no suma** a `totalAccountValue`. Nunca se inventa un precio. Las
  negativas SÍ restan.
- `totalAccountValue` = `cash` disponible + `reservedCash` + Σ `marketValue` de las posiciones
  con precio. Abrir una orden no lo mueve (la reserva es exacta: baja `cash` y sube
  `reservedCash` en la misma cifra) y cancelarla tampoco (se libera la reserva).
- Posición con cantidad 0 no se lista. La negativa heredada del seed (BMA −10) se lista tal cual (`"quantity": "-10"`).
- `MONEDA` (ARS) nunca aparece como posición: el cash no es un activo operable.
- Usuario inexistente → 404. `userId` no entero > 0 → 400.

## 2. `GET /instruments?query=<texto>&limit=<1..100>`

Búsqueda **parcial y case-insensitive** sobre `ticker` y `name`. `MONEDA` queda excluida.
`query` vacía o ausente → 400 (no es una búsqueda "de todo"). Respuesta: **array plano**.
Sin `marketdata` para el instrumento: `price`, `previousClose` y `dailyVariationPct` en `null`.

## 3. `POST /users/:userId/orders`

**201 siempre que el input sea válido**, incluso si la orden queda `REJECTED` o `CANCELLED`: el
endpoint hizo su trabajo (recibió, evaluó, persistió). Reservar 4xx para eso confundiría "input
inválido" con "el negocio dijo no".

| Caso | Resultado |
|---|---|
| `MARKET` | `FILLED` al precio de referencia, en la misma transacción |
| `LIMIT GTC` | `NEW` (nunca se llena al enviar); reserva cash (BUY) o acciones (SELL) |
| `LIMIT IOC/FOK` | cruza → `FILLED` con mejora (`BUY` paga `min(límite, ref)`); no cruza → `CANCELLED` con `NO_IMMEDIATE_MATCH` |
| fondos/tenencia insuficientes | `REJECTED` con `INSUFFICIENT_*` |
| `size` 0 | `REJECTED` con `ZERO_SIZE` |
| instrumento sin marketdata (lo necesita) | `REJECTED` con `NO_PRICE` |

Idempotencia: la key es la **primera escritura** de la transacción (`ON CONFLICT DO NOTHING`).

- Misma key + mismo payload → **201 con la orden original**, sin evento nuevo, `reason: null`
  (la razón del rechazo vive en `order_events`).
- Misma key + otro payload → **409**.

En `MARKET`, `price` se omite o va `null`; un precio → 400. En `LIMIT` es obligatorio: **string monetario** > 0 (`"900.00"`). El dinero (`price`, `amountArs`) **nunca** viaja como JSON `number`.

Errores: 400 (XOR `instrumentId`|`ticker`, XOR `size`|`amountArs`, `LIMIT` sin `price`, `MARKET`
con `price`, dinero como `number` o fuera de la gramática monetaria, `size` por encima de la cota
— incluido el derivado de `amountArs`, rechazado antes de convertir a `number` y sin escribir,
header inválido), 400
`INSTRUMENT_NOT_OPERABLE` (MONEDA), 404 usuario, 404 instrumento, 409 idempotencia.

## 4. `DELETE /orders/:orderId`

Sólo `NEW`. La transición es un `UPDATE … WHERE status='NEW'` atómico: de dos DELETE concurrentes
uno devuelve **200** y el otro **422**, sin mutar ni duplicar eventos. Cancelar libera la reserva
(se ve al instante en `reservedCash` del portfolio).

**200**, no 201: el 201 está reservado para creación. Orden inexistente → 404; ya no `NEW` → 422.

## 5. `POST /users/:userId/transfers`

Una transferencia es una **orden** del instrumento `ARS` (`price` = `"1.00"`, el monto viaja en
`amountArs`): así la proyección de cash la procesa como cualquier otro movimiento, sin tabla aparte.

- `CASH_IN` acredita el **monto exacto con centavos, sin floor** → `FILLED` inmediata. `"0.01"`
  es válida: el `ZERO_SIZE` de cash desapareció para transferencias nuevas (queda para el sizing
  de acciones y los históricos).
- `CASH_OUT` compara el **monto exacto** contra el **disponible** leído dentro de la transacción;
  si no alcanza → `REJECTED INSUFFICIENT_FUNDS` con **201** (persistida, auditable).
- En la respuesta, `size` es el monto como **string monetario** de 2 decimales: `CASH_IN
  "123.45"` → `"size": "123.45"`, `"price": "1.00"`.
- Idempotencia de cash histórico (política conservadora): una key histórica pedida por `123.45`
  pero persistida como 123 pesos devuelve la fila original (`"size": "123.00"`) — el residuo
  descartado no se reacredita. Retry con monto distinto → **409**; si la evidencia del evento de
  origen (`metadata.amountArs`) no alcanza para establecer el pedido exacto → **409**.
- Mismo comportamiento de idempotencia general que `POST /orders` (201 replay / 409 conflicto);
  dos transferencias nuevas con montos que difieren por centavos (`"123.01"` vs `"123.99"`) son
  **409**, nunca colapsan por floor.

## Códigos de error

| Código | Status | Cuándo |
|---|---|---|
| `VALIDATION_ERROR` | 400 | params/query/header/body inválidos (Zod) — sin efectos |
| `INVALID_JSON` | 400 | el body no parsea como JSON (body-parser) |
| `INSTRUMENT_NOT_OPERABLE` | 400 | el instrumento es `MONEDA` |
| `USER_NOT_FOUND` | 404 | `userId` inexistente |
| `ORDER_NOT_FOUND` | 404 | `orderId` inexistente (DELETE) |
| `INSTRUMENT_NOT_FOUND` | 404 | `instrumentId`/`ticker` inexistente en POST /orders |
| `NOT_FOUND` | 404 | ruta inexistente o método no soportado en una ruta existente (Express 5 no distingue 404 de ruta de un 405 de método: ambos son "no hay handler", el servidor responde 404) |
| `IDEMPOTENCY_CONFLICT` | 409 | misma key, otro payload |
| `ORDER_NOT_CANCELLABLE` | 422 | cancelar una orden que no está `NEW` |
| `PAYLOAD_TOO_LARGE` | 413 | el body supera el límite de 100 KB de `express.json` |
| `INTERNAL_ERROR` | 500 | error inesperado; mensaje genérico, el detalle queda en stderr |

Los 11 códigos de la tabla integran `API_ERROR_CODES` (el contrato del error
`{error:{code,message}}`). Los 7 de negocio los emiten los routers; los 4 transversales
(`NOT_FOUND`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE`, `INTERNAL_ERROR`) los responde el manejador
central de `src/http/error-handler.ts`, registrado después de los routers en `src/http/app.ts`.
`INSTRUMENT_NOT_FOUND` entró al contrato con status 404 en `POST /orders` (`instrumentId`|`ticker`
inexistente, sin orden).
