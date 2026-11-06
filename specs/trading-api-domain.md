# Spec — API de trading (portfolio, búsqueda, órdenes, transferencias)

> **Estado: implementada. Fuente de verdad del dominio** (UC-1..UC-5 y sus reglas).
> El matching continuo quedó fuera de alcance por `DECISIONS.md` D3; la cotización actual de UC-2
> es la única integración con Yahoo. Para el estado del código y sus archivos, `docs/CODEMAP.md`.
> Fuera de alcance por decisión (`DECISIONS.md`): ingesta de cotizaciones, scheduling, sweep y
> matching continuo. `matchRestingOrders` existe como punto de enchufe del dominio puro, sin
> disparador. UC-2 consulta Yahoo en el request; UC-1/3/4/5 usan `marketdata` local.

## Why

El challenge pide una API que exponga portfolio, búsqueda de activos, envío de
órdenes (MARKET/LIMIT) y gestión de estados. El usuario elevó la vara: reserva de
buying power al aceptar, TIF explícito en el envío y la cotización de UC-2 contra
Yahoo en vez del dataset estático. El matching estilo exchange real —prioridad
precio-tiempo, ticks, sweep— quedó fuera de alcance por `DECISIONS.md`; este documento describe
el comportamiento vigente.

## Fuente de datos de mercado

- **UC-2** consulta la chart API de Yahoo Finance en el request, símbolo directo
  `ticker + ".BA"` (sin tabla de mapping, Rev. 3), con `fetch` y respuesta validada
  por Zod. Precios en **ARS**, sin conversión. No hay lib `yahoo-finance2`.
- Cobertura verificada: **61/65** tickers del seed con el símbolo directo. Los 4
  restantes no tienen precio (delistadas o renombradas, sin mapeo a su sucesor) y
  se omiten de la búsqueda: sin precio no es error de API.
- API **no oficial**: sin SLA, rate-limit y formato mutable. Timeout de 5 s; 429,
  fallas de red o respuesta inválida se traducen a `503
  MARKET_DATA_SERVICE_UNAVAILABLE`. No hay caché de cotizaciones ni ingesta: cada
  request de UC-2 va a la fuente.
- **UC-1/3/4/5** no llaman a Yahoo: el precio de referencia es la última fila de
  `marketdata` por `date` (close del dataset del challenge).
- Evidencia del análisis de fuente: `docs/references/fuentes-datos-mercado.md`.

## Decisiones de diseño

| # | Decisión | Resolución | Estado |
|---|----------|-----------|--------|
| D1 | Ciclo de vida de LIMIT | GTC queda `NEW` (resting) al aceptar, sin evaluación; IOC/FOK se evalúan una sola vez contra el close de `marketdata` y, si no cruzan, `CANCELLED` con razón `NO_IMMEDIATE_MATCH`. El llenado de resting es punto de enchufe (`matchRestingOrders`), sin disparador. | cerrada |
| D2 | Rendimiento (%) por posición | P&L **no realizado** sobre **costo promedio ponderado** de compras; las ventas reducen cantidad sin tocar el promedio. | cerrada |
| D3 | Venta por monto ARS | `size = floor(monto / precio)`. Nunca se vende más de lo pedido; el residuo queda como acciones. `size = 0` → `REJECTED`. | cerrada |
| D4 | Transferencias | Endpoint propio (`CASH_IN` deposita, `CASH_OUT` retira con validación). Modeladas como orders, monto exacto sin floor. | cerrada |
| D5 | Autenticación | Sin auth: `userId` en la request, confiado. Documentado como decisión. | cerrada |
| D6 | Time-In-Force | **GTC (default) + IOC + FOK**. Sin DAY: no existe el estado terminal que lo cierra. | cerrada |
| D7 | Reserva de buying power | Al aceptar una orden: BUY reserva `limit × size` de cash; SELL reserva acciones. | cerrada |
| D8 | Precio de ejecución | Con mejora siempre que exista: BUY fill a `min(límite, referencia)`, SELL a `max(límite, referencia)`. Jamás se ejecuta peor que el límite. | cerrada |
| D9 | Órdenes `NEW` (seed incluidas) | No se llenan solas: no hay matching continuo. Quedan resting hasta que el usuario las cancele. | cerrada |

## Modelo de dominio

- **Instrument**: incluye el ARS como instrumento de tipo `MONEDA`. La `MONEDA`
  no es operable (no aparece en búsqueda ni como instrumento de BUY/SELL).
- **Order**: única fuente de verdad de todos los movimientos financieros
  (operaciones y transferencias). Append-only en sus campos financieros
  (`size`, `price`, `side`, `type`, `timeInForce`); solo `status` y campos de
  ejecución son mutables.
