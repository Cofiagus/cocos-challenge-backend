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
index.ts ──► http/server.ts (composition root: 5 repos Prisma + 5 routers)
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
| `src/contracts/datetime.ts` | timestamps sin zona → ISO 8601 sin offset, desde componentes locales (nunca `toISOString`) | `serializeLocalTimestamp` | los 5 routers | funcionales |
| `src/contracts/domain.ts` | vocabulario compartido: movimientos, órdenes, snapshots, `TransactionContext` opaco, drafts y resultados | `TransactionContext`, `SettledOrderMovement`, `RestingOrder`, `MarketdataSnapshot`, `Reservations`, `PositionPnl`, `OrderRecord`, `OrderDraft`, `OrderEventMetadata`, `OrderEventDraft`, `OrderEventRecord`, `CreateOrderResult`, `InstrumentRecord` | `domain` · `ports` · `application` · `infra/mappers` | — |
| `src/contracts/enums.ts` | literales compartidos entre dominio, HTTP y DB — sin `EXPIRED` ni `DAY` (fuera de alcance) | `OrderSideSchema`, `OrderSide`, `TradingSideSchema`, `TradingSide`, `TransferSideSchema`, `TransferSide`, `OrderTypeSchema`, `OrderType`, `OrderStatusSchema`, `OrderStatus`, `TimeInForceSchema`, `TimeInForce`, `InstrumentTypeSchema`, `InstrumentType`, `OrderEventTypeSchema`, `OrderEventType`, `OrderRejectionReasonSchema`, `OrderRejectionReason` | todos los slices + `tests/helpers/factories.ts` | `unit` + factories |
| `src/contracts/errors.ts` | forma única del error HTTP `{error:{code,message}}` + códigos estables | `ApiErrorBodySchema`, `ApiErrorBody`, `API_ERROR_CODES`, `ApiErrorCode`, `apiErrorBody` | routers · application | funcionales |
| `src/contracts/index.ts` | barrel: única puerta de import de contratos | (barrel) | 17 archivos de `src/` | — |
| `src/contracts/instruments.ts` | contrato de UC-2: `query` obligatoria, límite 1..100, resultado con precio y variación | `DEFAULT_INSTRUMENT_SEARCH_LIMIT`, `MAX_INSTRUMENT_SEARCH_LIMIT`, `InstrumentSearchQuerySchema`, `InstrumentSearchQuery`, `InstrumentSearchResultSchema`, `InstrumentSearchResult`, `InstrumentSearchResponseSchema`, `InstrumentSearchResponse` | `http/instruments` | `functional/read` |
| `src/contracts/money.ts` | dinero: entrada `Decimal` desde string/número, salida número JSON cuantizado a 2 decimales | `MoneyArs`, `Pct`, `MoneyArsSchema`, `PctSchema`, `ArsInputSchema`, `PositiveArsInputSchema`, `serializeMoneyArs`, `serializePct` | routers · contracts · dominio | funcionales |
| `src/contracts/orders.ts` | contrato de UC-3 y UC-4: XOR `instrumentId`\|`ticker`, `Idempotency-Key`, `OrderResponse` | `IDEMPOTENCY_KEY_HEADER`, `IdempotencyKeySchema`, `IdempotencyKey`, `CreateOrderParamsSchema`, `CreateOrderParams`, `CancelOrderParamsSchema`, `CancelOrderParams`, `CreateOrderRequestSchema`, `CreateOrderRequest`, `OrderResponseSchema`, `OrderResponse` | `http/orders` · `http/cancel` · `application` | `functional/orders` (ambas) |
| `src/contracts/portfolio.ts` | contrato de UC-1: params y `PortfolioResponse` (cash, reservedCash, totalAccountValue, positions) | `PortfolioParamsSchema`, `PortfolioParams`, `PortfolioPositionSchema`, `PortfolioPosition`, `PortfolioResponseSchema`, `PortfolioResponse` | `http/portfolio` | `functional/read` |
| `src/contracts/transfers.ts` | contrato de UC-5: monto positivo y `side` CASH_IN\|CASH_OUT | `CreateTransferParamsSchema`, `CreateTransferParams`, `CreateTransferRequestSchema`, `CreateTransferRequest` | `http/transfers` | `functional/transfers` |

## 4. domain — funciones puras (sin I/O, sin reloj)

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/domain/index.ts` | barrel del dominio puro | (barrel) | `application` · `http/portfolio` | — |
| `src/domain/matching/index.ts` | evaluación pura del cruce (`evaluateCross`) y `matchRestingOrders` como punto de enchufe SIN disparador | `PriceSource`, `EvaluateCrossInput`, `CrossDecision`, `evaluateCross`, `RestingOrderFill`, `matchRestingOrders` | `domain/index.ts` · `infra/marketdata-price-source.ts` | `unit/domain/matching` |
| `src/domain/portfolio/index.ts` | derivaciones puras: cash, reservas, costo promedio ponderado, posiciones y P&L | `deriveCash`, `deriveReservations`, `weightedAverageCost`, `derivePositions` | `domain/index.ts` | `unit/domain/portfolio` |
| `src/domain/sizing/index.ts` | `size = floor(amountArs / precio)` — nunca compromete más que el monto | `sizeSharesFromAmountArs` | `domain/index.ts` | `unit/domain/sizing` |

## 5. domain/ports — las interfaces (DIP)

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/domain/ports/index.ts` | las 4 interfaces que la aplicación consume y la infra implementa (DIP) | `OrderRepository`, `PortfolioReadRepository`, `InstrumentRepository`, `MarketdataRepository` | `application` · routers · `infra` | `integration/infra` |

