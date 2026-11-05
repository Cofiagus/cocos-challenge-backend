// Caracterización de submitOrder (UC-3) con fakes en memoria de los cuatro
// ports: sin DB, sin Prisma, sin Express.
//
// Fija el comportamiento OBSERVADO del código actual para poder refactorizarlo
// sin cambiar el contrato: por caso se asertan LITERALMENTE el draft que
// recibe createOrder, el evento de auditoría (con su metadata completa), el
// resultado y la LISTA ORDENADA de llamadas a ports (qué se lee, qué no se
// lee y que createOrder es la primera escritura). Los esperados son valores
// escritos a mano, nunca recalculados con la misma lógica del caso de uso.
//
// Dinero SIEMPRE Decimal desde string (AGENTS.md): ningún fixture usa float.

import { Decimal } from "decimal.js";
import {
  SubmitOrderError,
  submitOrder,
} from "../../../src/application/orders/submit-order.js";
import { IdempotencyConflictError } from "../../../src/application/orders/persist-order-decision.js";
import type {
  CreateOrderRequest,
  InstrumentRecord,
  MarketdataSnapshot,
  OrderEventMetadata,
  OrderEventType,
  OrderRejectionReason,
  OrderStatus,
  RestingOrder,
  SettledOrderMovement,
  TimeInForce,
} from "../../../src/contracts/index.js";
import {
  buildSubmitOrderFakes,
  callLabels,
  type SubmitOrderFakeSeed,
  type SubmitOrderFakes,
} from "../../helpers/fakes/submit-order-fakes.js";

// ---------------------------------------------------------------------------
// Insumos (dinero desde string, nunca float)
// ---------------------------------------------------------------------------

const PAMP: InstrumentRecord = {
  id: 1,
  ticker: "PAMP",
  name: "Pampa Holding S.A.",
  type: "ACCIONES",
};
const METR: InstrumentRecord = {
  id: 2,
  ticker: "METR",
  name: "MetroGAS S.A.",
  type: "ACCIONES",
};
const ARS: InstrumentRecord = {
  id: 66,
  ticker: "ARS",
  name: "Peso argentino",
  type: "MONEDA",
};
const CATALOG: readonly InstrumentRecord[] = [PAMP, METR, ARS];

const snapshot = (
  instrumentId: number,
  closeArs: string,
): MarketdataSnapshot => ({
  instrumentId,
  date: "2023-07-14",
  closeArs: new Decimal(closeArs),
  previousCloseArs: new Decimal(closeArs),
});

/** CASH_IN de un monto exacto en ARS (el cash no lleva acciones). */
const cashIn = (amountArs: string): SettledOrderMovement => ({
  side: "CASH_IN",
  amountArs: new Decimal(amountArs),
});

const trade = (
  instrumentId: number,
  side: "BUY" | "SELL",
  sizeShares: number,
  priceArs: string,
): SettledOrderMovement => ({
  instrumentId,
  side,
  sizeShares,
  priceArs: new Decimal(priceArs),
});

const resting = (
  instrumentId: number,
  side: "BUY" | "SELL",
  sizeShares: number,
  limitPriceArs: string,
): RestingOrder => ({
  id: 1,
  instrumentId,
  side,
  sizeShares,
  limitPriceArs: new Decimal(limitPriceArs),
});

// ---------------------------------------------------------------------------
// Secuencias de ports esperadas (literales)
// ---------------------------------------------------------------------------

const CALLS_MARKET = [
  "orders.withUserTransaction(1)",
  "portfolioRead.userExists(1)",
  "instruments.findById(1)",
  "marketdata.getLatestSnapshot(1)",
  "portfolioRead.listSettledMovements(1)",
  "portfolioRead.listRestingOrders(1)",
  "orders.createOrder",
  "orders.appendOrderEvent",
];

/** LIMIT GTC: NO resuelve precio de referencia (queda NEW sin snapshot). */
const CALLS_LIMIT_GTC = [
  "orders.withUserTransaction(1)",
  "portfolioRead.userExists(1)",
  "instruments.findById(1)",
  "portfolioRead.listSettledMovements(1)",
  "portfolioRead.listRestingOrders(1)",
  "orders.createOrder",
  "orders.appendOrderEvent",
];

/** NO_PRICE / ZERO_SIZE: se decide antes de leer fondos y tenencia. */
const CALLS_BEFORE_FUNDS = [
  "orders.withUserTransaction(1)",
  "portfolioRead.userExists(1)",
  "instruments.findById(1)",
  "marketdata.getLatestSnapshot(1)",
  "orders.createOrder",
  "orders.appendOrderEvent",
];

/** REPLAY: la orden original, sin evento nuevo. */
const CALLS_REPLAY = [
  "orders.withUserTransaction(1)",
  "portfolioRead.userExists(1)",
  "instruments.findById(1)",
  "portfolioRead.listSettledMovements(1)",
  "portfolioRead.listRestingOrders(1)",
  "orders.createOrder",
];

