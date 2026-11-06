# CODEMAP — topología del código

> **Normativo.** Si agregás, borrás o renombrás un archivo o un export, este archivo se actualiza en el
> MISMO commit: `tests/docs/docs-consistency.test.ts` (D2/D3) falla si no.
>
> **Qué NO responde acá**: qué devuelve un endpoint (`openapi.json` + `docs/api.md`), por qué una
> regla de negocio es así (`DECISIONS.md`), columnas e índices (`docs/database.md`), cómo levantar el
> entorno y qué comandos usar (`AGENTS.md`), qué está deprecado (`docs/legacy.md`).
> El doc de casos de uso y el de testing son P2 y todavía no existen: hasta entonces, el orden de
> pasos vive en el header de cada caso de uso y lo de tests en `jest.config.js`.

Columnas: **responsabilidad** en una línea · **exports** = superficie pública · **llamado por** =
importadores directos · **test** = suite que lo ejerce.

## 1. Flujo en una línea

```
index.ts ──► http/server.ts (composition root: los 4 repos Prisma + Yahoo UC-2 + los 5 routers)
                │
                ├─► http/<slice>/<slice>-router.ts ──► application/<uc>/*.ts ──► domain/* (puro)
                │            │                                                     │
                │            └──────────► domain/ports (interfaces) ◄──────────────┘
                │                                        ▲
                └─► infra/prisma/* (implementa los ports) ┘ ──► PostgreSQL
                             contracts/* (tipos + Zod) usado por TODAS las capas
```

## 2. Regla de dependencias

Permitido (flecha = puede importar): `http → application → domain`, `http → contracts`,
`application → contracts + domain + ports`, `domain → contracts`, `infra → contracts + ports + lib`,
`lib → prisma`. Prohibido: `contracts → cualquier capa`, `domain → infra | http`,
`application → infra | http`, importar `http/server.ts` salvo desde `index.ts`, e importar
`@prisma/client` fuera de `src/infra/**` y `src/lib/**`.

Verificación de la última regla:

```bash
grep -rn "@prisma" src | grep -v "src/infra\|src/lib"   # debe salir vacío
```