## 6. application — casos de uso (orquestan tx + repos + dominio)

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/application/cancel/cancel-order.ts` | UC-4: cancelar una orden `NEW` — 404 si no existe, 422 si ya no es NEW, evento CANCELLED en la misma tx | `CancelOrderError`, `CancelOrderDeps`, `CancelOrderInput`, `CancelOrderResult`, `cancelOrder` | `http/cancel/cancel-router.ts` | `functional/cancel` |
| `src/application/orders/submit-order.ts` | UC-3: envío completo — resuelve instrumento, precio, size y fondos; decide estado; claim idempotente + evento en UNA tx | `SubmitOrderErrorCode`, `SubmitOrderError`, `SubmitOrderDeps`, `SubmitOrderInput`, `SubmitOrderResult`, `submitOrder` | `http/orders/orders-router.ts` | `functional/orders` · `functional/orders-submit` |
| `src/application/transfers/submit-transfer.ts` | UC-5: CASH_IN/CASH_OUT como orders del instrumento ARS (`price` 1.00, `size` = pesos) | `SubmitTransferError`, `SubmitTransferDeps`, `SubmitTransferInput`, `SubmitTransferResult`, `submitTransfer` | `http/transfers/transfers-router.ts` | `functional/transfers` |

## 7. http — borde y composición

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/http/app.ts` | `buildApp(routers)` — monta routers bajo `/api`; sin routers no monta nada (Express 5 lanza con lista vacía) | `buildApp` | `http/server.ts` | funcionales (composición local) |
| `src/http/cancel/cancel-router.ts` | borde UC-4: Zod params → `cancelOrder` → 200 `OrderResponse` | `CancelRouterDeps`, `buildCancelRouter` | `http/server.ts` | `functional/cancel` |
| `src/http/instruments/instruments-router.ts` | borde UC-2: `query` → `searchByQuery` → batch de snapshots → respuesta | `InstrumentsRouterDeps`, `buildInstrumentsRouter` | `http/server.ts` | `functional/read` |
| `src/http/orders/orders-router.ts` | borde UC-3: Zod params+body+header → `submitOrder` → 201 `OrderResponse` | `OrdersRouterDeps`, `buildOrdersRouter` | `http/server.ts` | `functional/orders` (ambas) |
| `src/http/portfolio/portfolio-router.ts` | borde UC-1 **con lógica**: lee movimientos/NEW, batchea snapshots, agrega con el dominio y serializa | `PortfolioRouterDeps`, `buildPortfolioRouter` | `http/server.ts` | `functional/read` |
| `src/http/server.ts` | composition root: instancia los 5 repos Prisma y arma `serverApp` | `serverApp` | `src/index.ts` | — |
| `src/http/transfers/transfers-router.ts` | borde UC-5: Zod params+body+header → `submitTransfer` → 201 `OrderResponse` | `TransfersRouterDeps`, `buildTransfersRouter` | `http/server.ts` | `functional/transfers` |
| `src/index.ts` | entry: `dotenv/config` + `listen(PORT)` | (entry) | — | — |

## 8. infra + lib — Prisma, transacciones, mappers

| archivo | responsabilidad | exports | llamado por | test |
|---|---|---|---|---|
| `src/infra/prisma/corrupt-row.error.ts` | fallo ruidoso ante NULL donde el contrato exige valor (nunca normaliza en silencio) | `CorruptRowError` | `mappers.ts` · `order-repository.ts` | `integration/infra` |
| `src/infra/prisma/instrument-repository.ts` | catálogo: `findById`/`findByTicker` (pueden devolver MONEDA) y `searchByQuery` (la excluye) | `PrismaInstrumentRepository` | `http/server.ts` | `integration/infra` · funcionales |
| `src/infra/prisma/mappers.ts` | fila PG ↔ record de contracts; `Decimal` por string; NULL inesperado = `CorruptRowError` | `decimalFromDb`, `decimalToDbParam`, `mapOrderRow`, `mapSettledMovementRow`, `mapRestingOrderRow`, `mapOrderEventRow`, `metadataToDbParam`, `mapInstrumentRow`, `MarketdataRawRow`, `mapMarketdataRawRow` | los 4 repos | `integration/infra` |
| `src/infra/prisma/marketdata-price-source.ts` | `PriceSource` de matching: close de la última vela — **sin cablear** al flujo de producción | `MarketdataPriceSource` | nadie (sólo tests) | `integration/infra/marketdata` |
| `src/infra/prisma/marketdata-repository.ts` | último snapshot por `date`: UNA query raw con `DISTINCT ON`, individual y en batch | `PrismaMarketdataRepository` | `http/server.ts` | `integration/infra` · funcionales |
| `src/infra/prisma/order-repository.ts` | escrituras de orders: tx + advisory lock, claim `ON CONFLICT`, eventos, guardas de estado | `PrismaOrderRepository` | `http/server.ts` | `integration/infra` · funcionales |
| `src/infra/prisma/portfolio-read-repository.ts` | lecturas del portfolio (`userExists`, movimientos FILLED, NEW) con `tx` opcional | `PrismaPortfolioReadRepository` | `http/server.ts` | `integration/infra` · funcionales |
| `src/infra/prisma/transaction-context.ts` | brand/unbrand del `TransactionContext` + `resolveDbExecutor` (tx o cliente raíz) | `DbExecutor`, `brandTransactionContext`, `unbrandTransactionContext`, `resolveDbExecutor` | `order-repository.ts` · `portfolio-read-repository.ts` | `integration/infra` |
| `src/lib/prisma-client.ts` | singleton LAZY de `PrismaClient` con driver adapter (`DATABASE_URL` al primer uso) | `getPrismaClient` | los 4 repos · `transaction-context.ts` | `integration/infra` · funcionales |

