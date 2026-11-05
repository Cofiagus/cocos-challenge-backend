# Spec — API de trading (portfolio, búsqueda, órdenes, transferencias, matching)

> Estado: **fuente de verdad del dominio** (UC-1..UC-5 y sus reglas), implementada **con alcance
> reducido**: los casos de uso y sus invariantes se construyeron; las fuentes de precio y el matching
> continuo que describe este documento quedaron cerrados por `DECISIONS.md`. Para el estado del
> código y sus archivos, `docs/CODEMAP.md`.
> Fuera de alcance por decisión (`DECISIONS.md`): Yahoo Finance, `price_ticks`, ingesta,
> scheduling, `DAY`/`EXPIRED`, sweep y matching continuo. `matchRestingOrders` existe como
> punto de enchufe, sin disparador.
>
> Rev. 2 — incorpora fuente real de precios (Yahoo Finance vía `yahoo-finance2`)
> y arquitectura de matching estilo exchange real.
> Rev. 3 — quita `instrument_symbol_map`: el símbolo Yahoo se deriva directo del
> ticker (`ticker + ".BA"`); ticker expirado o renombrado = sin precio, no es error.
> Rev. 4 — decisión del usuario: capacidad/precisión y contrato financiero según
> `specs/datos-financieros-grandes-montos.md` Rev. 2 aprobada. No amplía matching ni identidad.

## Why

El challenge pide una API que exponga portfolio, búsqueda de activos, envío de
órdenes (MARKET/LIMIT) y gestión de estados. El usuario elevó la vara: el
comportamiento de las órdenes limit debe modelarse **como un exchange real**
(TIF, reserva de buying power, prioridad precio-tiempo, auditoría del matching),
usando Yahoo Finance como fuente de precios en lugar del dataset estático.

## Fuente de datos de mercado

Yahoo Finance chart API, símbolos `.BA`, vía lib `yahoo-finance2`. Análisis
completo con evidencia en `docs/references/fuentes-datos-mercado.md`:

- Cobertura verificada: **61/65** tickers del seed con el símbolo directo
  `ticker + ".BA"` (precios en **ARS**, sin conversión). Sin tabla de mapping:
  los 4 restantes quedan **sin precio** y el ingestor los salta — `PGR`/`IRCP`
  delistadas reales 2022; `DYCA`/`MTR` renombradas, sin mapeo a su sucesor
  (Rev. 3, decisión del usuario). Política: sin precio, no es error; el
  instrumento sigue con el último snapshot cacheado.
- API **no oficial**: sin SLA, rate-limit, formato mutable. Mitigación: toda
  cotización se persiste cacheada (`marketdata` + `price_ticks`); si la fuente
  cae, la API del challenge sigue operando con el último snapshot.
- Re-verificado en vivo 2026-11-01: GGAL 5365 / BYMA 211 / YPFD 7790 (ARS).

## Decisiones de diseño

| # | Decisión | Resolución | Estado |
|---|----------|-----------|--------|
| D1 | Ciclo de vida de LIMIT | Matching estilo exchange real: motor que evalúa órdenes restantes contra ticks observados de Yahoo. Detalle en **Arquitectura de matching**. | cerrada |
| D2 | Rendimiento (%) por posición | P&L **no realizado** sobre **costo promedio ponderado** de compras; las ventas reducen cantidad sin tocar el promedio. | cerrada |
| D3 | Venta por monto ARS | `size = floor(monto / precio)`. Nunca se vende más de lo pedido; el residuo queda como acciones. `size = 0` → `REJECTED`. | cerrada |
| D4 | Transferencias | Endpoint propio (`CASH_IN` deposita, `CASH_OUT` retira con validación). Modeladas como orders. | cerrada |
| D5 | Autenticación | Sin auth: `userId` en la request, confiado. Documentado como decisión. | cerrada |
| D6 | Time-In-Force | **GTC + DAY + IOC + FOK** (elección del usuario: superficie de test completa a cambio de realismo). | cerrada |
| D7 | Expiración DAY | Estado terminal propio `EXPIRED` (semánticamente distinto de CANCELLED; el enunciado permite extender el schema con justificación). | **default — confirmar** |
| D8 | Reserva de buying power | Al aceptar una orden: BUY reserva `limit × size` de cash; SELL reserva acciones. El fill nunca puede fallar por fondos (invariante de exchange real). | **default — confirmar** |
| D9 | Precio de ejecución | Con mejora siempre que exista: BUY fill a `min(límite, precio observado)`, SELL a `max(límite, precio observado)`. Jamás se ejecuta peor que el límite. | **default — confirmar** |
| D10 | Órdenes NEW del seed | Participan del matching como cualquier GTC: si el precio actual cruza el límite, se llenan (p. ej. la LIMIT BUY de BMA a 1500 llena a ~211 con mejora). | **default — confirmar** |

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
- **Precios**: siempre ARS. `marketdata` = caché diaria (close/previousClose);
  `price_ticks` = evidencia intradía append-only del ingestor.