## 3. contracts — el vocabulario y el borde

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/contracts/datetime.ts` | timestamps sin zona → ISO 8601 sin offset, desde componentes locales (nunca `toISOString`) | `serializeLocalTimestamp` | `http/shared/edge` | funcionales |
| `src/contracts/domain.ts` | vocabulario compartido: movimientos, órdenes, snapshots, `TransactionContext` opaco, drafts y resultados; uniones discriminadas por `side` (acciones INT4 vs monto ARS exacto) y cantidades agregadas bigint | `TransactionContext`, `TradingSettledOrderMovement`, `CashSettledOrderMovement`, `SettledOrderMovement`, `RestingOrder`, `MarketdataSnapshot`, `Reservations`, `PositionPnl`, `TradingOrderRecord`, `CashOrderRecord`, `OrderRecord`, `TradingOrderDraft`, `CashOrderDraft`, `OrderDraft`, `OrderEventMetadata`, `OrderEventDraft`, `OrderEventRecord`, `CreateOrderResult`, `InstrumentRecord` | `domain` · `ports` · `application` · `infra/mappers` | `unit/financial-domain-contracts` |
| `src/contracts/enums.ts` | literales compartidos entre dominio, HTTP y DB — sin `EXPIRED` ni `DAY` (fuera de alcance) | `OrderSideSchema`, `OrderSide`, `TradingSideSchema`, `TradingSide`, `TransferSideSchema`, `TransferSide`, `OrderTypeSchema`, `OrderType`, `OrderStatusSchema`, `OrderStatus`, `TimeInForceSchema`, `TimeInForce`, `InstrumentTypeSchema`, `InstrumentType`, `OrderEventTypeSchema`, `OrderEventType`, `OrderRejectionReasonSchema`, `OrderRejectionReason` | todos los slices + `tests/helpers/factories.ts` | `unit` + factories |
| `src/contracts/errors.ts` | forma única del error HTTP `{error:{code,message}}` + códigos: 7 de negocio (responden los routers) + 1 de indisponibilidad del proveedor de cotizaciones (503 `MARKET_DATA_SERVICE_UNAVAILABLE`, spec instruments-current-quotes Rev. 2) + 1 de contención/saturación de la base (503 `DATABASE_UNAVAILABLE`, defecto D-03: `statement_timeout`/57014, P2028, P2024, ETIMEDOUT — lo responde el manejador central con `Retry-After`) + 4 transversales (NOT_FOUND, INVALID_JSON, PAYLOAD_TOO_LARGE, INTERNAL_ERROR — el manejador central); `MarketDataServiceUnavailableError` es el error de dominio que el borde traduce a ese 503 | `ApiErrorBodySchema`, `ApiErrorBody`, `API_ERROR_CODES`, `ApiErrorCode`, `apiErrorBody`, `MarketDataServiceUnavailableError` | routers · application · `http/error-handler` | funcionales |
| `src/contracts/financial-decimal.ts` | constructor Decimal financiero aislado: `clone` con precisión 64 y ROUND_HALF_UP, sin mutar el `Decimal` global (sigue 20) | `FinancialDecimal` (valor constructor + tipo instancia) | `contracts/money` · dominio · infra · `scripts/openapi` | `unit/large-money-arithmetic` |
| `src/contracts/index.ts` | barrel: única puerta de import de contratos | (barrel) | el resto de `src/` (contar: `grep -rln "contracts/index.js" src \| wc -l`) | — |
| `src/contracts/instruments.ts` | contrato de UC-2: `query` opcional (ausente/vacía/sólo espacios ⇒ `""` = listado inicial, con texto recortado), límite entero 1..100 con default 10; resultado con cotización actual obligatoria (sin null: el caso de uso omite los tickers sin cotización), `price`/`previousClose` como string monetario de 2 decimales y `dailyVariationPct` number | `DEFAULT_INSTRUMENT_SEARCH_LIMIT`, `MAX_INSTRUMENT_SEARCH_LIMIT`, `InstrumentSearchQuerySchema`, `InstrumentSearchQuery`, `InstrumentSearchResultSchema`, `InstrumentSearchResult`, `InstrumentSearchResponseSchema`, `InstrumentSearchResponse` | `http/instruments` | `unit/contracts-instruments` · `functional/read` |
| `src/contracts/money.ts` | dinero: entrada string decimal canónico (≤2 decimales, sin exponente/signo +/ceros iniciales) transformado a `FinancialDecimal`; schemas wire reutilizables por OpenAPI; máximo NUMERIC(24,2) definido una sola vez; salida string con exactamente 2 decimales (`.toFixed(2)`, sin pasar por number; agregados pueden superar la cota de columna); los serializadores aceptan SÓLO `FinancialDecimal` (nunca el `Decimal` global) y la salida es `string`/`number` plana: sin marcas nominales, porque `z.infer` las borraba (Q2=B) | `MoneyArsSchema`, `PctSchema`, `MAX_STORED_ARSS`, `ArsWireSchema`, `PositiveArsWireSchema`, `ArsInputSchema`, `PositiveArsInputSchema`, `serializeMoneyArs`, `serializePct` | routers · contracts · dominio · `scripts/openapi` | `unit/money-*` · funcionales |
| `src/contracts/orders.ts` | contrato de UC-3 y UC-4: XOR `instrumentId`\|`ticker`, XOR `size`\|`amountArs`, `size` de entrada de trading ≤ `MAX_ORDER_SIZE_SHARES` (cota INT4; el cash no pasa por acá), `price` acepta `null` en MARKET, `Idempotency-Key`, `OrderResponse` con `size` discriminado por side (number en trading, string monetario en cash) | `IDEMPOTENCY_KEY_HEADER`, `IdempotencyKeySchema`, `IdempotencyKey`, `MAX_INT4`, `MAX_ORDER_SIZE_SHARES`, `PositiveIntParamSchema`, `PositiveIntParam`, `CreateOrderParamsSchema`, `CreateOrderParams`, `CancelOrderParamsSchema`, `CancelOrderParams`, `CreateOrderRequestSchema`, `CreateOrderRequest`, `OrderResponseSchema`, `OrderResponse` | `http/orders` · `http/cancel` · `http/shared/edge` · `application` | `unit/contracts-orders` · `unit/financial-domain-contracts` · `functional/orders` (ambas) |
| `src/contracts/portfolio.ts` | contrato de UC-1: params y `PortfolioResponse` (cash, reservedCash, `totalAccountValue` = disponible + reservado + Σ marketValue con precio, positions); `quantity` viaja como string entero canónico (bigint interno); la posición es `strictObject` (un campo extra rompe el contrato y OpenAPI emite `additionalProperties: false`) | `PortfolioParamsSchema`, `serializeQuantityShares`, `PortfolioPositionSchema`, `PortfolioResponseSchema`, `PortfolioResponse` | `http/portfolio` | `functional/read` · `unit/financial-domain-contracts` |
| `src/contracts/request-fingerprint.ts` | huella canónica del REQUEST de orden (F2-IDEM, Q1=A): sha256 truncado sobre campos ordenados (instrumento RESUELTO · side · type · timeInForce · dinero a 2 decimales · `amountArs` original · `size` explícito). Vive en `contracts/` porque la calcula el borde y la consume la aplicación: si viviera en `http/` violaría la regla de dependencias. El monto original entra en la huella y nunca el `size` derivado por `floor`, que es lo que convierte el REPLAY espurio en 409 | `requestFingerprintOf`, `CashRequestFingerprintInput`, `cashRequestFingerprintOf` | `http/orders/orders-router` · `application/orders/submit-order.ts` · `integration/infra/order-repository.idempotency` | `unit/request-fingerprint` |
| `src/contracts/transfers.ts` | contrato de UC-5: monto positivo y `side` CASH_IN\|CASH_OUT | `CreateTransferParamsSchema`, `CreateTransferParams`, `CreateTransferRequestSchema`, `CreateTransferRequest` | `http/transfers` | `functional/transfers` |

## 4. domain — funciones puras (sin I/O, sin reloj)

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/domain/index.ts` | barrel del dominio puro | (barrel) | `application` · `http/portfolio` | — |
| `src/domain/matching/index.ts` | evaluación pura del cruce (`evaluateCross`) y `matchRestingOrders` como punto de enchufe SIN disparador | `PriceSource`, `EvaluateCrossInput`, `CrossDecision`, `isUsableReferencePrice`, `evaluateCross`, `RestingOrderFill`, `matchRestingOrders` | `domain/index.ts` (barrel) · `application/orders/decide-order.ts` (`evaluateCross`, IOC/FOK) · `infra/marketdata-price-source.ts` (sólo el tipo `PriceSource`: implementa el port, **no** llama `evaluateCross`) | `unit/domain/matching` |
| `src/domain/portfolio/index.ts` | derivaciones puras: cash exacto, reservas bigint, costo promedio ponderado, posiciones, P&L y patrimonio (`deriveTotalAccountValue`) — agregados pueden superar el máximo de una fila | `deriveCash`, `deriveReservations`, `weightedAverageCost`, `derivePositions`, `deriveTotalAccountValue` | `domain/index.ts` | `unit/domain/portfolio*` |
| `src/domain/sizing/index.ts` | `size = floor(amountArs / precio)` en Decimal — nunca compromete más que el monto; rango INT4 validado antes de `number` | `sizeSharesFromAmountArs` | `domain/index.ts` | `unit/domain/sizing` |