## 9. Firmas del dominio (lo que no hace falta abrir)

| función | firma | invariante |
|---|---|---|
| `deriveCash` | `(movements: readonly SettledOrderMovement[]) => Decimal` | sólo FILLED; CASH_IN/SELL suman, CASH_OUT/BUY restan |
| `deriveReservations` | `(resting: readonly RestingOrder[]) => Reservations` | BUY reserva `price × size`; SELL reserva `size` acciones |
| `weightedAverageCost` | `(movements) => Decimal \| null` | las ventas no tocan el promedio; `null` si no hay compras |
| `derivePositions` | `(movements, snapshots) => readonly PositionPnl[]` | cantidad 0 no se lista; sin precio ⇒ `marketValueArs: null` |
| `evaluateCross` | `(input: EvaluateCrossInput) => CrossDecision` | BUY llena a `min(límite, ref)`, SELL a `max(límite, ref)`; IOC/FOK todo-o-nada |
| `matchRestingOrders` | `(refPrice, orders) => readonly RestingOrderFill[]` | **sin disparador en producción** (punto de enchufe) |
| `sizeSharesFromAmountArs` | `(amountArs: Decimal, priceArs: Decimal) => number` | `floor`; nunca se compromete más que el monto |
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
| `tests/unit/domain/{portfolio,matching,sizing}` | dominio puro | ninguna |
| `tests/integration/infra/*` | 4 repos Prisma + idempotencia + tx | `cocos_challenge_test` |
| `tests/functional/read` | UC-1 y UC-2 end-to-end | `cocos_challenge_read` |
| `tests/functional/orders` | matriz completa UC-3 (13 casos) contra `serverApp` | `cocos_challenge_ftest` |
| `tests/functional/orders-submit` | cableo application+router+repos de UC-3 | `cocos_challenge_submit` |
| `tests/functional/cancel` | UC-4 | `cocos_challenge_cancel` |
| `tests/functional/transfers` | UC-5 | `cocos_challenge_transfer` |
| `tests/db.smoke.test.ts` · `tests/deps.smoke.test.ts` | toolchain (pg, ts-jest, imports) | `cocos_challenge_test` |

## 12. Herramientas de documentación (fuera de `src/`)

| archivo | responsabilidad |
|---|---|
| `scripts/openapi/wire.ts` | espejos representables de los schemas de entrada (dinero: número o string) |
| `scripts/openapi/registry.ts` | las 5 operaciones: método, ruta Express, schemas, status, códigos, ejemplos |
| `scripts/openapi/build.ts` | arma el documento OpenAPI 3.1 con `z.toJSONSchema` |
| `scripts/generate-openapi.ts` | `npm run openapi` → escribe `openapi.json` |
| `tests/docs/docs-consistency.test.ts` | D1–D3: paths citados, archivos de `src/` y exports en este mapa |
| `tests/docs/openapi.test.ts` | D4–D7: JSON sincronizado, rutas = routers, códigos, shapes y equivalencia del wire |

## 13. Deuda conocida (no "arreglar" sin spec)

- UC-1 (portfolio) y UC-2 (instruments) **no tienen caso de uso**: la agregación/serialización vive en el router.
- No hay error handler central: un 500 sale con el HTML por defecto de Express, no con `{error:{code,message}}`.
- `portfolio-router` hace un `instruments.findById` por posición (N+1) después del batch de marketdata.
- `orders-router` castea `error.code as ApiErrorCode` porque `INSTRUMENT_NOT_FOUND` no está en `API_ERROR_CODES`.
- `marketdata-price-source.ts` implementa `PriceSource` y **nadie lo cablea** (punto de enchufe del matching).
- `validationMessage` (Zod → texto) está duplicada en 5 routers.
- La migración no tiene `CHECK` de transiciones de estado: la guarda es a nivel app.