## Máquina de estados de la orden

```
envío ── validación de fondos falla ──► REJECTED (terminal)
envío ── validación OK ──┬─ MARKET ─────────────────────► FILLED (terminal)
                         ├─ LIMIT IOC/FOK cruza ────────► FILLED (terminal)
                         ├─ LIMIT IOC/FOK no cruza ─────► CANCELLED (terminal, razón NO_IMMEDIATE_MATCH)
                         └─ LIMIT GTC/DAY ──► NEW (resting)
                                NEW ── tick cruza ──► FILLED (terminal, con mejora de precio)
                                NEW ── usuario cancela ──► CANCELLED (terminal)
                                NEW ── cierre de rueda (solo DAY) ──► EXPIRED (terminal)
```

- No hay fills parciales: el feed no expone profundidad de libro, así que una
  orden se llena completa contra el precio observado o sigue viva. Limitación
  documentada frente a un exchange real (que llena por tramos según volumen).
- `REJECTED` es un hecho de mercado que se **persiste**; los errores de input
  inválido son errores de API (400) y no crean orden.
- `FILLED`, `CANCELLED`, `REJECTED`, `EXPIRED` son terminales.

## Arquitectura de matching (exchange-real)

**1. QuoteIngestionService** (adaptador de fuente)

- Resolución de símbolo **directa y sin estado**: símbolo Yahoo = `ticker + ".BA"`.
  No hay tabla de mapping (Rev. 3): un ticker expirado o renombrado no se traduce
  a su sucesor — la fuente no lo resuelve y el ingestor lo salta explícitamente
  (404 / sin precio ≠ error; el instrumento vive con el último snapshot).
- Poll **dirigido por interés**: consulta únicamente instrumentos con órdenes
  `NEW` restantes, con TTL de caché (~60 s) durante la rueda BYMA
  (11:00–17:00 America/Argentina/Buenos_Aires, con margen) y backoff exponencial
  ante 429 / fallos de red.
- En el borde de ingesta: el float de la fuente se convierte a **centavos
  enteros** con validación estricta; nunca se persiste el float crudo.
- Cada cotización observada se persiste como tick append-only en `price_ticks`
  (instrumento, last, timestamp de fuente y de ingesta). Es la evidencia
  auditable de cada decisión de matching.

**2. MatchingEngine**

- Disparo: (a) al aceptar una orden — evaluación inmediata, así una LIMIT
  *marketable* (que ya cruza el precio) se llena al instante, igual que en un
  exchange; (b) tras cada lote de ingesta de ticks.
- Toma las órdenes `NEW` del instrumento en **prioridad precio-tiempo**
  (mejor precio primero; FIFO dentro del mismo precio — el orden justo estándar
  de los libros de órdenes).
- Cruce contra el último tick **fresco** (ventana de frescura ~5 min; tick
  vencido = mercado no evaluable → la orden espera; de paso bloquea matching
  fuera de rueda, porque las cotizaciones dejan de actualizarse).
  - BUY: `last ≤ limit` → fill a `min(limit, last)` (D9).
  - SELL: `last ≥ limit` → fill a `max(limit, last)` (D9).
