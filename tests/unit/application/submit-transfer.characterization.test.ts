// Caracterización de submitTransfer (UC-5) con fakes en memoria de los tres
// ports que usa: orders, portfolioRead e instruments. Sin DB, sin Prisma, sin
// Express (el port de marketdata del fake compartido queda sin usar).
//
// Fija el comportamiento del contrato aprobado (D4): la transferencia NUEVA
// mueve el monto EXACTO en ARS, con centavos y sin floor (0.01 es válida), el
// draft CASH lleva `amountArs` (nunca acciones) y la metadata del evento lo
// audita como string canónico de 2 decimales. Por caso se asertan
// LITERALMENTE el draft que recibe createOrder, el evento con su metadata
// completa, la orden resultante y la LISTA ORDENADA de llamadas a ports (qué
// se lee, qué no se lee y que createOrder es la primera escritura).
//
// Dinero SIEMPRE Decimal desde string (AGENTS.md): ningún fixture usa float.

import { Decimal } from "decimal.js";
import type { SubmitOrderDeps } from "../../../src/application/orders/submit-order.js";
import { IdempotencyConflictError } from "../../../src/application/orders/persist-order-decision.js";
import {
  SubmitTransferError,
  submitTransfer,
} from "../../../src/application/transfers/submit-transfer.js";
import type {
  InstrumentRecord,
  OrderDraft,
  OrderEventMetadata,
  OrderEventType,
  OrderRecord,
  OrderRejectionReason,
  OrderStatus,
  RestingOrder,
  SettledOrderMovement,
  TransferSide,
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

/** MONEDA del cash: el seed la fija con id 66 (docs/database.md §2). */
const ARS: InstrumentRecord = {
  id: 66,
  ticker: "ARS",
  name: "Peso argentino",
  type: "MONEDA",
};

const PAMP: InstrumentRecord = {
  id: 1,
  ticker: "PAMP",
  name: "Pampa Holding S.A.",
  type: "ACCIONES",
};

const CASH_INSTRUMENT_ID = 66;

/** Movimiento FILLED de cash: monto exacto, sin acciones ni precio. */
const cashIn = (amountArs: string): SettledOrderMovement => ({
  side: "CASH_IN",
  amountArs: new Decimal(amountArs),
});

/** BUY NEW que reserva `sizeShares × limitPriceArs` de cash. */
const restingBuy = (
  instrumentId: number,
  sizeShares: number,
  limitPriceArs: string,
): RestingOrder => ({
  id: 1,
  instrumentId,
  side: "BUY",
  sizeShares,
  limitPriceArs: new Decimal(limitPriceArs),
});

// ---------------------------------------------------------------------------
// Secuencias de ports esperadas (literales)
// ---------------------------------------------------------------------------

/** CASH_IN: se decide sin leer fondos (ni movimientos ni reservas). */
const CALLS_BEFORE_FUNDS = [
  "orders.withUserTransaction(1)",
  "portfolioRead.userExists(1)",
  "instruments.findByTicker(ARS)",
  "orders.createOrder",
  "orders.appendOrderEvent",
] as const;

/** CASH_OUT: lee movimientos y reservas ANTES del claim. */
const CALLS_CASH_OUT = [
  "orders.withUserTransaction(1)",
  "portfolioRead.userExists(1)",
  "instruments.findByTicker(ARS)",
  "portfolioRead.listSettledMovements(1)",
  "portfolioRead.listRestingOrders(1)",
  "orders.createOrder",
  "orders.appendOrderEvent",
] as const;

/** REPLAY/CONFLICT: mismas lecturas, claim y SIN evento nuevo. */
const CALLS_CASH_OUT_NO_EVENT = CALLS_CASH_OUT.slice(0, -1);

// ---------------------------------------------------------------------------
// Forma de los casos
// ---------------------------------------------------------------------------

interface ExpectedOrder {
  readonly id: number;
  readonly status: OrderStatus;
  readonly amountArs: string;
  readonly filledPriceArs: string | null;
  readonly filledAt: "DATE" | null;
  readonly side: TransferSide;
}

interface ExpectedDraft {
  readonly status: OrderStatus;
  readonly amountArs: string;
  readonly filledPriceArs: string | null;
  readonly filledAt: "DATE" | null;
  readonly side: TransferSide;
  readonly idempotencyKey: string | null;
}

interface ExpectedEvent {
  readonly eventType: OrderEventType;
  readonly reason: OrderRejectionReason | null;
  readonly metadata: OrderEventMetadata;
}

interface PersistedCase {
  readonly name: string;
  readonly amountArs: string;
  readonly side: TransferSide;
  readonly seed: SubmitOrderFakeSeed;
  readonly userId?: number;
  readonly idempotencyKey?: string;
  readonly expected: {
    readonly order: ExpectedOrder;
    readonly reason: OrderRejectionReason | null;
    readonly draft: ExpectedDraft;
    readonly event: ExpectedEvent | null;
    readonly calls: readonly string[];
  };
}

interface ErrorCase {
  readonly name: string;
  readonly amountArs: string;
  readonly side: TransferSide;
  readonly seed: SubmitOrderFakeSeed;
  readonly userId?: number;
  readonly idempotencyKey?: string;
  /** Clase del 409 de idempotencia (compartida con el envío de órdenes). */
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
  readonly amountArs: string;
  readonly side: TransferSide;
  readonly seed: SubmitOrderFakeSeed;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Aserciones (valor monetario por toFixed, no por constructor de Decimal)
// ---------------------------------------------------------------------------

const decimalOf = (value: string): Decimal => new Decimal(value);

const expectDraft = (
  fakes: SubmitOrderFakes,
  expected: ExpectedDraft,
  userId: number,
): void => {
  expect(fakes.createdDrafts).toHaveLength(1);
  const draft = fakes.createdDrafts[0];
  if (draft === undefined) {
    throw new Error("createOrder no recibió ningún draft.");
  }
  if (draft.side === "BUY" || draft.side === "SELL") {
    throw new Error("Una transferencia no puede redactarse como trading.");
  }
  // Los precios/el monto se comparan por valor monetario exacto: el
  // constructor (Decimal del fixture vs FinancialDecimal del caso de uso) no
  // es parte del contrato.
  const {
    filledPriceArs,
    priceArs,
    filledAt,
    amountArs,
    requestFingerprint,
    ...draftRest
  } = draft;
  expect(draftRest).toEqual({
    userId,
    instrumentId: CASH_INSTRUMENT_ID,
    side: expected.side,
    type: "MARKET",
    timeInForce: "GTC",
    status: expected.status,
    idempotencyKey: expected.idempotencyKey,
    datetime: expect.any(Date),
  });
  // R-02: el pedido de cash SIEMPRE lleva huella del monto exacto (fpc1). Su
  // valor depende del instrumento resuelto: acá se caracteriza forma.
  expect(requestFingerprint).toMatch(/^fpc1:[0-9a-f]{32}$/);
  expect(draft).not.toHaveProperty("sizeShares");
  expect(amountArs.toFixed(2)).toBe(expected.amountArs);
  expect(priceArs?.toFixed(2)).toBe("1.00");
  expect(filledAt).toEqual(
    expected.filledAt === null ? null : expect.any(Date),
  );
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

const expectOrder = (order: OrderRecord, expected: ExpectedOrder): void => {
  expect(order.id).toBe(expected.id);
  expect(order.instrumentId).toBe(CASH_INSTRUMENT_ID);
  expect(order.side).toBe(expected.side);
  expect(order.type).toBe("MARKET");
  expect(order.timeInForce).toBe("GTC");
  expect(order.status).toBe(expected.status);
  if (order.side !== "CASH_IN" && order.side !== "CASH_OUT") {
    throw new Error("La fila persistida no es de cash.");
  }
  expect(order.amountArs.toFixed(2)).toBe(expected.amountArs);
  expect(order).not.toHaveProperty("sizeShares");
  expect(order.priceArs?.toFixed(2)).toBe("1.00");
  expect(
    order.filledPriceArs === null ? null : order.filledPriceArs.toFixed(2),
  ).toBe(expected.filledPriceArs);
  expect(order.filledAt).toEqual(
    expected.filledAt === null ? null : expect.any(Date),
  );
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
  testCase: ErrorCase,
): Promise<unknown> =>
  submitTransfer(fakes.deps, {
    userId: testCase.userId ?? 1,
    amountArs: decimalOf(testCase.amountArs),
    side: testCase.side,
    idempotencyKey: testCase.idempotencyKey ?? null,
  }).then(
    () => null,
    (reason: unknown) => reason,
  );

// ---------------------------------------------------------------------------
// Casos persistidos (201: FILLED / REJECTED)
// ---------------------------------------------------------------------------

const persistedCases: PersistedCase[] = [
  {
    name: "CASH_IN de 5000 ⇒ FILLED a 1.00 sin leer fondos",
    amountArs: "5000.00",
    side: "CASH_IN",
    seed: {
      instruments: [ARS],
      // Hay movimientos y reservas: el caso prueba que NO se leen.
      movements: [cashIn("10000.00")],
      restingOrders: [restingBuy(1, 10, "500.00")],
    },
    expected: {
      order: {
        id: 501,
        status: "FILLED",
        amountArs: "5000.00",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_IN",
      },
      reason: null,
      draft: {
        status: "FILLED",
        amountArs: "5000.00",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_IN",
        idempotencyKey: null,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: { ticker: "ARS", amountArs: "5000.00" },
      },
      calls: CALLS_BEFORE_FUNDS,
    },
  },
  {
    name: "CASH_IN de 100.75 ⇒ FILLED con el monto EXACTO (sin floor a 100)",
    amountArs: "100.75",
    side: "CASH_IN",
    seed: { instruments: [ARS] },
    expected: {
      order: {
        id: 501,
        status: "FILLED",
        amountArs: "100.75",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_IN",
      },
      reason: null,
      draft: {
        status: "FILLED",
        amountArs: "100.75",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_IN",
        idempotencyKey: null,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: { ticker: "ARS", amountArs: "100.75" },
      },
      calls: CALLS_BEFORE_FUNDS,
    },
  },
  {
    name: "CASH_IN de 0.01 ⇒ FILLED (D4: el centavo es un monto válido, no ZERO_SIZE)",
    amountArs: "0.01",
    side: "CASH_IN",
    seed: { instruments: [ARS] },
    expected: {
      order: {
        id: 501,
        status: "FILLED",
        amountArs: "0.01",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_IN",
      },
      reason: null,
      draft: {
        status: "FILLED",
        amountArs: "0.01",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_IN",
        idempotencyKey: null,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: { ticker: "ARS", amountArs: "0.01" },
      },
      calls: CALLS_BEFORE_FUNDS,
    },
  },
  {
    name: "CASH_IN del máximo D1 ⇒ FILLED con las 22 cifras enteras y los centavos",
    amountArs: "9999999999999999999999.99",
    side: "CASH_IN",
    seed: { instruments: [ARS] },
    expected: {
      order: {
        id: 501,
        status: "FILLED",
        amountArs: "9999999999999999999999.99",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_IN",
      },
      reason: null,
      draft: {
        status: "FILLED",
        amountArs: "9999999999999999999999.99",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_IN",
        idempotencyKey: null,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: {
          ticker: "ARS",
          amountArs: "9999999999999999999999.99",
        },
      },
      calls: CALLS_BEFORE_FUNDS,
    },
  },
  {
    name: "CASH_OUT con disponible suficiente ⇒ FILLED a 1.00",
    amountArs: "5000.00",
    side: "CASH_OUT",
    seed: { instruments: [ARS], movements: [cashIn("10000.00")] },
    expected: {
      order: {
        id: 501,
        status: "FILLED",
        amountArs: "5000.00",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_OUT",
      },
      reason: null,
      draft: {
        status: "FILLED",
        amountArs: "5000.00",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_OUT",
        idempotencyKey: null,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: { ticker: "ARS", amountArs: "5000.00" },
      },
      calls: CALLS_CASH_OUT,
    },
  },
  {
    name: "CASH_OUT de 123.45 sobre disponible entero ⇒ FILLED con los centavos exactos",
    amountArs: "123.45",
    side: "CASH_OUT",
    seed: { instruments: [ARS], movements: [cashIn("1000.00")] },
    expected: {
      order: {
        id: 501,
        status: "FILLED",
        amountArs: "123.45",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_OUT",
      },
      reason: null,
      draft: {
        status: "FILLED",
        amountArs: "123.45",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_OUT",
        idempotencyKey: null,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: { ticker: "ARS", amountArs: "123.45" },
      },
      calls: CALLS_CASH_OUT,
    },
  },
  {
    name: "CASH_OUT mayor al disponible ⇒ REJECTED INSUFFICIENT_FUNDS con el monto pedido exacto",
    amountArs: "5000.00",
    side: "CASH_OUT",
    seed: { instruments: [ARS], movements: [cashIn("1000.00")] },
    expected: {
      order: {
        id: 501,
        status: "REJECTED",
        amountArs: "5000.00",
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
      },
      reason: "INSUFFICIENT_FUNDS",
      draft: {
        status: "REJECTED",
        amountArs: "5000.00",
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
        idempotencyKey: null,
      },
      event: {
        eventType: "REJECTED",
        reason: "INSUFFICIENT_FUNDS",
        metadata: {
          ticker: "ARS",
          amountArs: "5000.00",
          requiredArs: "5000.00",
          cashAvailableArs: "1000.00",
        },
      },
      calls: CALLS_CASH_OUT,
    },
  },
  {
    name: "CASH_OUT con reservas previas: valida contra settled − reservas (627500)",
    amountArs: "630000.00",
    side: "CASH_OUT",
    seed: {
      instruments: [ARS],
      movements: [cashIn("753000.00")],
      restingOrders: [restingBuy(1, 500, "251.00")], // reserva 125500
    },
    expected: {
      order: {
        id: 501,
        status: "REJECTED",
        amountArs: "630000.00",
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
      },
      reason: "INSUFFICIENT_FUNDS",
      draft: {
        status: "REJECTED",
        amountArs: "630000.00",
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
        idempotencyKey: null,
      },
      event: {
        eventType: "REJECTED",
        reason: "INSUFFICIENT_FUNDS",
        metadata: {
          ticker: "ARS",
          amountArs: "630000.00",
          requiredArs: "630000.00",
          cashAvailableArs: "627500.00",
        },
      },
      calls: CALLS_CASH_OUT,
    },
  },
  {
    name: "CASH_OUT de EXACTAMENTE el disponible ⇒ FILLED (el límite es inclusivo)",
    amountArs: "5000.00",
    side: "CASH_OUT",
    seed: { instruments: [ARS], movements: [cashIn("5000.00")] },
    expected: {
      order: {
        id: 501,
        status: "FILLED",
        amountArs: "5000.00",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_OUT",
      },
      reason: null,
      draft: {
        status: "FILLED",
        amountArs: "5000.00",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_OUT",
        idempotencyKey: null,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: { ticker: "ARS", amountArs: "5000.00" },
      },
      calls: CALLS_CASH_OUT,
    },
  },
  {
    name: "CASH_OUT de un centavo MÁS que el disponible (5000.01 vs 5000.00) ⇒ REJECTED sin débito",
    amountArs: "5000.01",
    side: "CASH_OUT",
    seed: { instruments: [ARS], movements: [cashIn("5000.00")] },
    expected: {
      order: {
        id: 501,
        status: "REJECTED",
        amountArs: "5000.01",
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
      },
      reason: "INSUFFICIENT_FUNDS",
      draft: {
        status: "REJECTED",
        amountArs: "5000.01",
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
        idempotencyKey: null,
      },
      event: {
        eventType: "REJECTED",
        reason: "INSUFFICIENT_FUNDS",
        metadata: {
          ticker: "ARS",
          amountArs: "5000.01",
          requiredArs: "5000.01",
          cashAvailableArs: "5000.00",
        },
      },
      calls: CALLS_CASH_OUT,
    },
  },
  {
    name: "CASH_OUT de 0.50 ⇒ FILLED (D4: antes era ZERO_SIZE por el floor)",
    amountArs: "0.50",
    side: "CASH_OUT",
    seed: { instruments: [ARS], movements: [cashIn("10000.00")] },
    expected: {
      order: {
        id: 501,
        status: "FILLED",
        amountArs: "0.50",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_OUT",
      },
      reason: null,
      draft: {
        status: "FILLED",
        amountArs: "0.50",
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_OUT",
        idempotencyKey: null,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: { ticker: "ARS", amountArs: "0.50" },
      },
      calls: CALLS_CASH_OUT,
    },
  },
  {
    name: "REPLAY idempotente de un REJECTED ⇒ la orden original CON su razón original",
    amountArs: "5000.00",
    side: "CASH_OUT",
    seed: {
      instruments: [ARS],
      movements: [cashIn("1000.00")],
      createOutcome: "IDEMPOTENT_REPLAY",
      // D-05: la razón del original la lee el claim de order_events.
      replayReason: "INSUFFICIENT_FUNDS",
      existingOrder: {
        id: 900,
        instrumentId: CASH_INSTRUMENT_ID,
        userId: 1,
        side: "CASH_OUT",
        type: "MARKET",
        timeInForce: "GTC",
        status: "REJECTED",
        amountArs: new Decimal("5000.00"),
        priceArs: new Decimal("1.00"),
        filledPriceArs: null,
        filledAt: null,
        idempotencyKey: "idem-replay-cashout",
        datetime: new Date("2023-07-14T10:00:00.000Z"),
      },
    },
    idempotencyKey: "idem-replay-cashout",
    expected: {
      order: {
        id: 900,
        status: "REJECTED",
        amountArs: "5000.00",
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
      },
      reason: "INSUFFICIENT_FUNDS",
      draft: {
        status: "REJECTED",
        amountArs: "5000.00",
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
        idempotencyKey: "idem-replay-cashout",
      },
      event: null,
      calls: CALLS_CASH_OUT_NO_EVENT,
    },
  },
];

// ---------------------------------------------------------------------------
// Casos de error (404/409) y de seed corrupto
// ---------------------------------------------------------------------------

const errorCases: ErrorCase[] = [
  {
    name: "usuario inexistente ⇒ 404 USER_NOT_FOUND sin más lecturas",
    userId: 999,
    amountArs: "5000.00",
    side: "CASH_IN",
    seed: { userExists: false, instruments: [ARS] },
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
    name: "misma key con otro payload ⇒ 409 IDEMPOTENCY_CONFLICT sin evento",
    amountArs: "5000.00",
    side: "CASH_OUT",
    seed: {
      instruments: [ARS],
      movements: [cashIn("1000.00")],
      createOutcome: "IDEMPOTENT_CONFLICT",
      existingOrder: {
        id: 900,
        instrumentId: CASH_INSTRUMENT_ID,
        userId: 1,
        side: "CASH_OUT",
        type: "MARKET",
        timeInForce: "GTC",
        status: "REJECTED",
        amountArs: new Decimal("5000.00"),
        priceArs: new Decimal("1.00"),
        filledPriceArs: null,
        filledAt: null,
        idempotencyKey: "idem-conflicto",
        datetime: new Date("2023-07-14T10:00:00.000Z"),
      },
    },
    idempotencyKey: "idem-conflicto",
    errorClass: "IdempotencyConflictError",
    expected: {
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      message:
        "Idempotency-Key ya usada con otro payload (orden existente 900).",
      calls: CALLS_CASH_OUT_NO_EVENT,
    },
  },
];

const throwCases: ThrowCase[] = [
  {
    name: "instrumento del cash ausente ⇒ Error de seed corrupto antes de leer fondos",
    amountArs: "5000.00",
    side: "CASH_IN",
    seed: { instruments: [PAMP] },
    message: "No existe el instrumento del cash (ticker ARS): seed corrupto.",
  },
];

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

describe("submitTransfer — caracterización de la transferencia (UC-5)", () => {
  it.each(persistedCases)("$name", async (testCase) => {
    const fakes = buildSubmitOrderFakes(testCase.seed);
    const userId = testCase.userId ?? 1;

    const result = await submitTransfer(fakes.deps, {
      userId,
      amountArs: decimalOf(testCase.amountArs),
      side: testCase.side,
      idempotencyKey: testCase.idempotencyKey ?? null,
    });

    expect(result.reason).toBe(testCase.expected.reason);
    expectOrder(result.order, testCase.expected.order);
    expectDraft(fakes, testCase.expected.draft, userId);
    expectEvent(fakes, testCase.expected.event);
    expectCalls(fakes, testCase.expected.calls);
  });

  it.each(errorCases)("$name", async (testCase) => {
    const fakes = buildSubmitOrderFakes(testCase.seed);

    const error = await captureError(fakes, testCase);

    // El 409 de idempotencia es la clase COMPARTIDA (D-12); el resto de los
    // errores de aplicación siguen siendo SubmitTransferError.
    const errorClass =
      testCase.errorClass === "IdempotencyConflictError"
        ? IdempotencyConflictError
        : SubmitTransferError;
    expect(error).toBeInstanceOf(errorClass);
    if (!(error instanceof errorClass)) {
      throw new Error(`Se esperaba un ${errorClass.name}.`);
    }
    expect(error.status).toBe(testCase.expected.status);
    expect(error.code).toBe(testCase.expected.code);
    expect(error.message).toBe(testCase.expected.message);
    // El 409 sale del claim: el draft SÍ llegó a createOrder; el 404 sale
    // antes y no escribe nada.
    const claimAttempted = testCase.expected.calls.includes(
      "orders.createOrder",
    );
    expect(fakes.createdDrafts).toHaveLength(claimAttempted ? 1 : 0);
    expect(fakes.appendedEvents).toEqual([]);
    expectCalls(fakes, testCase.expected.calls);
  });

  it.each(throwCases)("$name", async (testCase) => {
    const fakes = buildSubmitOrderFakes(testCase.seed);

    const error = await submitTransfer(fakes.deps, {
      userId: 1,
      amountArs: decimalOf(testCase.amountArs),
      side: testCase.side,
      idempotencyKey: null,
    }).then(
      () => null,
      (reason: unknown) => reason,
    );

    if (!(error instanceof Error)) {
      throw new Error(`Se esperaba un Error, llegó ${String(error)}.`);
    }
    expect(error.message).toBe(testCase.message);
    // El guard corre ANTES de la primera escritura: no hay orden ni evento.
    expect(fakes.createdDrafts).toEqual([]);
    expect(fakes.appendedEvents).toEqual([]);
    expectCalls(fakes, [
      "orders.withUserTransaction(1)",
      "portfolioRead.userExists(1)",
      "instruments.findByTicker(ARS)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Los DOS instantes: `datetime` (hora de envío) se toma ANTES de leer los
// fondos; `filledAt` (sólo en un FILLED) se toma al DECIDIR, después de las
// dos lecturas. No son un solo `new Date()`.
//
// Con reloj falso (jest modern) cada lectura de port avanza el reloj 1000 ms
// al completarse: el instrumento del cash se lee en T0, los movimientos en
// T0+1000 y las reservas en T0+2000 ⇒ `datetime` queda en T0+1000 (antes de
// las lecturas de fondos) y `filledAt` en T0+3000.
// ---------------------------------------------------------------------------

const T0 = new Date("2023-07-14T10:00:00.000Z");

/** Milisegundos que cada lectura de port avanza el reloj falso al terminar. */
const READ_STEP_MS = 1000;

/** Instante esperado (valor escrito a mano): T0 + milisegundos. */
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

/**
 * Envuelve las tres lecturas de submitTransfer para que CADA una avance el
 * reloj falso 1000 ms al completarse: así `datetime` queda tomado tras
 * resolver el instrumento y antes de las lecturas de fondos, y `filledAt`
 * tras leer movimientos y reservas.
 */
const fakesWithClockReads = (seed: SubmitOrderFakeSeed): SubmitOrderFakes => {
  const fakes = buildSubmitOrderFakes(seed);
  const advanceClock = (): void => {
    jest.setSystemTime(new Date(Date.now() + READ_STEP_MS));
  };
  const deps: SubmitOrderDeps = {
    ...fakes.deps,
    instruments: {
      ...fakes.deps.instruments,
      findByTicker: async (ticker, tx) => {
        const instrument = await fakes.deps.instruments.findByTicker(
          ticker,
          tx,
        );
        advanceClock();
        return instrument;
      },
    },
    portfolioRead: {
      ...fakes.deps.portfolioRead,
      listSettledMovements: async (userId, tx) => {
        const movements = await fakes.deps.portfolioRead.listSettledMovements(
          userId,
          tx,
        );
        advanceClock();
        return movements;
      },
      listRestingOrders: async (userId, tx) => {
        const restingOrders = await fakes.deps.portfolioRead.listRestingOrders(
          userId,
          tx,
        );
        advanceClock();
        return restingOrders;
      },
    },
  };
  return { ...fakes, deps };
};

const createdDraft = (fakes: SubmitOrderFakes): OrderDraft => {
  expect(fakes.createdDrafts).toHaveLength(1);
  const created = fakes.createdDrafts[0];
  if (created === undefined) {
    throw new Error("createOrder no recibió ningún draft.");
  }
  return created;
};

describe("submitTransfer — los dos instantes de la transferencia (UC-5)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("CASH_OUT FILLED: datetime tras resolver el instrumento, filledAt tras leer los fondos", async () => {
    const fakes = fakesWithClockReads({
      instruments: [ARS],
      movements: [cashIn("10000.00")],
    });

    const result = await submitTransfer(fakes.deps, {
      userId: 1,
      amountArs: decimalOf("5000.00"),
      side: "CASH_OUT",
      idempotencyKey: null,
    });

    expect(result.order.status).toBe("FILLED");
    const created = createdDraft(fakes);
    // El instrumento se leyó en T0+1000: el envío se fecha ahí, ANTES de
    // que empiecen las lecturas de fondos (T0+1000 → T0+3000).
    expect(created.datetime).toEqual(at(READ_STEP_MS));
    expect(created.filledAt).toEqual(at(3 * READ_STEP_MS));
    if (created.filledAt === null) {
      throw new Error("La orden FILLED debe llevar filledAt.");
    }
    expect(created.filledAt.getTime()).toBeGreaterThan(
      created.datetime.getTime(),
    );
  });

  it("CASH_OUT REJECTED: filledAt nulo y datetime igualmente antes de las lecturas de fondos", async () => {
    const fakes = fakesWithClockReads({
      instruments: [ARS],
      movements: [cashIn("1000.00")],
    });

    const result = await submitTransfer(fakes.deps, {
      userId: 1,
      amountArs: decimalOf("5000.00"),
      side: "CASH_OUT",
      idempotencyKey: null,
    });

    expect(result.order.status).toBe("REJECTED");
    expect(result.reason).toBe("INSUFFICIENT_FUNDS");
    const created = createdDraft(fakes);
    expect(created.datetime).toEqual(at(READ_STEP_MS));
    expect(created.filledAt).toBeNull();
  });

  it("CASH_IN FILLED: sin lecturas de fondos, datetime y filledAt en el mismo instante", async () => {
    const fakes = fakesWithClockReads({ instruments: [ARS] });

    const result = await submitTransfer(fakes.deps, {
      userId: 1,
      amountArs: decimalOf("5000.00"),
      side: "CASH_IN",
      idempotencyKey: null,
    });

    expect(result.order.status).toBe("FILLED");
    const created = createdDraft(fakes);
    expect(created.datetime).toEqual(at(READ_STEP_MS));
    expect(created.filledAt).toEqual(at(READ_STEP_MS));
  });
});

// ---------------------------------------------------------------------------
// El instrumento del cash se resuelve DENTRO de la transacción: findByTicker
// recibe el MISMO tx que withUserTransaction. Sin tx, la lectura tomaría una
// SEGUNDA conexión del pool mientras la primera retiene el lock del usuario.
// ---------------------------------------------------------------------------

describe("submitTransfer — el instrumento del cash se lee en la tx (UC-5)", () => {
  it("findByTicker(ARS) recibe el MISMO tx de la transacción", async () => {
    const fakes = buildSubmitOrderFakes({ instruments: [ARS] });

    await submitTransfer(fakes.deps, {
      userId: 1,
      amountArs: decimalOf("5000.00"),
      side: "CASH_IN",
      idempotencyKey: null,
    });

    const cashLookup = fakes.calls.find(
      (call) => call.port === "instruments" && call.method === "findByTicker",
    );
    if (cashLookup === undefined) {
      throw new Error("submitTransfer no resolvió el instrumento del cash.");
    }
    expect(cashLookup.tx).toBeDefined();
    expect(cashLookup.tx).toBe(fakes.transaction);
  });
});