## 5. domain/ports — las interfaces (DIP)

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/domain/ports/index.ts` | las 4 interfaces de repositorio que la aplicación consume y la infra implementa (DIP) + la fuente de cotizaciones inyectable de UC-2 (`InstrumentQuoteSource`, dinero `FinancialDecimal`); `InstrumentRepository.searchByQuery` acepta `offset` opcional (iteración interna del catálogo, NO paginación HTTP) | `OrderRepository`, `PortfolioReadRepository`, `InstrumentRepository`, `MarketdataRepository`, `InstrumentQuote`, `InstrumentQuoteSource` | `application` · routers · `infra` | `integration/infra` · `unit/instrument-search-ports` |

## 6. application — casos de uso (orquestan tx + repos + dominio)

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/application/cancel/cancel-order.ts` | UC-4: cancelar una orden `NEW` — 404 si no existe, 422 si ya no es NEW, evento CANCELLED en la misma tx | `CancelOrderError`, `CancelOrderDeps`, `CancelOrderInput`, `CancelOrderResult`, `cancelOrder` | `http/cancel/cancel-router.ts` | `functional/cancel` |
| `src/application/instruments/search-instruments.ts` | UC-2 como caso de uso: `searchByQuery` pagina por offset interno (páginas del cupo restante) y la cotización se pide con **presupuesto acotado** (deadline único del request + paralelismo con límite, `QuoteBudget` inyectable con defaults `DEFAULT_QUOTE_DEADLINE_MS` / `DEFAULT_QUOTE_CONCURRENCY`, sin cache); al vencer el deadline se propaga `MarketDataServiceUnavailableError`, nunca una lista parcial; ticker sin cotización se omite y el cupo se completa con los siguientes candidatos (sin fallback al seed); el orden del catálogo se preserva indexando por posición; variación diaria en `FinancialDecimal` (64 cifras); devuelve vistas de dominio y el borde serializa | `SearchInstrumentsDeps`, `InstrumentSearchView`, `SearchInstrumentsInput`, `QuoteBudget`, `DEFAULT_QUOTE_DEADLINE_MS`, `QUOTE_CALL_ALLOWANCE_MS`, `MAX_QUOTE_DEADLINE_MS`, `DEFAULT_QUOTE_CONCURRENCY`, `CANDIDATE_SCAN_FACTOR`, `MIN_CANDIDATE_SCAN`, `quoteDeadlineMsFor`, `CancellableQuoteSource`, `searchInstruments` | `http/instruments/instruments-router.ts` | `unit/application/search-instruments` · `unit/application/search-instruments-budget` · `unit/http/instruments-search` |
| `src/application/orders/submit-order.ts` | UC-3: envío completo — resuelve instrumento, precio y fondos dentro de la tx y delega: decisiones puras en `decide-order.ts`, persistencia (claim idempotente + evento) en `persist-order-decision.ts`; un size derivado fuera de INT4 es 400 `VALIDATION_ERROR` sin escritura | `SubmitOrderErrorCode`, `SubmitOrderError`, `SubmitOrderDeps`, `SubmitOrderInput`, `SubmitOrderResult`, `submitOrder` | `http/orders/orders-router.ts` | `unit/application/submit-order.*` · `functional/orders` · `functional/orders-submit` |
| `src/application/orders/decide-order.ts` | decisiones PURAS del envío (UC-3, trading) y del cash (UC-5): estado, size o monto exacto, precio de fill, evento y metadata — sin ports, sin `await`, sin reloj (el instante se recibe); posición agregada en bigint | `DecidedOrder`, `DecidedCashOrder`, `SizingDecision`, `needsReferencePrice`, `limitPriceOf`, `rejectForMissingPrice`, `resolveSizing`, `buildAuditBase`, `rejectForZeroSize`, `positionSharesFor`, `FundsAssessmentInput`, `assessFunds`, `AcceptedOrderInput`, `decideLimitOrder`, `decideMarketFill`, `decideAcceptedOrder` | `submit-order.ts` · `submit-transfer.ts` | `unit/application/decide-order` |
| `src/application/orders/persist-order-decision.ts` | persistencia de UNA decisión (UC-3 y UC-5): `createOrder` como PRIMERA escritura (claim `ON CONFLICT`), evento en la misma tx; replay sin evento y 409 (`IdempotencyConflictError`); draft base discriminado por unidad (acciones vs monto) | `IdempotencyConflictError`, `TradingOrderDraftBase`, `CashOrderDraftBase`, `PersistedOrderDecisionInput`, `PersistedOrderDecision`, `persistOrderDecision` | `submit-order.ts` · `submit-transfer.ts` · `orders-router` · `transfers-router` | `unit/application/persist-order-decision` · `unit/application/submit-*.characterization` |
| `src/application/portfolio/get-portfolio.ts` | UC-1 como caso de uso: 404 por `userExists`, derivación con el dominio puro (cash exacto, `quantityShares` bigint) y UN batch de snapshots + UN batch de instrumentos (`findByIds`, sin N+1); devuelve valores de dominio, el borde serializa | `GetPortfolioDeps`, `PortfolioPositionView`, `PortfolioState`, `GetPortfolioResult`, `getPortfolio` | `http/portfolio/portfolio-router.ts` | `unit/application/get-portfolio` |
| `src/application/transfers/submit-transfer.ts` | UC-5: CASH_IN/CASH_OUT como orders del instrumento ARS (`price` 1.00, `amountArs` = monto exacto con centavos, sin floor — D4); la decisión y la persistencia son las de las órdenes (`decide-order.ts` · `persist-order-decision.ts`) | `SubmitTransferError`, `SubmitTransferDeps`, `SubmitTransferInput`, `SubmitTransferResult`, `submitTransfer` | `http/transfers/transfers-router.ts` | `unit/application/submit-transfer.characterization` · `functional/transfers` |

