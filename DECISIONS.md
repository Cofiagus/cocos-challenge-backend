- Precio de referencia: última fila de `marketdata` por `date` (no `datetime`),
  para portfolio y órdenes (UC-1/3/4/5; la búsqueda UC-2 usa cotizaciones actuales
  de Yahoo, ver entrada propia más abajo).
  Sin precio: `marketValue: null`, `priceAvailable: false`, no suma al total,
  y las órdenes que lo necesiten se rechazan con `NO_PRICE`.
- MARKET: se ejecuta al precio de referencia, FILLED en la misma transacción.
- LIMIT GTC: siempre queda `NEW` (nunca se llena al enviar). Reserva fondos/acciones.
- LIMIT IOC / FOK: se evalúan una vez contra el precio de referencia.
  Cruza => FILLED con mejora (BUY a min(límite, ref), SELL a max(límite, ref)).
  No cruza => CANCELLED con razón `NO_IMMEDIATE_MATCH`. Sin fills parciales.
- `matchRestingOrders(refPrice, orders)`: función pura, testeada, SIN disparador
  automático. Queda documentada como punto de enchufe para la evolución.
- Reservas (derivadas de órdenes NEW, sin tabla): BUY reserva `limit × size` de
  cash; SELL reserva `size` acciones. `cash = cashSettled − cashReserved`.
  CASH_OUT valida contra `cashSettled − cashReserved`.
- Rendimiento: P&L no realizado sobre costo promedio ponderado (las ventas no
  tocan el promedio). Posición con cantidad 0 no se lista. Posición negativa
  heredada del seed se lista tal cual y se documenta.
- amountArs de BUY/SELL: `size = floor(amount / precio)`; size 0 => REJECTED `ZERO_SIZE`;
  derivado fuera de INT4 => 400 sin escritura, validado antes de convertir a number.
- Dinero: nunca float. Constructor Decimal financiero de precisión 64 desde strings.
  Entrada monetaria string decimal estricto; salida string con 2 decimales. NUMERIC(24,2)
  en precios/size. Cantidades agregadas bigint y quantity JSON string; acciones por orden INT4.
- Transferencias nuevas: size almacena el monto exacto en pesos con centavos, price=1.00;
  no floor. El dominio discrimina cash (amountArs Decimal) de trading (sizeShares entero).
  Replays cash históricos y despliegue incompatible según la spec firmada
  `specs/datos-financieros-grandes-montos.md` §5/§6: no reconstruir dinero descartado.
- `orders.price` = límite enviado. `orders.filledPrice` = precio de ejecución.
- Idempotencia: header `Idempotency-Key` opcional, `UNIQUE(userId, idempotencyKey)`,
  insert como PRIMERA escritura con ON CONFLICT DO NOTHING. Misma key + mismo
  payload => devuelve la orden original. Misma key + payload distinto => 409.
- Concurrencia: validación + inserción en una transacción con lock por usuario
  (`pg_advisory_xact_lock` o `SELECT ... FOR UPDATE`).
- HTTP: éxito 201 también para REJECTED/CANCELLED persistidas. Input inválido
  400 (no crea orden). Usuario inexistente 404. Cancelar no-NEW 422.
  Error body: `{ "error": { "code": string, "message": string } }`.
- Razones (guardadas en `order_events`): INSUFFICIENT_FUNDS, INSUFFICIENT_POSITION,
  ZERO_SIZE, NO_PRICE, NO_IMMEDIATE_MATCH.
- Rutas: `GET /api/users/:userId/portfolio`, `GET /api/instruments?query=`,
  `POST /api/users/:userId/orders`, `DELETE /api/orders/:orderId`,
  `POST /api/users/:userId/transfers`.
- MONEDA: no operable, no aparece en búsqueda ni en portfolio.positions.
- Búsqueda UC-2 — REAPERTURA EXCLUSIVA de Yahoo (decisión del usuario, spec
  `specs/instruments-current-quotes.md` Rev. 2): query ausente/vacía/sólo
  espacios => listado inicial; `limit` default 10 (entero 1..100); match parcial
  case-insensitive por ticker/name, MONEDA excluida, orden ticker asc.
  Cotización ACTUAL de Yahoo con símbolo directo `ticker + ".BA"` (sin mapping):
  `price` = último precio de sesión disponible, `previousClose` = cierre de la
  sesión anterior (no histórico arbitrario ni precio instantáneo). Ticker sin
  cotización válida => se OMITE y el cupo se completa con los siguientes
  candidatos (sin fallback al seed; puede haber menos resultados). Yahoo
  indisponible/timeout/rate-limit/red => 503 `MARKET_DATA_SERVICE_UNAVAILABLE`
  (ni array vacío ni listado parcial como éxito). Dinero de salida string con
  2 decimales; `dailyVariationPct` number. Yahoo sigue FUERA de ingesta,
  matching y `price_ticks`; UC-1/3/4/5 no usan Yahoo.
- Índices: una sola fuente (`prisma/schema.prisma`). Mínimos: `(status, instrumentId)`,
  `(userId, status)`, `marketdata(instrumentId, date DESC)`.