- **Estado financiero derivado**: cash y posiciones se derivan de orders
  `FILLED`; el buying power disponible se deriva de las reservas de las órdenes
  `NEW` (ver UC-1). Todo reproducible desde los eventos → sin drift.
- **Precios**: siempre ARS. `marketdata` = dataset del challenge cacheado
  (close/previousClose) y única fuente del precio de referencia.

## Máquina de estados de la orden

```
envío ── validación de fondos falla ──► REJECTED (terminal, persistida)
envío ── validación OK ──┬─ MARKET ──────────────────────────► FILLED (terminal)
                         ├─ LIMIT IOC/FOK cruza ────────────► FILLED (terminal)
                         ├─ LIMIT IOC/FOK no cruza ─────────► CANCELLED (terminal, razón NO_IMMEDIATE_MATCH)
                         └─ LIMIT GTC ──────────────────────► NEW (resting)
                                NEW ── usuario cancela ─────► CANCELLED (terminal)
```

- No hay fills parciales: el precio de referencia no expone profundidad de libro,
  así que una orden se llena completa contra ese precio o no se llena. Limitación
  documentada frente a un exchange real (que llena por tramos según volumen).
- `REJECTED` es un hecho de negocio que se **persiste**; los errores de input
  inválido son errores de API (400) y no crean orden.
- `FILLED`, `CANCELLED` y `REJECTED` son terminales.
- `NEW` no tiene disparador automático de llenado en este build (ver D1/D9).

## Evaluación de cruce (implementada)

**1. Precio de referencia**

- Puerto `PriceSource`: última fila de `marketdata` por `date` (close). Sin fila o
  close no utilizable (cero o negativo) ⇒ `REJECTED` con razón `NO_PRICE` para
  MARKET e IOC/FOK; un GTC no lo necesita porque queda `NEW`.

**2. `evaluateCross` (dominio puro)**

- Evaluación **única** al enviar, en la transacción de aceptación: LIMIT IOC/FOK
  contra el precio de referencia; MARKET se ejecuta a ese precio.
- Cruce: BUY `referencia ≤ limit` → fill a `min(limit, referencia)`; SELL
  `referencia ≥ limit` → fill a `max(limit, referencia)` (D8). Sin fills parciales.
- GTC nunca se evalúa al enviar: siempre queda resting (D1/D9).

**3. `matchRestingOrders` (punto de enchufe)**

- Función pura que devuelve qué órdenes `NEW` llenarían a un precio de referencia
  dado, en el orden de entrada y sin mutar nada. **Nadie la llama desde la API**:
  el matching continuo está fuera de alcance por `DECISIONS.md`.

**4. Auditoría del ciclo de vida**

- `order_events` append-only: `ACCEPTED`, `REJECTED` (con razón), `FILLED`
  (precio de fill), `CANCELLED` (origen: usuario / IOC-FOK sin cruce). Toda
  transición deja rastro con su causa — el "por qué" es consultable, no inferible.

**Reservas (D7)**

- BUY aceptada: reserva `limit × size` de cash. El fill con mejora (D8) libera
  la diferencia.
- SELL aceptada: reserva `size` acciones (sellable = posición − reservadas).
- Las reservas se **derivan** de las órdenes `NEW` (sin tabla de reservas): el
  estado es reproducible desde events-only, igual que el resto del balance.

## Casos de uso

### UC-1 — Consultar portfolio (`GET /api/users/:userId/portfolio`)

**Salida:** `cash` (disponible, ya descontadas reservas), `reservedCash`,
`totalAccountValue` (**`cashSettled` —disponible más reservado— más la suma del
valor de mercado de las posiciones**), `positions[]` con `ticker`, `name`,
`quantity`, `marketValue` ($), `totalReturnPct` (%).

**Reglas de cálculo** (todas sobre orders `FILLED` salvo las reservas):
- `cashSettled = Σ CASH_IN.size − Σ CASH_OUT.size − Σ BUY(size×price) + Σ SELL(size×price)`
- `cashReserved = Σ sobre NEW BUY (limit × size)`
- `cash = cashSettled − cashReserved`
- `totalAccountValue = cashSettled + Σ marketValue` (las posiciones negativas restan).
  El reservado ya está dentro de `cashSettled`: sumarlo al `cash` disponible lo
  contaría dos veces o lo omitiría, según se mire.