## 7. http — borde y composición

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/http/app.ts` | `buildApp(routers)` — monta routers bajo `/api`, fija el límite del body JSON (`JSON_BODY_LIMIT_KB`) y agrega en orden: routers → 404 (`notFoundHandler`) → errores (`errorHandler`) | `buildApp` | `http/server.ts` | `unit/http/error-contract` |
| `src/http/cancel/cancel-router.ts` | borde UC-4: Zod params → `cancelOrder` → 200 `OrderResponse` | `CancelRouterDeps`, `buildCancelRouter` | `http/server.ts` | `functional/cancel` |
| `src/http/error-handler.ts` | los errores que no tienen handler de dominio: 404 de ruta o método inexistente, body JSON inválido (400), body demasiado grande (413), **contención/saturación de PostgreSQL** (503 `DATABASE_UNAVAILABLE` con `Retry-After`: 57014, P2028, P2024, ETIMEDOUT y el timeout de pg-pool sin `code` — defecto D-03) y 500 con mensaje genérico para el resto — el detalle (stack) queda en stderr | `JSON_BODY_LIMIT_KB`, `notFoundHandler`, `errorHandler` | `http/app.ts` | `unit/http/error-contract` · `unit/http/error-mapping` |
| `src/http/health.ts` | probes de ciclo de vida: `GET /health` (liveness, 200 siempre, **no toca la DB**) y `GET /health/ready` (200 `up` / 503 `down` según un `SELECT 1` inyectado). Se monta FUERA de `/api` porque el `notFoundHandler` de `buildApp` es terminal | `HealthRouterDeps`, `buildHealthRouter` | `http/server.ts` | `unit/http/health` |
| `src/http/shared/edge.ts` | borde HTTP compartido por los routers: `validationMessage` (ZodError → texto), lectura del header `Idempotency-Key` (opcional; dos headers con el mismo nombre ⇒ 400 por `rawHeaders`, defecto D-04) y fila persistida → `OrderResponse` con `size` discriminado (acciones number, cash string monetario); `parseWriteRequest` (Zod de params/body/header, sin Express: recibe un `WriteRequestSource` mínimo) y `toHttpError` (error de dominio → status/código, `null` si no es de dominio) centralizan el parseo y el mapeo de errores de los 3 routers de escritura; `isTemporaryContentionError` clasifica la contención de PostgreSQL (57014, P2028, P2024, ETIMEDOUT y el timeout de pg-pool, también anidados en `meta`/`cause`) y `databaseUnavailableError` arma el 503 `DATABASE_UNAVAILABLE` + `Retry-After` que emite `http/error-handler` (defecto D-03) | `validationMessage`, `IdempotencyKeyHeaderRejection`, `IdempotencyKeyHeader`, `IdempotencyKeyHeaderSource`, `parseIdempotencyKeyHeader`, `WriteRequestSource`, `WriteRequestSchemas`, `ParsedWriteRequest`, `parseWriteRequest`, `HttpError`, `RETRY_AFTER_HEADER`, `RETRY_AFTER_SECONDS`, `isTemporaryContentionError`, `databaseUnavailableError`, `toHttpError`, `toOrderResponse` | los 5 routers · `http/error-handler` | `unit/http/edge` · `unit/http/idempotency-header` · `unit/http/error-mapping` |
| `src/http/instruments/instruments-router.ts` | borde UC-2: Zod query → `searchInstruments` → serialización (money string 2dp, pct number); `MarketDataServiceUnavailableError` ⇒ 503 `MARKET_DATA_SERVICE_UNAVAILABLE` exacto, cualquier otro error al error handler | `InstrumentsRouterDeps`, `buildInstrumentsRouter` | `http/server.ts` | `unit/http/instruments-search` · `functional/read` |
| `src/http/orders/orders-router.ts` | borde UC-3: Zod params+body+header → `submitOrder` → 201 `OrderResponse` | `OrdersRouterDeps`, `buildOrdersRouter` | `http/server.ts` | `functional/orders` (ambas) |
| `src/http/portfolio/portfolio-router.ts` | borde UC-1 como adaptador fino: Zod params → `getPortfolio` → serialización al contrato (la agregación vive en el caso de uso) | `PortfolioRouterDeps`, `buildPortfolioRouter` | `http/server.ts` | `functional/read` · `unit/http/error-contract` |
| `src/http/server.ts` | composition root: `createServerApp(deps)` arma la app con los ports inyectados y `serverApp` es la instancia por defecto; los repos y la fuente Yahoo se resuelven **perezoso** (importar la composición no exige `DATABASE_URL` ni crea el cliente Prisma) y el router de health se monta fuera de `/api` | `ServerAppDeps`, `createServerApp`, `serverApp` | `src/index.ts` | — |
| `src/http/transfers/transfers-router.ts` | borde UC-5: Zod params+body+header → `submitTransfer` → 201 `OrderResponse` | `TransfersRouterDeps`, `buildTransfersRouter` | `http/server.ts` | `functional/transfers` |
| `src/index.ts` | entry: `dotenv/config` + `listen(PORT)` + cierre ordenado (SIGTERM/SIGINT) que desconecta el pool de Prisma | (entry) | — | — |

## 8. infra + lib — Prisma, transacciones, mappers

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/infra/prisma/cash-idempotency.ts` | replay vs conflicto de un cash con la MISMA key ya reclamada: igualdad Decimal exacta para filas nuevas; para filas históricas exige evidencia estricta del evento de ORIGEN (`metadata.amountArs` string canónico, precio unitario 1.00 y `size == floor(amount)`). Sin evidencia suficiente ⇒ CONFLICT (conservador) | `CashIdempotencyOutcome`, `cashIdempotencyOutcome` | `order-repository.ts` | `integration/infra/order-repository.idempotency` |
| `src/infra/prisma/corrupt-row.error.ts` | fallo ruidoso ante NULL donde el contrato exige valor (nunca normaliza en silencio) | `CorruptRowError` | `mappers.ts` · `order-repository.ts` · `cash-idempotency.ts` | `integration/infra` · `unit/infra` |
| `src/infra/prisma/instrument-repository.ts` | catálogo: `findById`/`findByIds` (pueden devolver MONEDA; el batch con UNA consulta IN), `findByTicker` y `searchByQuery` (la excluye; `skip` = offset interno del catálogo, default 0) | `PrismaInstrumentRepository` | `http/server.ts` | `integration/infra` · `unit/instrument-search-ports` · funcionales |
| `src/infra/prisma/mappers.ts` | fila PG ↔ record de contracts; `size` discriminado por side (acciones INT4 como number, cash como `FinancialDecimal` exacto), precio FILLED `filledPrice ?? price`, `Decimal` por string; NULL/unidad incompatibles = `CorruptRowError` | `decimalFromDb`, `decimalToDbParam`, `mapOrderRow`, `mapSettledMovementRow`, `mapRestingOrderRow`, `mapOrderEventRow`, `metadataToDbParam`, `mapInstrumentRow`, `MarketdataRawRow`, `mapMarketdataRawRow` | los 4 repos | `integration/infra` · `unit/infra` |
| `src/infra/prisma/marketdata-price-source.ts` | `PriceSource` de matching: close de la última vela — **sin cablear** al flujo de producción | `MarketdataPriceSource` | nadie (sólo tests) | `integration/infra/marketdata` |
| `src/infra/prisma/marketdata-repository.ts` | último snapshot por `date`: UNA query raw con `DISTINCT ON`, individual y en batch | `PrismaMarketdataRepository` | `http/server.ts` | `integration/infra` · funcionales |
| `src/infra/prisma/order-repository.ts` | escrituras de orders: tx + advisory lock, claim `ON CONFLICT` (persiste `requestFingerprint` y, con huella en ambos lados, decide REPLAY vs CONFLICT por huella; sin huella cae al `size`/cash histórico), eventos, guardas de estado y replay exacto (trading/cash; histórico vía `cash-idempotency.ts`) | `PrismaOrderRepository` | `http/server.ts` | `integration/infra` · funcionales |
| `src/infra/prisma/portfolio-read-repository.ts` | lecturas del portfolio (`userExists`, movimientos FILLED, NEW) con `tx` opcional | `PrismaPortfolioReadRepository` | `http/server.ts` | `integration/infra` · funcionales |
| `src/infra/prisma/request-comparison.ts` | comparación PURA (sin Prisma ni I/O) de una orden ya reclamada contra el request entrante: identidad instrumento/side/type/timeInForce/price por valor Decimal, huella del request cuando está en AMBOS lados y fallback histórico por `size`; expone tipos estructurales propios para ejercitarla en unit con filas construidas a mano (los casos legacy que antes exigían insertar filas no conformes) | `OrderRequestRow`, `RequestPayload`, `TradingRequestOutcome`, `sameIdentityPayload`, `sameTradingRequest`, `classifyTradingRequest` | `order-repository.ts` | `unit/infra/request-comparison` |
| `src/infra/prisma/transaction-context.ts` | brand/unbrand del `TransactionContext` + `resolveDbExecutor` (tx o cliente raíz) | `DbExecutor`, `brandTransactionContext`, `unbrandTransactionContext`, `resolveDbExecutor` | `order-repository.ts` · `portfolio-read-repository.ts` | `integration/infra` |
| `src/infra/yahoo/yahoo-instrument-quote-source.ts` | adaptador Yahoo de UC-2: GET chart 1d/1m con `ticker + ".BA"` (encodeURIComponent), timeout default 5 s vía AbortController, respuesta validada con Zod — meta ARS + símbolo esperado + `regularMarketPrice`/`previousClose` finitos y positivos convertidos a `FinancialDecimal` desde string; 404/meta ausente/moneda o símbolo distintos/no positivos ⇒ `null` (faltante), 429/5xx/transporte/timeout/JSON inválido o forma inesperada ⇒ `MarketDataServiceUnavailableError`; sin caché, retries ni fallback histórico | `YahooInstrumentQuoteSource`, `YAHOO_USER_AGENT` | `http/server.ts` (sólo UC-2: `buildInstrumentsRouter`) | `unit/infra/yahoo-instrument-quote-source` |
| `src/lib/runtime-config.ts` | configuración de arranque validada UNA vez (fail-fast): `PORT` entero 1..65535, `HOST` no vacío (default `127.0.0.1`) y `DATABASE_URL` con esquema `postgres(ql)://`; un valor inválido sale con mensaje accionable y exit 1, nunca con un `RangeError` opaco de `listen` | `DEFAULT_HOST`, `DEFAULT_PORT`, `RuntimeConfig`, `RuntimeConfigError`, `loadRuntimeConfig` | `src/index.ts` | `unit/http/health` |
| `src/lib/prisma-client.ts` | singleton LAZY de `PrismaClient` con driver adapter (`DATABASE_URL` al primer uso), pool dimensionado (`max`, `connectionTimeoutMillis`, `statement_timeout`) y `disconnectPrismaClient` para el cierre ordenado | `getPrismaClient`, `disconnectPrismaClient` | los 4 repos · `transaction-context.ts` · `src/index.ts` | `integration/infra` · funcionales |