// ---------------------------------------------------------------------------
// Metadata de auditoría esperada (strings de 2 decimales, nunca float)
// ---------------------------------------------------------------------------

const AUDIT_MARKET: OrderEventMetadata = {
  ticker: "PAMP",
  referencePriceArs: "925.85",
  sizingPriceArs: null,
  sizeDerivedFromAmount: false,
  residualArs: null,
};

const AUDIT_LIMIT_GTC: OrderEventMetadata = {
  ticker: "PAMP",
  referencePriceArs: null,
  sizingPriceArs: null,
  sizeDerivedFromAmount: false,
  residualArs: null,
};

// ---------------------------------------------------------------------------
// Forma de los casos
// ---------------------------------------------------------------------------

interface ExpectedDraft {
  readonly status: OrderStatus;
  readonly sizeShares: number;
  readonly filledPriceArs: string | null;
  readonly filledAt: "DATE" | null;
  readonly priceArs: string | null;
  readonly timeInForce: TimeInForce;
  readonly idempotencyKey: string | null;
  readonly side: "BUY" | "SELL";
  readonly type: "MARKET" | "LIMIT";
  readonly instrumentId: number;
}

interface ExpectedEvent {
  readonly eventType: OrderEventType;
  readonly reason: OrderRejectionReason | null;
  readonly metadata: OrderEventMetadata;
}

interface PersistedCase {
  readonly name: string;
  readonly request: CreateOrderRequest;
  readonly seed: SubmitOrderFakeSeed;
  readonly userId?: number;
  readonly idempotencyKey?: string;
  readonly expected: {
    readonly status: OrderStatus;
    readonly reason: OrderRejectionReason | null;
    readonly draft: ExpectedDraft;
    readonly event: ExpectedEvent | null;
    readonly calls: readonly string[];
  };
}

interface ErrorCase {
  readonly name: string;
  readonly request: CreateOrderRequest;
  readonly seed: SubmitOrderFakeSeed;
  readonly userId?: number;
  readonly idempotencyKey?: string;
  /** Clase del 409 de idempotencia (compartida con las transferencias). */
  readonly errorClass?: "IdempotencyConflictError";
  readonly expected: {
    readonly status: number;
    readonly code: string;
    readonly message: string;
    readonly calls: readonly string[];
  };
}

