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
index.ts ──► http/server.ts (composition root: los 4 repos Prisma + los 5 routers)
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
| `src/contracts/errors.ts` | forma única del error HTTP `{error:{code,message}}` + códigos: 7 de negocio (responden los routers) + 4 transversales (NOT_FOUND, INVALID_JSON, PAYLOAD_TOO_LARGE, INTERNAL_ERROR — el manejador central) | `ApiErrorBodySchema`, `ApiErrorBody`, `API_ERROR_CODES`, `ApiErrorCode`, `apiErrorBody` | routers · application · `http/error-handler` | funcionales |
| `src/contracts/financial-decimal.ts` | constructor Decimal financiero aislado: `clone` con precisión 64 y ROUND_HALF_UP, sin mutar el `Decimal` global (sigue 20) | `FinancialDecimal` (valor constructor + tipo instancia) | `contracts/money` · dominio · infra · `scripts/openapi` | `unit/large-money-arithmetic` |
| `src/contracts/index.ts` | barrel: única puerta de import de contratos | (barrel) | el resto de `src/` (contar: `grep -rln "contracts/index.js" src \| wc -l`) | — |
| `src/contracts/instruments.ts` | contrato de UC-2: `query` obligatoria, límite 1..100, resultado con precio y variación | `DEFAULT_INSTRUMENT_SEARCH_LIMIT`, `MAX_INSTRUMENT_SEARCH_LIMIT`, `InstrumentSearchQuerySchema`, `InstrumentSearchQuery`, `InstrumentSearchResultSchema`, `InstrumentSearchResult`, `InstrumentSearchResponseSchema`, `InstrumentSearchResponse` | `http/instruments` | `functional/read` |
| `src/contracts/money.ts` | dinero: entrada string decimal canónico (≤2 decimales, sin exponente/signo +/ceros iniciales) transformado a `FinancialDecimal`; schemas wire reutilizables por OpenAPI; máximo NUMERIC(24,2) definido una sola vez; salida string con exactamente 2 decimales (`.toFixed(2)`, sin pasar por number; agregados pueden superar la cota de columna) | `MoneyArs`, `Pct`, `MoneyArsSchema`, `PctSchema`, `MAX_STORED_ARSS`, `ArsWireSchema`, `PositiveArsWireSchema`, `ArsInputSchema`, `PositiveArsInputSchema`, `serializeMoneyArs`, `serializePct` | routers · contracts · dominio · `scripts/openapi` | `unit/money-*` · funcionales |
| `src/contracts/orders.ts` | contrato de UC-3 y UC-4: XOR `instrumentId`\|`ticker`, XOR `size`\|`amountArs`, `size` de entrada de trading ≤ `MAX_ORDER_SIZE_SHARES` (cota INT4; el cash no pasa por acá), `price` acepta `null` en MARKET, `Idempotency-Key`, `OrderResponse` con `size` discriminado por side (number en trading, string monetario en cash) | `IDEMPOTENCY_KEY_HEADER`, `IdempotencyKeySchema`, `IdempotencyKey`, `MAX_ORDER_SIZE_SHARES`, `CreateOrderParamsSchema`, `CreateOrderParams`, `CancelOrderParamsSchema`, `CancelOrderParams`, `CreateOrderRequestSchema`, `CreateOrderRequest`, `OrderResponseSchema`, `OrderResponse` | `http/orders` · `http/cancel` · `http/shared/edge` · `application` | `unit/contracts-orders` · `unit/financial-domain-contracts` · `functional/orders` (ambas) |
| `src/contracts/portfolio.ts` | contrato de UC-1: params y `PortfolioResponse` (cash, reservedCash, `totalAccountValue` = disponible + reservado + Σ marketValue con precio, positions); `quantity` viaja como string entero canónico (bigint interno) | `PortfolioParamsSchema`, `PortfolioParams`, `serializeQuantityShares`, `PortfolioPositionSchema`, `PortfolioPosition`, `PortfolioResponseSchema`, `PortfolioResponse` | `http/portfolio` | `functional/read` · `unit/financial-domain-contracts` |
| `src/contracts/transfers.ts` | contrato de UC-5: monto positivo y `side` CASH_IN\|CASH_OUT | `CreateTransferParamsSchema`, `CreateTransferParams`, `CreateTransferRequestSchema`, `CreateTransferRequest` | `http/transfers` | `functional/transfers` |