## 9. Firmas del dominio (lo que no hace falta abrir)

| función | firma | invariante |
|---|---|---|
| `deriveCash` | `(movements: readonly SettledOrderMovement[]) => FinancialDecimal` | sólo FILLED; CASH_IN/SELL suman su monto exacto, CASH_OUT/BUY restan; el agregado puede superar el máximo de fila |
| `deriveReservations` | `(resting: readonly RestingOrder[]) => Reservations` | BUY reserva `price × size` en Decimal; SELL acumula `size` en bigint por instrumento |
| `weightedAverageCost` | `(movements) => FinancialDecimal` | las ventas no tocan el promedio; 0 si no hay compras |
| `derivePositions` | `(movements, snapshots) => readonly PositionPnl[]` | cantidad bigint 0 no se lista; cash ignorado antes del narrowing; sin precio ⇒ `marketValueArs: null` |
| `deriveTotalAccountValue` | `(cashSettledArs: FinancialDecimal, positions: readonly PositionPnl[]) => FinancialDecimal` | cash liquidado + Σ marketValue de las posiciones CON precio; las negativas restan |
| `evaluateCross` | `(input: EvaluateCrossInput) => CrossDecision` | BUY llena a `min(límite, ref)`, SELL a `max(límite, ref)`; IOC/FOK todo-o-nada |
| `matchRestingOrders` | `(refPrice, orders) => readonly RestingOrderFill[]` | **sin disparador en producción** (punto de enchufe) |
| `sizeSharesFromAmountArs` | `(amountArs: FinancialDecimal, priceArs: FinancialDecimal) => number` | `floor` en Decimal; valida entero 0..`MAX_ORDER_SIZE_SHARES` antes de `toNumber` y lanza `RangeError` fuera de rango |
| `serializeMoneyArs` | `(value: Decimal) => MoneyArs` | cuantiza a 2 decimales EN `Decimal` antes de serializar |