- `quantity = Σ BUY.size − Σ SELL.size` (por instrumento)
- `marketValue = quantity × close`
- Costo promedio ponderado de la **posición viva**: cada BUY sube el promedio
  (`avgCost = (avgCost×qtyPrev + size×price) / (qtyPrev + size)`); cada SELL
  baja la cantidad sin tocar `avgCost`, y cuando la cantidad neta **vuelve a 0**
  el acumulado se reinicia (la posición que se reabre arranca de cero: BUY 10@100,
  SELL 10@100, BUY 10@200 ⇒ `avgCost` 200, no 150).
- `totalReturnPct = (marketValue − quantity × avgCost) / |quantity × avgCost| × 100`
  — denominador en **valor absoluto** (decisión Q2=A): una posición negativa que
  gana da retorno positivo en vez de invertir el signo. Costo 0 ⇒ retorno no
  computable (`null`); posición de cantidad 0 no se lista.

### UC-2 — Buscar activos (`GET /api/instruments?query=...`)

- `query` ausente, vacía o sólo espacios ⇒ listado inicial; con texto, match
  parcial case-insensitive sobre `ticker` **y/o** `name`.
- `limit` opcional, entero 1..100, default **10**. Excluye `MONEDA`;
  resultados en orden ascendente por `ticker`; respuesta array plano.
- Cotización **actual de Yahoo Finance** con símbolo directo `ticker + ".BA"`
  (sin mapping): `price` = último precio de sesión disponible (`regularMarketPrice`),
  `previousClose` = cierre de la **sesión anterior** — no el cierre inicial de un
  rango histórico arbitrario ni un precio instantáneo fabricado con el mercado cerrado.
- `dailyVariationPct` = `(price − previousClose) / previousClose × 100`, calculado
  con el Decimal financiero (64 cifras) y serializado a 2 decimales (`number`);
  `price`/`previousClose` salen como string monetario de 2 decimales.
- **Faltantes:** ticker sin cotización válida (sin precio/cierre anterior computable,
  moneda distinta de ARS) ⇒ se **omite** y el cupo se completa con los siguientes
  candidatos del catálogo, sin reemplazo por el precio del seed; pueden devolverse
  menos resultados que `limit`.
- **Indisponibilidad** (timeout, rate-limit, red): `503 MARKET_DATA_SERVICE_UNAVAILABLE`
  con mensaje al usuario exacto — ni precios históricos presentados como actuales,
  ni array vacío que disimule la falla.
- Fuente de la decisión: `specs/instruments-current-quotes.md`. Este cambio no reabre los demás
  casos de uso.

### UC-3 — Enviar orden (`POST /api/users/:userId/orders`)

**Entrada** (Zod en el borde): `instrumentId` o ticker, `side` (BUY/SELL),
`type` (MARKET/LIMIT), `timeInForce` (GTC default; IOC, FOK), y **exactamente uno**
de `size` (acciones) o `amountArs`; `price` > 0 obligatorio para LIMIT.

**MARKET** (independiente del TIF — un exchange real no somete a TIF una MARKET):
- BUY con `size`: si `cashSettled < size × close` → `REJECTED` (persistida).
  Si no → `FILLED` a `close` en la misma transacción.
- BUY con `amountArs`: `size = floor(amountArs / close)`; `size = 0` → `REJECTED`;
  el residuo queda como cash.
- SELL con `size`: si `size > sellable` → `REJECTED`; si no → `FILLED` a `close`.
- SELL con `amountArs`: `size = floor(amountArs / close)` (D3); `0` → `REJECTED`.

**LIMIT GTC** (resting):
- Validación de fondos con **reserva** (D7) contra el precio límite.
- Queda `NEW` sin evaluación al enviar: no hay matching continuo que la llene
  (D1/D9). Solo el usuario la cierra.

**LIMIT IOC / FOK** (inmediatas, nunca quedan resting):
- Se evalúan una sola vez contra la última cotización de `marketdata`, en la
  transacción de envío.
- Si cruza → `FILLED` completo con mejora (D8). Si no → `CANCELLED` con razón
  `NO_IMMEDIATE_MATCH` (no `REJECTED`: no es falta de fondos, es falta de
  contraoferta al instante).
- Sin profundidad de libro, IOC y FOK son all-or-none sobre el precio observado;
  la diferencia teórica (IOC admite fill parcial) queda documentada como
  limitación del feed, no como comportamiento inventado.

**Errores de API (no crean orden):**
- Input inválido (Zod), instrumento inexistente u `MONEDA`, `size ≤ 0`,
  `price ≤ 0`, LIMIT sin `price`, `size` y `amountArs` simultáneos o ausentes → `400`.
- Usuario inexistente → `404`.
- Idempotencia: header `Idempotency-Key` opcional; repetir la key devuelve la
  orden original en vez de duplicar la ejecución.