## 4. domain — funciones puras (sin I/O, sin reloj)

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/domain/index.ts` | barrel del dominio puro | (barrel) | `application` · `http/portfolio` | — |
| `src/domain/matching/index.ts` | evaluación pura del cruce (`evaluateCross`) y `matchRestingOrders` como punto de enchufe SIN disparador | `PriceSource`, `EvaluateCrossInput`, `CrossDecision`, `evaluateCross`, `RestingOrderFill`, `matchRestingOrders` | `domain/index.ts` · `infra/marketdata-price-source.ts` | `unit/domain/matching` |
| `src/domain/portfolio/index.ts` | derivaciones puras: cash exacto, reservas bigint, costo promedio ponderado, posiciones, P&L y patrimonio (`deriveTotalAccountValue`) — agregados pueden superar el máximo de una fila | `deriveCash`, `deriveReservations`, `weightedAverageCost`, `derivePositions`, `deriveTotalAccountValue` | `domain/index.ts` | `unit/domain/portfolio*` |
| `src/domain/sizing/index.ts` | `size = floor(amountArs / precio)` en Decimal — nunca compromete más que el monto; rango INT4 validado antes de `number` | `sizeSharesFromAmountArs` | `domain/index.ts` | `unit/domain/sizing` |

## 5. domain/ports — las interfaces (DIP)

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/domain/ports/index.ts` | las 4 interfaces que la aplicación consume y la infra implementa (DIP) | `OrderRepository`, `PortfolioReadRepository`, `InstrumentRepository`, `MarketdataRepository` | `application` · routers · `infra` | `integration/infra` |