## 10. Trampas (caras de redescubrir)

1. **`TransactionContext` es opaco con brand.** Sólo `withUserTransaction` lo construye; el cast real
   vive en `src/infra/prisma/transaction-context.ts` (`brand`/`unbrand`). Nadie fuera de infra lo fabrica.
2. **`tx` es opcional en `PortfolioReadRepository`.** En envío/cancelación/transferencia se pasa el
   MISMO tx (la validación de fondos debe ver lo recién escrito); en lecturas HTTP va `undefined` y el
   repo usa el cliente raíz (`resolveDbExecutor`).
3. **El singleton de Prisma es lazy** (`getPrismaClient()`): se instancia al primer uso para que
   `dotenv` pueda setear `DATABASE_URL` antes (los imports ESM corren antes del cuerpo del módulo).
   Por eso cada `support.ts` fija `process.env.DATABASE_URL` ANTES de importar la app.
4. **`createOrder` usa `$executeRaw` con `ON CONFLICT DO NOTHING`** y decide por el count (1 = insertó,
   0 = conflicto). Cualquier otro count = `CorruptRowError`. No reemplazar por `create()` + catch P2002.
5. **`markFilled`/`markCancelled` son `updateMany` con `WHERE status='NEW'`**: el count ES la transición
   atómica; 0 ⇒ `null` ⇒ 422, sin mutar y sin evento.