interface ThrowCase {
  readonly name: string;
  readonly request: CreateOrderRequest;
  readonly seed: SubmitOrderFakeSeed;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Aserciones
// ---------------------------------------------------------------------------

const expectDraft = (
  fakes: SubmitOrderFakes,
  expected: ExpectedDraft,
): void => {
  expect(fakes.createdDrafts).toHaveLength(1);
  const draft = fakes.createdDrafts[0];
  if (draft === undefined) {
    throw new Error("createOrder no recibió ningún draft.");
  }
  // El constructor del precio de fill depende de la rama (referencia del
  // fixture vs evaluateCross); la aserción es sobre el valor monetario exacto.
  const { filledPriceArs, ...draftRest } = draft;
  expect(draftRest).toEqual({
    userId: 1,
    instrumentId: expected.instrumentId,
    side: expected.side,
    type: expected.type,
    timeInForce: expected.timeInForce,
    status: expected.status,
    sizeShares: expected.sizeShares,
    priceArs:
      expected.priceArs === null ? null : new Decimal(expected.priceArs),
    filledAt: expected.filledAt === null ? null : expect.any(Date),
    idempotencyKey: expected.idempotencyKey,
    datetime: expect.any(Date),
  });
  expect(filledPriceArs === null ? null : filledPriceArs.toFixed(2)).toBe(
    expected.filledPriceArs,
  );
};

const expectEvent = (
  fakes: SubmitOrderFakes,
  expected: ExpectedEvent | null,
): void => {
  if (expected === null) {
    expect(fakes.appendedEvents).toEqual([]);
    return;
  }
  expect(fakes.appendedEvents).toEqual([
    {
      orderId: 501,
      eventType: expected.eventType,
      reason: expected.reason,
      metadata: expected.metadata,
    },
  ]);
};

const expectCalls = (
  fakes: SubmitOrderFakes,
  expected: readonly string[],
): void => {
  expect(callLabels(fakes.calls)).toEqual(expected);
  // Todos los métodos que reciben tx reciben EL MISMO tx de la transacción.
  const callsWithTx = fakes.calls.filter((call) => call.tx !== undefined);
  expect(callsWithTx.length).toBeGreaterThan(0);
  expect(callsWithTx.every((call) => call.tx === fakes.transaction)).toBe(true);
};

const captureError = async (
  fakes: SubmitOrderFakes,
  request: CreateOrderRequest,
  userId: number,
  idempotencyKey: string | null,
): Promise<unknown> =>
  submitOrder(fakes.deps, { userId, request, idempotencyKey }).then(
    () => null,
    (reason: unknown) => reason,
  );

// ---------------------------------------------------------------------------
// Casos persistidos (201: FILLED / NEW / REJECTED / CANCELLED)
// ---------------------------------------------------------------------------

const persistedCases: PersistedCase[] = [
  {
    name: "MARKET BUY con fondos ⇒ FILLED al precio de referencia",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      size: 3,
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
    },
    expected: {
      status: "FILLED",
      reason: null,
      draft: {
        status: "FILLED",
        sizeShares: 3,
        filledPriceArs: "925.85",
        filledAt: "DATE",
        priceArs: null,
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "BUY",
        type: "MARKET",
        instrumentId: 1,
      },
      event: { eventType: "ACCEPTED", reason: null, metadata: AUDIT_MARKET },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "MARKET SELL con posición ⇒ FILLED al precio de referencia",
    request: {
      instrumentId: 1,
      side: "SELL",
      type: "MARKET",
      timeInForce: "GTC",
      size: 4,
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00"), trade(1, "BUY", 10, "900.00")],
    },
    expected: {
      status: "FILLED",
      reason: null,
      draft: {
        status: "FILLED",
        sizeShares: 4,
        filledPriceArs: "925.85",
        filledAt: "DATE",
        priceArs: null,
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "SELL",
        type: "MARKET",
        instrumentId: 1,
      },
      event: { eventType: "ACCEPTED", reason: null, metadata: AUDIT_MARKET },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "MARKET BUY sin fondos ⇒ REJECTED INSUFFICIENT_FUNDS con el costo requerido",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      size: 1000,
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("1000.00")],
    },
    expected: {
      status: "REJECTED",
      reason: "INSUFFICIENT_FUNDS",
      draft: {
        status: "REJECTED",
        sizeShares: 1000,
        filledPriceArs: null,
        filledAt: null,
        priceArs: null,
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "BUY",
        type: "MARKET",
        instrumentId: 1,
      },
      event: {
        eventType: "REJECTED",
        reason: "INSUFFICIENT_FUNDS",
        metadata: {
          ...AUDIT_MARKET,
          requiredCostArs: "925850.00",
          cashAvailableArs: "1000.00",
        },
      },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "MARKET BUY con costo EXACTAMENTE igual al cash disponible ⇒ FILLED",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      size: 1,
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "1000.00"),
      movements: [cashIn("1000.00")],
    },
    expected: {
      status: "FILLED",
      reason: null,
      draft: {
        status: "FILLED",
        sizeShares: 1,
        filledPriceArs: "1000.00",
        filledAt: "DATE",
        priceArs: null,
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "BUY",
        type: "MARKET",
        instrumentId: 1,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: {
          ticker: "PAMP",
          referencePriceArs: "1000.00",
          sizingPriceArs: null,
          sizeDerivedFromAmount: false,
          residualArs: null,
        },
      },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "MARKET SELL de EXACTAMENTE el vendible ⇒ FILLED (el límite es inclusivo)",
    request: {
      instrumentId: 1,
      side: "SELL",
      type: "MARKET",
      timeInForce: "GTC",
      size: 6,
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00"), trade(1, "BUY", 10, "900.00")],
      restingOrders: [resting(1, "SELL", 4, "1000.00")],
    },
    expected: {
      status: "FILLED",
      reason: null,
      draft: {
        status: "FILLED",
        sizeShares: 6,
        filledPriceArs: "925.85",
        filledAt: "DATE",
        priceArs: null,
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "SELL",
        type: "MARKET",
        instrumentId: 1,
      },
      event: { eventType: "ACCEPTED", reason: null, metadata: AUDIT_MARKET },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "MARKET SELL con acciones reservadas ⇒ REJECTED INSUFFICIENT_POSITION",
    request: {
      instrumentId: 1,
      side: "SELL",
      type: "MARKET",
      timeInForce: "GTC",
      size: 7,
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00"), trade(1, "BUY", 10, "900.00")],
      restingOrders: [resting(1, "SELL", 4, "1000.00")],
    },
    expected: {
      status: "REJECTED",
      reason: "INSUFFICIENT_POSITION",
      draft: {
        status: "REJECTED",
        sizeShares: 7,
        filledPriceArs: null,
        filledAt: null,
        priceArs: null,
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "SELL",
        type: "MARKET",
        instrumentId: 1,
      },
      event: {
        eventType: "REJECTED",
        reason: "INSUFFICIENT_POSITION",
        metadata: {
          ...AUDIT_MARKET,
          positionShares: "10",
          reservedShares: "4",
          sellableShares: "6",
        },
      },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "MARKET sin precio y size explícito ⇒ REJECTED NO_PRICE con ese size",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      size: 10,
    },
    seed: {
      instruments: CATALOG,
      snapshot: null,
      movements: [cashIn("100000.00")],
    },
    expected: {
      status: "REJECTED",
      reason: "NO_PRICE",
      draft: {
        status: "REJECTED",
        sizeShares: 10,
        filledPriceArs: null,
        filledAt: null,
        priceArs: null,
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "BUY",
        type: "MARKET",
        instrumentId: 1,
      },
      event: {
        eventType: "REJECTED",
        reason: "NO_PRICE",
        metadata: { ticker: "PAMP" },
      },
      calls: CALLS_BEFORE_FUNDS,
    },
  },
  {
    name: "MARKET sin precio y amountArs ⇒ REJECTED NO_PRICE con size 0",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      amountArs: new Decimal("5000.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: null,
      movements: [cashIn("100000.00")],
    },
    expected: {
      status: "REJECTED",
      reason: "NO_PRICE",
      draft: {
        status: "REJECTED",
        sizeShares: 0,
        filledPriceArs: null,
        filledAt: null,
        priceArs: null,
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "BUY",
        type: "MARKET",
        instrumentId: 1,
      },
      event: {
        eventType: "REJECTED",
        reason: "NO_PRICE",
        metadata: { ticker: "PAMP" },
      },
      calls: CALLS_BEFORE_FUNDS,
    },
  },
  {
    name: "amountArs ⇒ size = floor(monto/precio) y el residuo queda como cash",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      amountArs: new Decimal("10000.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
    },
    expected: {
      status: "FILLED",
      reason: null,
      draft: {
        status: "FILLED",
        sizeShares: 10,
        filledPriceArs: "925.85",
        filledAt: "DATE",
        priceArs: null,
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "BUY",
        type: "MARKET",
        instrumentId: 1,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: {
          ticker: "PAMP",
          referencePriceArs: "925.85",
          sizingPriceArs: "925.85",
          sizeDerivedFromAmount: true,
          residualArs: "741.50",
        },
      },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "amountArs menor al precio ⇒ size 0 ⇒ REJECTED ZERO_SIZE",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      amountArs: new Decimal("100.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
    },
    expected: {
      status: "REJECTED",
      reason: "ZERO_SIZE",
      draft: {
        status: "REJECTED",
        sizeShares: 0,
        filledPriceArs: null,
        filledAt: null,
        priceArs: null,
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "BUY",
        type: "MARKET",
        instrumentId: 1,
      },
      event: {
        eventType: "REJECTED",
        reason: "ZERO_SIZE",
        metadata: {
          ticker: "PAMP",
          referencePriceArs: "925.85",
          sizingPriceArs: "925.85",
          sizeDerivedFromAmount: true,
          residualArs: "100.00",
        },
      },
      calls: CALLS_BEFORE_FUNDS,
    },
  },
  {
    name: "LIMIT GTC BUY ⇒ NEW sin resolver precio de referencia",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "GTC",
      size: 2,
      price: new Decimal("250.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
    },
    expected: {
      status: "NEW",
      reason: null,
      draft: {
        status: "NEW",
        sizeShares: 2,
        filledPriceArs: null,
        filledAt: null,
        priceArs: "250.00",
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "BUY",
        type: "LIMIT",
        instrumentId: 1,
      },
      event: { eventType: "ACCEPTED", reason: null, metadata: AUDIT_LIMIT_GTC },
      calls: CALLS_LIMIT_GTC,
    },
  },
  {
    name: "LIMIT GTC SELL ⇒ NEW sin resolver precio de referencia",
    request: {
      instrumentId: 1,
      side: "SELL",
      type: "LIMIT",
      timeInForce: "GTC",
      size: 3,
      price: new Decimal("250.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00"), trade(1, "BUY", 10, "900.00")],
    },
    expected: {
      status: "NEW",
      reason: null,
      draft: {
        status: "NEW",
        sizeShares: 3,
        filledPriceArs: null,
        filledAt: null,
        priceArs: "250.00",
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "SELL",
        type: "LIMIT",
        instrumentId: 1,
      },
      event: { eventType: "ACCEPTED", reason: null, metadata: AUDIT_LIMIT_GTC },
      calls: CALLS_LIMIT_GTC,
    },
  },
  {
    name: "LIMIT GTC BUY sin fondos ⇒ REJECTED INSUFFICIENT_FUNDS al precio límite",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "GTC",
      size: 5,
      price: new Decimal("250.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("1000.00")],
    },
    expected: {
      status: "REJECTED",
      reason: "INSUFFICIENT_FUNDS",
      draft: {
        status: "REJECTED",
        sizeShares: 5,
        filledPriceArs: null,
        filledAt: null,
        priceArs: "250.00",
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "BUY",
        type: "LIMIT",
        instrumentId: 1,
      },
      event: {
        eventType: "REJECTED",
        reason: "INSUFFICIENT_FUNDS",
        metadata: {
          ...AUDIT_LIMIT_GTC,
          requiredCostArs: "1250.00",
          cashAvailableArs: "1000.00",
        },
      },
      calls: CALLS_LIMIT_GTC,
    },
  },
  {
    name: "LIMIT IOC BUY que cruza ⇒ FILLED a min(límite, referencia)",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "IOC",
      size: 2,
      price: new Decimal("950.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
    },
    expected: {
      status: "FILLED",
      reason: null,
      draft: {
        status: "FILLED",
        sizeShares: 2,
        filledPriceArs: "925.85",
        filledAt: "DATE",
        priceArs: "950.00",
        timeInForce: "IOC",
        idempotencyKey: null,
        side: "BUY",
        type: "LIMIT",
        instrumentId: 1,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: { ...AUDIT_MARKET, limitPriceArs: "950.00" },
      },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "LIMIT IOC BUY que no cruza ⇒ CANCELLED NO_IMMEDIATE_MATCH",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "IOC",
      size: 2,
      price: new Decimal("900.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
    },
    expected: {
      status: "CANCELLED",
      reason: "NO_IMMEDIATE_MATCH",
      draft: {
        status: "CANCELLED",
        sizeShares: 2,
        filledPriceArs: null,
        filledAt: null,
        priceArs: "900.00",
        timeInForce: "IOC",
        idempotencyKey: null,
        side: "BUY",
        type: "LIMIT",
        instrumentId: 1,
      },
      event: {
        eventType: "CANCELLED",
        reason: "NO_IMMEDIATE_MATCH",
        metadata: { ...AUDIT_MARKET, limitPriceArs: "900.00" },
      },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "LIMIT IOC SELL que cruza ⇒ FILLED a max(límite, referencia)",
    request: {
      instrumentId: 1,
      side: "SELL",
      type: "LIMIT",
      timeInForce: "IOC",
      size: 2,
      price: new Decimal("900.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00"), trade(1, "BUY", 10, "900.00")],
    },
    expected: {
      status: "FILLED",
      reason: null,
      draft: {
        status: "FILLED",
        sizeShares: 2,
        filledPriceArs: "925.85",
        filledAt: "DATE",
        priceArs: "900.00",
        timeInForce: "IOC",
        idempotencyKey: null,
        side: "SELL",
        type: "LIMIT",
        instrumentId: 1,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: { ...AUDIT_MARKET, limitPriceArs: "900.00" },
      },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "LIMIT FOK SELL que no cruza ⇒ CANCELLED NO_IMMEDIATE_MATCH",
    request: {
      instrumentId: 1,
      side: "SELL",
      type: "LIMIT",
      timeInForce: "FOK",
      size: 2,
      price: new Decimal("950.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00"), trade(1, "BUY", 10, "900.00")],
    },
    expected: {
      status: "CANCELLED",
      reason: "NO_IMMEDIATE_MATCH",
      draft: {
        status: "CANCELLED",
        sizeShares: 2,
        filledPriceArs: null,
        filledAt: null,
        priceArs: "950.00",
        timeInForce: "FOK",
        idempotencyKey: null,
        side: "SELL",
        type: "LIMIT",
        instrumentId: 1,
      },
      event: {
        eventType: "CANCELLED",
        reason: "NO_IMMEDIATE_MATCH",
        metadata: { ...AUDIT_MARKET, limitPriceArs: "950.00" },
      },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "LIMIT FOK BUY que cruza ⇒ FILLED a min(límite, referencia)",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "FOK",
      size: 2,
      price: new Decimal("950.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
    },
    expected: {
      status: "FILLED",
      reason: null,
      draft: {
        status: "FILLED",
        sizeShares: 2,
        filledPriceArs: "925.85",
        filledAt: "DATE",
        priceArs: "950.00",
        timeInForce: "FOK",
        idempotencyKey: null,
        side: "BUY",
        type: "LIMIT",
        instrumentId: 1,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: { ...AUDIT_MARKET, limitPriceArs: "950.00" },
      },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "reservas de BUY NEW bajan el cash disponible de la validación",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      size: 20,
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
      restingOrders: [resting(1, "BUY", 10, "9000.00")],
    },
    expected: {
      status: "REJECTED",
      reason: "INSUFFICIENT_FUNDS",
      draft: {
        status: "REJECTED",
        sizeShares: 20,
        filledPriceArs: null,
        filledAt: null,
        priceArs: null,
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "BUY",
        type: "MARKET",
        instrumentId: 1,
      },
      event: {
        eventType: "REJECTED",
        reason: "INSUFFICIENT_FUNDS",
        metadata: {
          ...AUDIT_MARKET,
          requiredCostArs: "18517.00",
          cashAvailableArs: "10000.00",
        },
      },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "posición negativa del seed ⇒ vendible negativo ⇒ INSUFFICIENT_POSITION",
    request: {
      instrumentId: 1,
      side: "SELL",
      type: "MARKET",
      timeInForce: "GTC",
      size: 1,
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [
        cashIn("100000.00"),
        trade(1, "BUY", 20, "900.00"),
        trade(1, "SELL", 30, "1100.00"),
      ],
    },
    expected: {
      status: "REJECTED",
      reason: "INSUFFICIENT_POSITION",
      draft: {
        status: "REJECTED",
        sizeShares: 1,
        filledPriceArs: null,
        filledAt: null,
        priceArs: null,
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "SELL",
        type: "MARKET",
        instrumentId: 1,
      },
      event: {
        eventType: "REJECTED",
        reason: "INSUFFICIENT_POSITION",
        metadata: {
          ...AUDIT_MARKET,
          positionShares: "-10",
          reservedShares: "0",
          sellableShares: "-10",
        },
      },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "movimiento de cash del mismo instrumento no altera la posición",
    request: {
      instrumentId: 1,
      side: "SELL",
      type: "MARKET",
      timeInForce: "GTC",
      size: 10,
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [
        cashIn("100000.00"),
        trade(1, "BUY", 10, "900.00"),
        { side: "CASH_OUT", amountArs: new Decimal("3.00") },
      ],
    },
    expected: {
      status: "FILLED",
      reason: null,
      draft: {
        status: "FILLED",
        sizeShares: 10,
        filledPriceArs: "925.85",
        filledAt: "DATE",
        priceArs: null,
        timeInForce: "GTC",
        idempotencyKey: null,
        side: "SELL",
        type: "MARKET",
        instrumentId: 1,
      },
      event: { eventType: "ACCEPTED", reason: null, metadata: AUDIT_MARKET },
      calls: CALLS_MARKET,
    },
  },
  {
    name: "REPLAY idempotente ⇒ la orden original, reason null y sin evento",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "GTC",
      size: 1,
      price: new Decimal("210.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
      createOutcome: "IDEMPOTENT_REPLAY",
    },
    idempotencyKey: "idem-replay",
    expected: {
      status: "NEW",
      reason: null,
      draft: {
        status: "NEW",
        sizeShares: 1,
        filledPriceArs: null,
        filledAt: null,
        priceArs: "210.00",
        timeInForce: "GTC",
        idempotencyKey: "idem-replay",
        side: "BUY",
        type: "LIMIT",
        instrumentId: 1,
      },
      event: null,
      calls: CALLS_REPLAY,
    },
  },
  {
    name: "REPLAY de un REJECTED ⇒ la orden original con reason null",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "GTC",
      size: 1000,
      price: new Decimal("1000.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("1000.00")],
      createOutcome: "IDEMPOTENT_REPLAY",
      existingOrder: {
        id: 900,
        instrumentId: 1,
        userId: 1,
        side: "BUY",
        type: "LIMIT",
        timeInForce: "GTC",
        status: "REJECTED",
        sizeShares: 1000,
        priceArs: new Decimal("1000.00"),
        filledPriceArs: null,
        filledAt: null,
        idempotencyKey: "idem-replay-rejected",
        datetime: new Date("2023-07-14T10:00:00.000Z"),
      },
    },
    idempotencyKey: "idem-replay-rejected",
    expected: {
      status: "REJECTED",
      reason: null,
      draft: {
        status: "REJECTED",
        sizeShares: 1000,
        filledPriceArs: null,
        filledAt: null,
        priceArs: "1000.00",
        timeInForce: "GTC",
        idempotencyKey: "idem-replay-rejected",
        side: "BUY",
        type: "LIMIT",
        instrumentId: 1,
      },
      event: null,
      calls: CALLS_REPLAY,
    },
  },
];

// ---------------------------------------------------------------------------
// Casos de error (404/400/409, sin orden creada)
// ---------------------------------------------------------------------------

const errorCases: ErrorCase[] = [
  {
    name: "usuario inexistente ⇒ 404 USER_NOT_FOUND sin más lecturas",
    userId: 999,
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      size: 1,
    },
    seed: { userExists: false, instruments: CATALOG },
    expected: {
      status: 404,
      code: "USER_NOT_FOUND",
      message: "No existe el usuario 999.",
      calls: [
        "orders.withUserTransaction(999)",
        "portfolioRead.userExists(999)",
      ],
    },
  },
  {
    name: "instrumento inexistente por instrumentId ⇒ 404 INSTRUMENT_NOT_FOUND",
    request: {
      instrumentId: 999,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      size: 1,
    },
    seed: { instruments: CATALOG },
    expected: {
      status: 404,
      code: "INSTRUMENT_NOT_FOUND",
      message: "No existe el instrumento (instrumentId 999).",
      calls: [
        "orders.withUserTransaction(1)",
        "portfolioRead.userExists(1)",
        "instruments.findById(999)",
      ],
    },
  },
  {
    name: "instrumento inexistente por ticker ⇒ 404 INSTRUMENT_NOT_FOUND",
    request: {
      ticker: "NOPE",
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      size: 1,
    },
    seed: { instruments: CATALOG },
    expected: {
      status: 404,
      code: "INSTRUMENT_NOT_FOUND",
      message: "No existe el instrumento (ticker NOPE).",
      calls: [
        "orders.withUserTransaction(1)",
        "portfolioRead.userExists(1)",
        "instruments.findByTicker(NOPE)",
      ],
    },
  },
  {
    name: "sin instrumentId ni ticker ⇒ 404 INSTRUMENT_NOT_FOUND sin resolver instrumento",
    // Viola el contrato: el borde exige exactamente uno de instrumentId/ticker.
    request: {
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      size: 1,
    } as unknown as CreateOrderRequest,
    seed: { instruments: CATALOG },
    expected: {
      status: 404,
      code: "INSTRUMENT_NOT_FOUND",
      message: "No existe el instrumento (ticker undefined).",
      calls: ["orders.withUserTransaction(1)", "portfolioRead.userExists(1)"],
    },
  },
  {
    name: "instrumento MONEDA ⇒ 400 INSTRUMENT_NOT_OPERABLE sin orden creada",
    request: {
      instrumentId: 66,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      size: 10,
    },
    seed: { instruments: CATALOG },
    expected: {
      status: 400,
      code: "INSTRUMENT_NOT_OPERABLE",
      message: "ARS es MONEDA: no operable (DECISIONS.md).",
      calls: [
        "orders.withUserTransaction(1)",
        "portfolioRead.userExists(1)",
        "instruments.findById(66)",
      ],
    },
  },
  {
    name: "misma key con otro payload ⇒ 409 IDEMPOTENCY_CONFLICT sin evento",
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "GTC",
      size: 1,
      price: new Decimal("210.00"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
      createOutcome: "IDEMPOTENT_CONFLICT",
    },
    idempotencyKey: "idem-conflicto",
    errorClass: "IdempotencyConflictError",
    expected: {
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      message:
        "Idempotency-Key ya usada con otro payload (orden existente 900).",
      calls: [
        "orders.withUserTransaction(1)",
        "portfolioRead.userExists(1)",
        "instruments.findById(1)",
        "portfolioRead.listSettledMovements(1)",
        "portfolioRead.listRestingOrders(1)",
        "orders.createOrder",
      ],
    },
  },
  {
    name: "amountArs cuyo size derivado supera INT4 ⇒ 400 VALIDATION_ERROR sin escritura",
    // El máximo D1 a un precio de 0.01 deriva ~1e24 acciones: fuera del
    // contrato. Debe cortar ANTES de leer fondos y de cualquier INSERT.
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
      amountArs: new Decimal("9999999999999999999999.99"),
    },
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "0.01"),
      movements: [cashIn("9999999999999999999999.99")],
    },
    expected: {
      status: 400,
      code: "VALIDATION_ERROR",
      message:
        "El size derivado de amountArs no es un entero entre 0 y 2147483647.",
      calls: [
        "orders.withUserTransaction(1)",
        "portfolioRead.userExists(1)",
        "instruments.findById(1)",
        "marketdata.getLatestSnapshot(1)",
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Guards "inalcanzables": el borde (Zod) los hace inalcanzables con un
// request coherente, así que el test viola el contrato a propósito.
// ---------------------------------------------------------------------------

/**
 * Campo del request que responde distinto en cada lectura. Tres guards de
 * submit-order.ts sólo se alcanzan si el request "miente" entre lecturas
 * (p. ej. se declara LIMIT al validar y MARKET al decidir): el borde Zod
 * exige un request coherente, así que el test lo viola a propósito para
 * caracterizar el mensaje del guard. `values` se consume en orden de lectura
 * y la última se repite.
 */
const lyingField = (
  values: readonly [string, ...string[]],
): PropertyDescriptor => {
  let reads = 0;
  return {
    enumerable: true,
    get: (): string => {
      const value = values[Math.min(reads, values.length - 1)];
      reads += 1;
      if (value === undefined) {
        throw new Error("lyingField sin valores.");
      }
      return value;
    },
  };
};

const lyingRequest = (
  base: Readonly<Record<string, unknown>>,
  field: "type" | "timeInForce",
  values: readonly [string, ...string[]],
): CreateOrderRequest => {
  const request: Record<string, unknown> = { ...base };
  Object.defineProperty(request, field, lyingField(values));
  return request as unknown as CreateOrderRequest;
};

const throwCases: ThrowCase[] = [
  {
    name: "sin size ni amountArs ⇒ guard de XOR del borde",
    // Viola el contrato: el borde exige exactamente uno de size/amountArs.
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "MARKET",
      timeInForce: "GTC",
    } as unknown as CreateOrderRequest,
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
    },
    message: "Envío sin size ni amountArs (inalcanzable: XOR del borde).",
  },
  {
    name: "LIMIT GTC con amountArs y sin price ⇒ guard de precio de sizing",
    // Viola el contrato: LIMIT exige price > 0 en el borde.
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "GTC",
      amountArs: new Decimal("1000.00"),
    } as unknown as CreateOrderRequest,
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
    },
    message:
      "Precio de sizing no resuelto (inalcanzable tras NO_PRICE/contrato).",
  },
  {
    name: "LIMIT GTC BUY con size y sin price ⇒ guard de precio de validación",
    // Viola el contrato: LIMIT exige price > 0 en el borde.
    request: {
      instrumentId: 1,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "GTC",
      size: 1,
    } as unknown as CreateOrderRequest,
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
    },
    message: "Precio de validación no resuelto (inalcanzable).",
  },
  {
    name: "MARKET sin referencia ⇒ guard de MARKET sin precio",
    // Viola el contrato: el request se declara LIMIT mientras se valida (para
    // no pedir referencia) y MARKET al decidir el estado.
    request: lyingRequest(
      {
        instrumentId: 1,
        side: "BUY",
        timeInForce: "GTC",
        size: 1,
        price: new Decimal("900.00"),
      },
      "type",
      ["LIMIT", "LIMIT", "LIMIT", "LIMIT", "MARKET"],
    ),
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
    },
    message: "MARKET sin precio de referencia (inalcanzable: NO_PRICE salió).",
  },
  {
    name: "IOC sin referencia ⇒ guard de IOC/FOK sin precio",
    // Viola el contrato: se declara GTC en la primera lectura (para no pedir
    // referencia) y IOC después (para no salir por la rama GTC).
    request: lyingRequest(
      {
        instrumentId: 1,
        side: "BUY",
        type: "LIMIT",
        size: 1,
        price: new Decimal("900.00"),
      },
      "timeInForce",
      ["GTC", "IOC", "IOC", "IOC"],
    ),
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
    },
    message: "IOC/FOK sin precio de referencia (inalcanzable: NO_PRICE salió).",
  },
  {
    name: "LIMIT IOC SELL sin price ⇒ guard de LIMIT sin límite",
    // Viola el contrato: LIMIT exige price > 0 en el borde.
    request: {
      instrumentId: 1,
      side: "SELL",
      type: "LIMIT",
      timeInForce: "IOC",
      size: 1,
    } as unknown as CreateOrderRequest,
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00"), trade(1, "BUY", 10, "900.00")],
    },
    message: "LIMIT sin límite (inalcanzable: contrato del borde).",
  },
  {
    name: "IOC/FOK con evaluación GTC ⇒ guard de evaluación sin decisión",
    // Viola el contrato: se declara IOC al validar y GTC al evaluar el cruce
    // (evaluateCross sólo responde NEW para GTC).
    request: lyingRequest(
      {
        instrumentId: 1,
        side: "BUY",
        type: "LIMIT",
        size: 1,
        price: new Decimal("950.00"),
      },
      "timeInForce",
      ["IOC", "IOC", "IOC", "GTC"],
    ),
    seed: {
      instruments: CATALOG,
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn("100000.00")],
    },
    message: "Evaluación IOC/FOK sin decisión (inalcanzable).",
  },
];

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