## 6. application — casos de uso (orquestan tx + repos + dominio)

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/application/cancel/cancel-order.ts` | UC-4: cancelar una orden `NEW` — 404 si no existe, 422 si ya no es NEW, evento CANCELLED en la misma tx | `CancelOrderError`, `CancelOrderDeps`, `CancelOrderInput`, `CancelOrderResult`, `cancelOrder` | `http/cancel/cancel-router.ts` | `functional/cancel` |
| `src/application/orders/submit-order.ts` | UC-3: envío completo — resuelve instrumento, precio y fondos dentro de la tx y delega: decisiones puras en `decide-order.ts`, persistencia (claim idempotente + evento) en `persist-order-decision.ts` | `SubmitOrderErrorCode`, `SubmitOrderError`, `SubmitOrderDeps`, `SubmitOrderInput`, `SubmitOrderResult`, `submitOrder` | `http/orders/orders-router.ts` | `unit/application/submit-order.*` · `functional/orders` · `functional/orders-submit` |
| `src/application/orders/decide-order.ts` | decisiones PURAS del envío (UC-3 y UC-5): estado, size, precio de fill, evento y metadata — sin ports, sin `await`, sin reloj (el instante se recibe); probables con valores borde sin DB | `DecidedOrder`, `SizingDecision`, `needsReferencePrice`, `limitPriceOf`, `rejectForMissingPrice`, `resolveSizing`, `buildAuditBase`, `rejectForZeroSize`, `positionSharesFor`, `FundsAssessmentInput`, `assessFunds`, `AcceptedOrderInput`, `decideLimitOrder`, `decideMarketFill`, `decideAcceptedOrder` | `submit-order.ts` · `submit-transfer.ts` | `unit/application/decide-order` |
| `src/application/orders/persist-order-decision.ts` | persistencia de UNA decisión (UC-3 y UC-5): `createOrder` como PRIMERA escritura (claim `ON CONFLICT`), evento en la misma tx; replay sin evento y 409 (`IdempotencyConflictError`) | `IdempotencyConflictError`, `OrderDraftBase`, `PersistedOrderDecision`, `persistOrderDecision` | `submit-order.ts` · `submit-transfer.ts` · `orders-router` · `transfers-router` | `unit/application/persist-order-decision` · `unit/application/submit-*.characterization` |
| `src/application/portfolio/get-portfolio.ts` | UC-1 como caso de uso: 404 por `userExists`, derivación con el dominio puro y UN batch de snapshots + UN batch de instrumentos (`findByIds`, sin N+1); devuelve valores de dominio, el borde serializa | `GetPortfolioDeps`, `PortfolioPositionView`, `PortfolioState`, `GetPortfolioResult`, `getPortfolio` | `http/portfolio/portfolio-router.ts` | `unit/application/get-portfolio` |
| `src/application/transfers/submit-transfer.ts` | UC-5: CASH_IN/CASH_OUT como orders del instrumento ARS (`price` 1.00, `size` = pesos); la decisión y la persistencia son las de las órdenes (`decide-order.ts` · `persist-order-decision.ts`) | `SubmitTransferError`, `SubmitTransferDeps`, `SubmitTransferInput`, `SubmitTransferResult`, `submitTransfer` | `http/transfers/transfers-router.ts` | `unit/application/submit-transfer.characterization` · `functional/transfers` |

## 7. http — borde y composición

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/http/app.ts` | `buildApp(routers)` — monta routers bajo `/api`, fija el límite del body JSON (`JSON_BODY_LIMIT_KB`) y agrega en orden: routers → 404 (`notFoundHandler`) → errores (`errorHandler`) | `buildApp` | `http/server.ts` | `unit/http/error-contract` |
| `src/http/cancel/cancel-router.ts` | borde UC-4: Zod params → `cancelOrder` → 200 `OrderResponse` | `CancelRouterDeps`, `buildCancelRouter` | `http/server.ts` | `functional/cancel` |
| `src/http/error-handler.ts` | los errores que no tienen handler de dominio: 404 de ruta o método inexistente, body JSON inválido (400), body demasiado grande (413) y 500 con mensaje genérico — el detalle (stack) queda en stderr | `JSON_BODY_LIMIT_KB`, `notFoundHandler`, `errorHandler` | `http/app.ts` | `unit/http/error-contract` |
| `src/http/shared/edge.ts` | borde HTTP compartido por los routers: `validationMessage` (ZodError → texto), lectura del header `Idempotency-Key` y fila persistida → `OrderResponse` | `validationMessage`, `IdempotencyKeyHeader`, `parseIdempotencyKeyHeader`, `toOrderResponse` | los 5 routers | `unit/http/edge` |
| `src/http/instruments/instruments-router.ts` | borde UC-2: `query` → `searchByQuery` → batch de snapshots → respuesta | `InstrumentsRouterDeps`, `buildInstrumentsRouter` | `http/server.ts` | `functional/read` |
| `src/http/orders/orders-router.ts` | borde UC-3: Zod params+body+header → `submitOrder` → 201 `OrderResponse` | `OrdersRouterDeps`, `buildOrdersRouter` | `http/server.ts` | `functional/orders` (ambas) |
| `src/http/portfolio/portfolio-router.ts` | borde UC-1 como adaptador fino: Zod params → `getPortfolio` → serialización al contrato (la agregación vive en el caso de uso) | `PortfolioRouterDeps`, `buildPortfolioRouter` | `http/server.ts` | `functional/read` · `unit/http/error-contract` |
| `src/http/server.ts` | composition root: instancia los 4 repos Prisma y arma `serverApp` con los 5 routers | `serverApp` | `src/index.ts` | — |
| `src/http/transfers/transfers-router.ts` | borde UC-5: Zod params+body+header → `submitTransfer` → 201 `OrderResponse` | `TransfersRouterDeps`, `buildTransfersRouter` | `http/server.ts` | `functional/transfers` |
| `src/index.ts` | entry: `dotenv/config` + `listen(PORT)` + cierre ordenado (SIGTERM/SIGINT) que desconecta el pool de Prisma | (entry) | — | — |