6. **`marketdata` usa una query raw con `DISTINCT ON`** y `to_char(date,'YYYY-MM-DD')`: la fecha viaja
   como texto para no pasar por `Date`/zona horaria. El batch evita N+1.
7. **Los mappers fallan ruidosamente.** Un NULL donde el contrato exige valor es `CorruptRowError`,
   nunca un default silencioso. Si un test nuevo rompe con `CorruptRowError`, sospechar de una fila del
   seed o de una lectura de movimientos tras un fill creado por la API.
8. **`db/schema.sql` es un snapshot generado y viejo**; el DDL real es `prisma/migrations/**`.
   Nunca cargar la DB de desarrollo desde `db/schema.sql`.

## 11. Mapa de tests (una suite por caso de uso; transversal al final)

| suite | cubre | DB |
|---|---|---|
| `tests/unit/domain/**` | dominio puro: cash, reservas, costo/retorno de posición (`portfolio-position-cost`), patrimonio (`portfolio-total-account-value`), matching, sizing | ninguna |
| `tests/unit/application/*` | decisiones y persistencia de órdenes (puras), caso de uso del portfolio y búsqueda de UC-2 (con fakes de la quote source) | ninguna |
| `tests/unit/http/*` | borde compartido (`edge`), contrato de errores transversales (404/400/413/500 con `buildApp`) y borde de UC-2 (503 `MARKET_DATA_SERVICE_UNAVAILABLE`) | ninguna |
| `tests/unit/contracts-orders.test.ts` · `tests/unit/contracts-instruments.test.ts` · `tests/unit/instrument-search-ports.test.ts` · `tests/unit/money-input.test.ts` · `tests/unit/money-serialization.test.ts` · `tests/unit/financial-domain-contracts.test.ts` · `tests/unit/large-money-arithmetic.test.ts` | schemas Zod del contrato (órdenes, instrumentos, dinero, contratos de dominio), el port de búsqueda y la aritmética de 64 cifras | ninguna |
| `tests/unit/infra/*` | mappers (`filledPrice`) y adaptador Yahoo de UC-2 con respuestas stubbeadas | ninguna |
| `tests/unit/test-database-url.test.ts` | derivación de la URL de test por nombre de suite (aislamiento entre suites) | ninguna |
| `tests/integration/infra/*` | 4 repos Prisma + idempotencia + tx + mappers + storage de grandes montos | `cocos_challenge_test` |
| `tests/functional/read` | UC-1 y UC-2 end-to-end | `cocos_challenge_read` |
| `tests/functional/orders` | matriz completa UC-3 (13 casos) contra `serverApp` | `cocos_challenge_ftest` |
| `tests/functional/orders-submit` | cableo application+router+repos de UC-3 | `cocos_challenge_submit` |
| `tests/functional/cancel` | UC-4 | `cocos_challenge_cancel` |
| `tests/functional/transfers` | UC-5 | `cocos_challenge_transfer` |
| `tests/functional/large-money` | **aceptación de grandes montos** (D1–D5): máximo por fila, centavos, overflow/scale sin escritura, replay histórico, concurrencia y rollback de auditoría, contra Express + PostgreSQL reales | `lm_acceptance_test` |
| `tests/db.smoke.test.ts` · `tests/deps.smoke.test.ts` | toolchain (pg, ts-jest, imports) | `cocos_challenge_test` |
| `tests/build.esm.smoke.test.ts` | artefacto `dist/` importado por Node como ESM real (sin DB ni puerto) | ninguna |
| `tests/docs/**` | guardias normativas doc↔código y contrato OpenAPI (detalle en §12) | ninguna |

## 12. Herramientas de documentación (fuera de `src/`)

| archivo | responsabilidad |
|---|---|
| `scripts/openapi/wire.ts` | bodies de entrada de las operaciones, REUTILIZANDO los schemas wire de `src/contracts/money.ts` (sin espejo monetario propio: una sola gramática y máximo) |
| `scripts/openapi/registry.ts` | las 5 operaciones: método, ruta Express, schemas, status, códigos, ejemplos |
| `scripts/openapi/build.ts` | arma el documento OpenAPI 3.1 con `z.toJSONSchema` |
| `scripts/generate-openapi.ts` | `npm run openapi` → escribe `openapi.json` |
| `tests/docs/docs-consistency.test.ts` | D1–D4: paths citados, archivos de `src/`, exports y códigos/rutas de api.md en este mapa |
| `tests/docs/openapi.test.ts` | sincronización json↔generador, rutas↔routers, códigos del contrato por operación, bodies del contrato y frontera del wire monetario (D7–D11) |

## 13. Deuda conocida (no "arreglar" sin spec)

- `marketdata-price-source.ts` implementa `PriceSource` y **nadie lo cablea** (punto de enchufe del matching).
- La migración no tiene `CHECK` de transiciones de estado: la guarda es a nivel app.