describe("submitOrder — caracterización del envío (UC-3)", () => {
  it.each(persistedCases)("$name", async (testCase) => {
    const fakes = buildSubmitOrderFakes(testCase.seed);

    const result = await submitOrder(fakes.deps, {
      userId: testCase.userId ?? 1,
      request: testCase.request,
      idempotencyKey: testCase.idempotencyKey ?? null,
    });

    expect(result.order.status).toBe(testCase.expected.status);
    expect(result.reason).toBe(testCase.expected.reason);
    expectDraft(fakes, testCase.expected.draft);
    expectEvent(fakes, testCase.expected.event);
    expectCalls(fakes, testCase.expected.calls);
  });

  it.each(errorCases)("$name", async (testCase) => {
    const fakes = buildSubmitOrderFakes(testCase.seed);

    const error = await captureError(
      fakes,
      testCase.request,
      testCase.userId ?? 1,
      testCase.idempotencyKey ?? null,
    );

    // El 409 de idempotencia es la clase COMPARTIDA (D-12); el resto de los
    // errores de aplicación siguen siendo SubmitOrderError.
    const errorClass =
      testCase.errorClass === "IdempotencyConflictError"
        ? IdempotencyConflictError
        : SubmitOrderError;
    expect(error).toBeInstanceOf(errorClass);
    if (!(error instanceof errorClass)) {
      throw new Error(`Se esperaba un ${errorClass.name}.`);
    }
    expect(error.status).toBe(testCase.expected.status);
    expect(error.code).toBe(testCase.expected.code);
    expect(error.message).toBe(testCase.expected.message);
    // El 409 sale del claim: el draft SÍ llegó a createOrder (primera
    // escritura); los 404/400 salen antes y no escriben nada.
    const claimAttempted = testCase.expected.calls.includes(
      "orders.createOrder",
    );
    expect(fakes.createdDrafts).toHaveLength(claimAttempted ? 1 : 0);
    expect(fakes.appendedEvents).toEqual([]);
    expectCalls(fakes, testCase.expected.calls);
  });

  it.each(throwCases)("$name", async (testCase) => {
    const fakes = buildSubmitOrderFakes(testCase.seed);

    const error = await captureError(fakes, testCase.request, 1, null);

    if (!(error instanceof Error)) {
      throw new Error(`Se esperaba un Error, llegó ${String(error)}.`);
    }
    expect(error.message).toBe(testCase.message);
    // Los guards corren ANTES de la primera escritura: no hay orden ni evento.
    expect(fakes.createdDrafts).toEqual([]);
    expect(fakes.appendedEvents).toEqual([]);
  });
});