### UC-4 — Cancelar orden (`DELETE /api/orders/:orderId`)

- Solo si `NEW` → `CANCELLED` (libera reserva).
- `FILLED`/`CANCELLED`/`REJECTED` → `422` sin mutar.

### UC-5 — Transferencia (`POST /api/users/:userId/transfers`)

- `amountArs > 0` como string decimal estricto; `side` (`CASH_IN`/`CASH_OUT`).
- Las transferencias nuevas representan el monto exacto con centavos en size, price 1.00;
  no aplican floor. Las históricas y sus replays conservan el movimiento efectivamente persistido.
- `CASH_IN` → FILLED inmediato.
- `CASH_OUT`: si `amountArs > cashSettled − cashReserved` → `REJECTED` persistida;
  si no → FILLED. Validación del monto exacto dentro de la misma tx con lock por usuario.

## Constraints

- Dinero **nunca en float**: Decimal financiero desde string con precisión 64;
  entrada string decimal estricta y salida string con dos decimales; precios/size NUMERIC(24,2).
  Quantities agregadas bigint y representación JSON entera string. Detalle, límites y
  compatibilidad histórica: spec financiera firmada.
- Acciones enteras: sin fracciones, sin fills parciales (limitación documentada).
- Toda multi-escritura (fill + evento + derivados) en una transacción DB.
- Transición de estado siempre guardada por el estado actual
  (`WHERE status='NEW'`): idempotencia ante reintentos concurrentes.
- Auditable: `orders` (salvo status/ejecución) y `order_events` append-only.
- Validación estricta con Zod en el borde HTTP; sin `any`; TS strict.
- La API no depende de Yahoo en caliente para UC-1/3/4/5: usan `marketdata`
  local y no consultan Yahoo por request; el matching continuo sigue fuera de
  alcance (`DECISIONS.md`). UC-2 sí consulta Yahoo en el request y ante
  indisponibilidad responde `503 MARKET_DATA_SERVICE_UNAVAILABLE`.
- Test funcional obligatorio sobre UC-3: MARKET BUY/SELL con fondos suficientes e
  insuficientes, orden por monto (floor), REJECTED persistido, LIMIT marketable
  IOC/FOK que llena al envío, IOC/FOK que no cruza → CANCELLED inmediato, y doble
  DELETE concurrente sobre la misma `NEW` con un solo efecto.

## Tasks (cada una con su verificación)

1. **T1 — Schema Prisma + migración**: `users`, `instruments`, `marketdata`
   (dataset del challenge), `orders` con `timeInForce`, `filledPrice`, `filledAt`,
   `status`; `order_events`; índices `(status, instrumentId)` y `(userId, status)`.
   ✔ `prisma migrate dev` aplica y `prisma validate` pasa.
2. **T2 — Capa de dominio de cálculo**: funciones puras `deriveCash`,
   `derivePositions`, `weightedAverageCost`, `deriveReservations`. ✔ Unit tests
   con escenarios entrelazados (compras/ventas/transferencias/reservas),
   exactos a centavos.
3. **T3 — Caso de uso enviar orden con TIF**: transacción de aceptación con
   validación, reserva y evaluación única (MARKET fill, IOC/FOK fill o cancel,
   GTC resting). ✔ Tests funcionales de UC-3 (constraint de arriba) pasan.
4. **T4 — Adaptador Yahoo de UC-2**: símbolo derivado `ticker + ".BA"`, respuesta
   validada con Zod, `FinancialDecimal` en el borde y traducción de fallas a
   `MarketDataServiceUnavailableError`. ✔ Unit tests con fixture de chart +
   verificación manual contra la API viva documentada.
5. **T5 — Evaluación de cruce**: `evaluateCross` con mejora, `matchRestingOrders`
   como punto de enchufe sin disparador, transición atómica guardada por estado.
   ✔ Unit tests con precios sintéticos (cruce exacto, gap con mejora, referencia
   inválida, doble DELETE concurrente con un solo efecto).
6. **T6 — Endpoints portfolio + búsqueda**: ✔ contrato UC-1/UC-2 verificado con
   datos del seed (valores esperados calculados a mano en el test).
7. **T7 — Endpoints cancelar + transferencias**: ✔ UC-4/UC-5: cancelar NEW libera
   reserva, 422 en terminal, CASH_OUT que rechaza por insuficiencia.
8. **T8 — Documentación + colección**: decisiones D1–D9 y supuestos en docs +
   colección Postman/REST Client con ejemplos (nice-to-have del enunciado). ✔
   Cada decisión del enunciado tiene rastro en la doc.
