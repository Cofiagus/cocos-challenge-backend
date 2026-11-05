// Fakes en memoria de los cuatro ports de submitOrder (OrderRepository,
// PortfolioReadRepository, InstrumentRepository, MarketdataRepository).
//
// Registran EN ORDEN cada llamada con sus argumentos y el TransactionContext
// recibido: los tests de caracterización asertan la secuencia exacta de ports
// (qué se lee, qué no se lee y que createOrder es la primera escritura) y que
// todos los métodos reciben el MISMO tx que entregó withUserTransaction.
//
// Sin DB, sin Prisma, sin Express. Dinero siempre Decimal desde string.

import { Decimal } from "decimal.js";
import type { SubmitOrderDeps } from "../../../src/application/orders/submit-order.js";
import type {
  CreateOrderResult,
  InstrumentRecord,
  MarketdataSnapshot,
  OrderDraft,
  OrderEventDraft,
  OrderEventRecord,
  OrderRecord,
  RestingOrder,
  SettledOrderMovement,
  TransactionContext,
} from "../../../src/contracts/index.js";
import type {
  InstrumentRepository,
  MarketdataRepository,
  OrderRepository,
  PortfolioReadRepository,
} from "../../../src/domain/ports/index.js";

export type PortName = "orders" | "portfolioRead" | "instruments" | "marketdata";

/** Una llamada a un port, en el orden en que ocurrió. */
export interface RecordedCall {
  readonly port: PortName;
  readonly method: string;
  readonly args: readonly unknown[];
  /** tx recibido; undefined sólo en withUserTransaction (es quien lo crea). */
  readonly tx: TransactionContext | undefined;
}

export type CreateOrderOutcome = CreateOrderResult["outcome"];

/** Estado inicial de los fakes: lo que "hay en la DB" para este envío. */
export interface SubmitOrderFakeSeed {
  readonly userExists?: boolean;
  readonly instruments?: readonly InstrumentRecord[];
  /** Última vela del instrumento; null/ausente ⇒ NO_PRICE. */
  readonly snapshot?: MarketdataSnapshot | null;
  readonly movements?: readonly SettledOrderMovement[];
  readonly restingOrders?: readonly RestingOrder[];
  /** Outcome del claim idempotente (default CREATED). */
  readonly createOutcome?: CreateOrderOutcome;
  /** Orden que devuelve el claim cuando el outcome NO es CREATED. */
  readonly existingOrder?: OrderRecord;
}

export interface SubmitOrderFakes {
  readonly deps: SubmitOrderDeps;
  readonly calls: readonly RecordedCall[];
  /** tx que withUserTransaction entregó al callback (identidad comparable). */
  readonly transaction: TransactionContext;
  readonly createdDrafts: readonly OrderDraft[];
  readonly appendedEvents: readonly OrderEventDraft[];
}

/** Orden original que devuelve el claim en REPLAY/CONFLICT. */
const DEFAULT_EXISTING_ORDER: OrderRecord = {
  id: 900,
  instrumentId: 1,
  userId: 1,
  side: "BUY",
  type: "LIMIT",
  timeInForce: "GTC",
  status: "NEW",
  sizeShares: 1,
  priceArs: new Decimal("210.00"),
  filledPriceArs: null,
  filledAt: null,
  idempotencyKey: "idem-replay",
  datetime: new Date("2023-07-14T10:00:00.000Z"),
};

/**
 * Fila que el repo devolvería tras insertar el draft (id fijo: 501). El
 * `side` discrimina la unidad física: acciones (number) en trading, monto
 * exacto (Decimal) en cash.
 */
const orderFromDraft = (draft: OrderDraft, id: number): OrderRecord => {
  const common = {
    id,
    instrumentId: draft.instrumentId,
    userId: draft.userId,
    type: draft.type,
    timeInForce: draft.timeInForce,
    status: draft.status,
    priceArs: draft.priceArs,
    filledPriceArs: draft.filledPriceArs,
    filledAt: draft.filledAt,
    idempotencyKey: draft.idempotencyKey,
    datetime: draft.datetime,
  };
  if (draft.side === "BUY" || draft.side === "SELL") {
    return { ...common, side: draft.side, sizeShares: draft.sizeShares };
  }
  return { ...common, side: draft.side, amountArs: draft.amountArs };
};