- Transición atómica e idempotente: `UPDATE orders SET status='FILLED',
  filledPrice=?, filledAt=now() WHERE id=? AND status='NEW'` + inserción del
  evento de auditoría, todo en una transacción. Dos ticks concurrentes no pueden
  doble-llenar la misma orden.
- MARKET: se ejecuta al último precio observado (`close`, según el enunciado)
  dentro de la evaluación inmediata del envío.

**3. ExpirationSweep** (DAY)

- `expiresAt` se fija al aceptar: cierre de la rueda de aceptación, o cierre de
  la siguiente rueda si se aceptó fuera de horario.
- Barre al cierre de la rueda: DAY no llenada → `EXPIRED` (D7) y libera reservas.
  Chequeo perezoso adicional en cada evaluación (no depende solo del timer).

**4. OrderLifecycleAudit**

- `order_events` append-only: `ACCEPTED`, `REJECTED` (con razón), `FILLED`
  (precio de fill + referencia al `price_tick` que lo motivó), `CANCELLED`
  (origen: usuario / IOC-FOK sin cruce), `EXPIRED`. Toda transición deja rastro
  con su causa — el "por qué" es consultable, no inferible.

**Reservas (D8)**

- BUY aceptada (GTC/DAY): reserva `limit × size` de cash. El fill con mejora
  (D9) libera la diferencia.
- SELL aceptada: reserva `size` acciones (sellable = posición − reservadas).
- Las reservas se **derivan** de las órdenes `NEW` (sin tabla de reservas): el
  estado es reproducible desde events-only, igual que el resto del balance.

## Casos de uso

### UC-1 — Consultar portfolio (`GET /api/users/:userId/portfolio`)

**Salida:** `cash` (disponible, ya descontadas reservas), `reservedCash`,
`totalAccountValue` (cash + Σ valor de mercado de posiciones), `positions[]`
con `ticker`, `name`, `quantity`, `marketValue` ($), `totalReturnPct` (%).

**Reglas de cálculo** (todas sobre orders `FILLED` salvo las reservas):
- `cashSettled = Σ CASH_IN.size − Σ CASH_OUT.size − Σ BUY(size×price) + Σ SELL(size×price)`
- `cashReserved = Σ sobre NEW BUY (limit × size)`
- `cash = cashSettled − cashReserved`
- `quantity = Σ BUY.size − Σ SELL.size` (por instrumento)
- `marketValue = quantity × close`
- Costo promedio ponderado: cada BUY sube el promedio
  (`avgCost = (avgCost×qtyPrev + size×price) / (qtyPrev + size)`); cada SELL
  baja la cantidad sin tocar `avgCost`.
- `totalReturnPct = (marketValue − quantity × avgCost) / (quantity × avgCost) × 100`
  (posición de cantidad 0 no se lista).

### UC-2 — Buscar activos (`GET /api/instruments?query=...`)

- Match parcial case-insensitive sobre `ticker` **y/o** `name` (también prefijo
  de ticker, p. ej. `"APPL"`).
- Excluye `MONEDA`. Devuelve `ticker`, `name`, `type`, último precio y variación
  diaria (`close` vs `previousClose`).

### UC-3 — Enviar orden (`POST /api/users/:userId/orders`)

**Entrada** (Zod en el borde): `instrumentId` o ticker, `side` (BUY/SELL),
`type` (MARKET/LIMIT), `timeInForce` (GTC default; DAY, IOC, FOK), y
**exactamente uno** de `size` (acciones) o `amountArs`; `price` > 0 obligatorio
para LIMIT.

**MARKET** (independiente del TIF — un exchange real no somete a TIF una MARKET):
- BUY con `size`: si `cashSettled < size × close` → `REJECTED` (persistida).
  Si no → `FILLED` a `close` en la misma transacción.
- BUY con `amountArs`: `size = floor(amountArs / close)`; `size = 0` → `REJECTED`;
  el residuo queda como cash.
- SELL con `size`: si `size > sellable` → `REJECTED`; si no → `FILLED` a `close`.
- SELL con `amountArs`: `size = floor(amountArs / close)` (D3); `0` → `REJECTED`.