## 8. infra + lib — Prisma, transacciones, mappers

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/infra/prisma/cash-idempotency.ts` | replay vs conflicto de un cash con la MISMA key ya reclamada: igualdad Decimal exacta para filas nuevas; para filas históricas exige evidencia estricta del evento de ORIGEN (`metadata.amountArs` string canónico, precio unitario 1.00 y `size == floor(amount)`). Sin evidencia suficiente ⇒ CONFLICT (conservador) | `CashIdempotencyOutcome`, `cashIdempotencyOutcome` | `order-repository.ts` | `integration/infra/order-repository.idempotency` |
| `src/infra/prisma/corrupt-row.error.ts` | fallo ruidoso ante NULL donde el contrato exige valor (nunca normaliza en silencio) | `CorruptRowError` | `mappers.ts` · `order-repository.ts` · `cash-idempotency.ts` | `integration/infra` · `unit/infra` |
| `src/infra/prisma/instrument-repository.ts` | catálogo: `findById`/`findByIds` (pueden devolver MONEDA; el batch con UNA consulta IN), `findByTicker` y `searchByQuery` (la excluye) | `PrismaInstrumentRepository` | `http/server.ts` | `integration/infra` · funcionales |
| `src/infra/prisma/mappers.ts` | fila PG ↔ record de contracts; `size` discriminado por side (acciones INT4 como number, cash como `FinancialDecimal` exacto), precio FILLED `filledPrice ?? price`, `Decimal` por string; NULL/unidad incompatibles = `CorruptRowError` | `decimalFromDb`, `decimalToDbParam`, `mapOrderRow`, `mapSettledMovementRow`, `mapRestingOrderRow`, `mapOrderEventRow`, `metadataToDbParam`, `mapInstrumentRow`, `MarketdataRawRow`, `mapMarketdataRawRow` | los 4 repos | `integration/infra` · `unit/infra` |
| `src/infra/prisma/marketdata-price-source.ts` | `PriceSource` de matching: close de la última vela — **sin cablear** al flujo de producción | `MarketdataPriceSource` | nadie (sólo tests) | `integration/infra/marketdata` |
| `src/infra/prisma/marketdata-repository.ts` | último snapshot por `date`: UNA query raw con `DISTINCT ON`, individual y en batch | `PrismaMarketdataRepository` | `http/server.ts` | `integration/infra` · funcionales |
| `src/infra/prisma/order-repository.ts` | escrituras de orders: tx + advisory lock, claim `ON CONFLICT`, eventos, guardas de estado y replay exacto (trading/cash; histórico vía `cash-idempotency.ts`) | `PrismaOrderRepository` | `http/server.ts` | `integration/infra` · funcionales |
| `src/infra/prisma/portfolio-read-repository.ts` | lecturas del portfolio (`userExists`, movimientos FILLED, NEW) con `tx` opcional | `PrismaPortfolioReadRepository` | `http/server.ts` | `integration/infra` · funcionales |
| `src/infra/prisma/transaction-context.ts` | brand/unbrand del `TransactionContext` + `resolveDbExecutor` (tx o cliente raíz) | `DbExecutor`, `brandTransactionContext`, `unbrandTransactionContext`, `resolveDbExecutor` | `order-repository.ts` · `portfolio-read-repository.ts` | `integration/infra` |
| `src/lib/prisma-client.ts` | singleton LAZY de `PrismaClient` con driver adapter (`DATABASE_URL` al primer uso) + `disconnectPrismaClient` para el cierre ordenado | `getPrismaClient`, `disconnectPrismaClient` | los 4 repos · `transaction-context.ts` · `src/index.ts` | `integration/infra` · funcionales |

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

## 11. Mapa de tests (una suite por caso de uso)

| suite | cubre | DB |
|---|---|---|
| `tests/unit/domain/**` | dominio puro: cash, reservas, patrimonio (`portfolio-total-account-value`), matching, sizing | ninguna |
| `tests/unit/application/*` | decisiones y persistencia de órdenes (puras) y el caso de uso del portfolio (con fakes) | ninguna |
| `tests/unit/http/*` | borde compartido (`edge`) y contrato de errores transversales (404/400/413/500 con `buildApp`) | ninguna |
| `tests/unit/contracts-orders.test.ts` · `tests/unit/money-input.test.ts` · `tests/unit/money-serialization.test.ts` | schemas Zod del contrato de órdenes (`MAX_ORDER_SIZE_SHARES`, `price` null en MARKET) y de dinero | ninguna |
| `tests/integration/infra/*` | 4 repos Prisma + idempotencia + tx + mappers (`filledPrice`) | `cocos_challenge_test` |
| `tests/functional/read` | UC-1 y UC-2 end-to-end | `cocos_challenge_read` |
| `tests/functional/orders` | matriz completa UC-3 (13 casos) contra `serverApp` | `cocos_challenge_ftest` |
| `tests/functional/orders-submit` | cableo application+router+repos de UC-3 | `cocos_challenge_submit` |
| `tests/functional/cancel` | UC-4 | `cocos_challenge_cancel` |
| `tests/functional/transfers` | UC-5 | `cocos_challenge_transfer` |
| `tests/db.smoke.test.ts` · `tests/deps.smoke.test.ts` | toolchain (pg, ts-jest, imports) | `cocos_challenge_test` |

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

- UC-2 (instruments) **no tiene caso de uso**: la búsqueda y el batch de snapshots viven en el router (el de portfolio ya tiene el suyo: `src/application/portfolio/get-portfolio.ts`).
- `marketdata-price-source.ts` implementa `PriceSource` y **nadie lo cablea** (punto de enchufe del matching).
- La migración no tiene `CHECK` de transiciones de estado: la guarda es a nivel app.