export const buildSubmitOrderFakes = (
  seed: SubmitOrderFakeSeed = {},
): SubmitOrderFakes => {
  const calls: RecordedCall[] = [];
  const createdDrafts: OrderDraft[] = [];
  const appendedEvents: OrderEventDraft[] = [];
  const transaction: TransactionContext = { __brand: "TransactionContext" };

  const record = (
    port: PortName,
    method: string,
    args: readonly unknown[],
    tx: TransactionContext | undefined,
  ): void => {
    calls.push({ port, method, args, tx });
  };

  const orders: OrderRepository = {
    withUserTransaction: async <T>(
      userId: number,
      operation: (tx: TransactionContext) => Promise<T>,
    ): Promise<T> => {
      record("orders", "withUserTransaction", [userId], undefined);
      return operation(transaction);
    },
    createOrder: async (draft, tx) => {
      record("orders", "createOrder", [draft], tx);
      createdDrafts.push(draft);
      const outcome = seed.createOutcome ?? "CREATED";
      if (outcome === "CREATED") {
        return { outcome, order: orderFromDraft(draft, 501) };
      }
      return { outcome, order: seed.existingOrder ?? DEFAULT_EXISTING_ORDER };
    },
    appendOrderEvent: async (event, tx) => {
      record("orders", "appendOrderEvent", [event], tx);
      appendedEvents.push(event);
      const record_: OrderEventRecord = {
        ...event,
        id: 700 + appendedEvents.length,
        createdAt: new Date("2023-07-14T10:00:00.000Z"),
      };
      return record_;
    },
    findById: async (orderId) => {
      record("orders", "findById", [orderId], undefined);
      throw new Error("orders.findById no participa del envío.");
    },
    markFilled: async (orderId, filledPriceArs, filledAt, tx) => {
      record("orders", "markFilled", [orderId, filledPriceArs, filledAt], tx);
      throw new Error("orders.markFilled no participa del envío.");
    },
    markCancelled: async (orderId, tx) => {
      record("orders", "markCancelled", [orderId], tx);
      throw new Error("orders.markCancelled no participa del envío.");
    },
  };

  const portfolioRead: PortfolioReadRepository = {
    userExists: async (userId, tx) => {
      record("portfolioRead", "userExists", [userId], tx);
      return seed.userExists ?? true;
    },
    listSettledMovements: async (userId, tx) => {
      record("portfolioRead", "listSettledMovements", [userId], tx);
      return seed.movements ?? [];
    },
    listRestingOrders: async (userId, tx) => {
      record("portfolioRead", "listRestingOrders", [userId], tx);
      return seed.restingOrders ?? [];
    },
  };

  const instruments: InstrumentRepository = {
    findById: async (instrumentId, tx) => {
      record("instruments", "findById", [instrumentId], tx);
      return (
        (seed.instruments ?? []).find((row) => row.id === instrumentId) ?? null
      );
    },
    findByIds: async (instrumentIds, tx) => {
      record("instruments", "findByIds", [instrumentIds], tx);
      throw new Error("instruments.findByIds no participa del envío.");
    },
    findByTicker: async (ticker, tx) => {
      record("instruments", "findByTicker", [ticker], tx);
      return (
        (seed.instruments ?? []).find((row) => row.ticker === ticker) ?? null
      );
    },
    searchByQuery: async (query, limit) => {
      record("instruments", "searchByQuery", [query, limit], undefined);
      throw new Error("instruments.searchByQuery no participa del envío.");
    },
  };

  const marketdata: MarketdataRepository = {
    getLatestSnapshot: async (instrumentId, tx) => {
      record("marketdata", "getLatestSnapshot", [instrumentId], tx);
      const snapshot = seed.snapshot ?? null;
      return snapshot !== null && snapshot.instrumentId === instrumentId
        ? snapshot
        : null;
    },
    getLatestSnapshots: async (instrumentIds, tx) => {
      record("marketdata", "getLatestSnapshots", [instrumentIds], tx);
      throw new Error("marketdata.getLatestSnapshots no participa del envío.");
    },
  };

  return {
    deps: { orders, portfolioRead, instruments, marketdata },
    calls,
    transaction,
    createdDrafts,
    appendedEvents,
  };
};

/** Primer argumento legible (sólo escalares: los objetos no se imprimen). */
const formatFirstArg = (value: unknown): string | null =>
  typeof value === "number" || typeof value === "string" ? String(value) : null;

/**
 * Etiquetas ORDENADAS de las llamadas, con el primer argumento escalar:
 * "portfolioRead.userExists(1)", "orders.createOrder", ...
 */
export const callLabels = (
  calls: readonly RecordedCall[],
): readonly string[] =>
  calls.map((call) => {
    const first = call.args.length === 0 ? null : formatFirstArg(call.args[0]);
    return first === null
      ? `${call.port}.${call.method}`
      : `${call.port}.${call.method}(${first})`;
  });