**LIMIT GTC / DAY** (resting):
- Validación de fondos con **reserva** (D8) contra el precio límite.
- Evaluación inmediata al aceptar: si ya cruza (marketable) → fill con mejora.
  Si no → `NEW`; el MatchingEngine la llena al cruzar un tick (D1/D9).
- DAY: `expiresAt` fijado; al expirar → `EXPIRED`.

**LIMIT IOC / FOK** (inmediatas, nunca quedan resting):
- Se evalúan una sola vez contra la última cotización fresca, en la transacción
  de envío.
- Si cruza → `FILLED` completo con mejora (D9). Si no → `CANCELLED` con razón
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
- `FILLED`/`CANCELLED`/`REJECTED`/`EXPIRED` → `422` sin mutar.

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
  compatibilidad histórica: spec financiera firmada. No se activa la ingesta excluida del alcance.
- Acciones enteras: sin fracciones, sin fills parciales (limitación documentada).
- Toda multi-escritura (fill + evento + derivados) en una transacción DB.
- Transición de estado siempre guardada por el estado actual
  (`WHERE status='NEW'`): idempotencia del matching ante ticks concurrentes.
- Auditable: `orders` (salvo status/ejecución) y `order_events`/`price_ticks`
  append-only.
- Validación estricta con Zod en el borde HTTP; sin `any`; TS strict.
- La API no depende de Yahoo en caliente: si la fuente cae, portfolio/cancel/
  transferencias siguen operando con la última caché; solo el matching con
  cotizaciones nuevas se detiene.
- Test funcional obligatorio sobre el caso de uso de envío de orden (UC-3):
  MARKET BUY/SELL con fondos suficientes e insuficientes, orden por monto (floor),
  REJECTED persistido, y además: LIMIT marketable que llena al envío, IOC/FOK que
  no cruza → CANCELLED inmediato, y doble-tick sin doble-fill.

## Tasks (cada una con su verificación)

1. **T1 — Schema Prisma + migración**: schema completo desde cero: `users`,
   `instruments`, `marketdata` (dataset del challenge), `orders` con
   `timeInForce`, `expiresAt`, `filledPrice`, `filledAt`, `status` (`EXPIRED`);
   `order_events`, `price_ticks`; índices `(status, instrumentId)` y
   `(userId, status)`. ✔ `prisma migrate dev` aplica y `prisma validate` pasa.
2. **T2 — Capa de dominio de cálculo**: funciones puras `deriveCash`,
   `derivePositions`, `weightedAverageCost`, `deriveReservations`. ✔ Unit tests
   con escenarios entrelazados (compras/ventas/transferencias/reservas),
   exactos a centavos.
3. **T3 — Caso de uso enviar orden con TIF**: transacción de aceptación con
   validación, reserva y evaluación inmediata (MARKET fill, marketable fill,
   IOC/FOK cancel). ✔ Tests funcionales de UC-3 (constraint de arriba) pasan.
4. **T4 — QuoteIngestionService**: símbolo derivado `ticker + ".BA"`, conversión a
   centavos en el borde, `price_ticks` append-only, TTL + backoff. ✔ Unit tests con fixture
   de respuesta de Yahoo + verificación manual contra la API viva documentada.
5. **T5 — MatchingEngine + ExpirationSweep**: prioridad precio-tiempo, cruce con
   frescura, transición atómica guardada, expiración DAY. ✔ Unit tests con ticks
   sintéticos (cruce exacto, gap con mejora, tick vencido, doble tick
   concurrente sin doble-fill, expiración al cierre).
6. **T6 — Endpoints portfolio + búsqueda**: ✔ contrato UC-1/UC-2 verificado con
   datos del seed (valores esperados calculados a mano en el test).
7. **T7 — Endpoints cancelar + transferencias**: ✔ UC-4/UC-5: cancelar NEW libera
   reserva, 422 en terminal, CASH_OUT que rechaza por insuficiencia.
8. **T8 — Documentación + colección**: decisiones D1–D10 y supuestos en docs +
   colección Postman/REST Client con ejemplos (nice-to-have del enunciado). ✔
   Cada decisión del enunciado tiene rastro en la doc.
