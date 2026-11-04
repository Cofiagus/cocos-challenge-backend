// Caracterización de submitTransfer (UC-5) con fakes en memoria de los tres
// ports que usa: orders, portfolioRead e instruments. Sin DB, sin Prisma, sin
// Express (el port de marketdata del fake compartido queda sin usar).
//
// Fija el comportamiento OBSERVADO del código actual para poder refactorizarlo
// sin cambiar el contrato: por caso se asertan LITERALMENTE el draft que
// recibe createOrder, el evento de auditoría con su metadata completa, la
// orden resultante y la LISTA ORDENADA de llamadas a ports (qué se lee, qué
// no se lee y que createOrder es la primera escritura). Los esperados son
// valores escritos a mano, nunca recalculados con la misma lógica del caso de
// uso.
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

/** Movimiento FILLED de cash a 1.00 por unidad: sizeShares = pesos. */
const cashIn = (sizeShares: number): SettledOrderMovement => ({
  instrumentId: CASH_INSTRUMENT_ID,
  side: "CASH_IN",
  sizeShares,
  priceArs: new Decimal("1.00"),
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

/** CASH_IN y ZERO_SIZE: se decide sin leer fondos (ni movimientos ni reservas). */
const CALLS_BEFORE_FUNDS = [
  "orders.withUserTransaction(1)",
  "portfolioRead.userExists(1)",
  "instruments.findByTicker(ARS)",
  "orders.createOrder",
  "orders.appendOrderEvent",
] as const;

/** CASH_OUT con size > 0: lee movimientos y reservas ANTES del claim. */
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
  readonly sizeShares: number | null;
  readonly filledPriceArs: string | null;
  readonly filledAt: "DATE" | null;
  readonly side: TransferSide;
}

interface ExpectedDraft {
  readonly status: OrderStatus;
  readonly sizeShares: number;
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
// Aserciones
// ---------------------------------------------------------------------------

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
  expect(draft).toEqual({
    userId,
    instrumentId: CASH_INSTRUMENT_ID,
    side: expected.side,
    type: "MARKET",
    timeInForce: "GTC",
    status: expected.status,
    sizeShares: expected.sizeShares,
    priceArs: new Decimal("1.00"),
    filledPriceArs:
      expected.filledPriceArs === null
        ? null
        : new Decimal(expected.filledPriceArs),
    filledAt: expected.filledAt === null ? null : expect.any(Date),
    idempotencyKey: expected.idempotencyKey,
    datetime: expect.any(Date),
  });
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
  expect(order.sizeShares).toBe(expected.sizeShares);
  expect(order.priceArs).toEqual(new Decimal("1.00"));
  expect(order.filledPriceArs).toEqual(
    expected.filledPriceArs === null
      ? null
      : new Decimal(expected.filledPriceArs),
  );
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
    amountArs: new Decimal(testCase.amountArs),
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
      movements: [cashIn(10_000)],
      restingOrders: [restingBuy(1, 10, "500.00")],
    },
    expected: {
      order: {
        id: 501,
        status: "FILLED",
        sizeShares: 5000,
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_IN",
      },
      reason: null,
      draft: {
        status: "FILLED",
        sizeShares: 5000,
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
          amountArs: "5000.00",
          residualArs: "0.00",
        },
      },
      calls: CALLS_BEFORE_FUNDS,
    },
  },
  {
    name: "CASH_IN con monto fraccionario ⇒ size 100 y residuo 0.75 en la metadata",
    amountArs: "100.75",
    side: "CASH_IN",
    seed: { instruments: [ARS] },
    expected: {
      order: {
        id: 501,
        status: "FILLED",
        sizeShares: 100,
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_IN",
      },
      reason: null,
      draft: {
        status: "FILLED",
        sizeShares: 100,
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
          amountArs: "100.75",
          residualArs: "0.75",
        },
      },
      calls: CALLS_BEFORE_FUNDS,
    },
  },
  {
    name: "CASH_OUT con disponible suficiente ⇒ FILLED a 1.00",
    amountArs: "5000.00",
    side: "CASH_OUT",
    seed: { instruments: [ARS], movements: [cashIn(10_000)] },
    expected: {
      order: {
        id: 501,
        status: "FILLED",
        sizeShares: 5000,
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_OUT",
      },
      reason: null,
      draft: {
        status: "FILLED",
        sizeShares: 5000,
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_OUT",
        idempotencyKey: null,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: {
          ticker: "ARS",
          amountArs: "5000.00",
          residualArs: "0.00",
        },
      },
      calls: CALLS_CASH_OUT,
    },
  },
  {
    name: "CASH_OUT mayor al disponible ⇒ REJECTED INSUFFICIENT_FUNDS con requerido y disponible",
    amountArs: "5000.00",
    side: "CASH_OUT",
    seed: { instruments: [ARS], movements: [cashIn(1_000)] },
    expected: {
      order: {
        id: 501,
        status: "REJECTED",
        sizeShares: 5000,
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
      },
      reason: "INSUFFICIENT_FUNDS",
      draft: {
        status: "REJECTED",
        sizeShares: 5000,
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
          residualArs: "0.00",
          requiredArs: "5000.00",
          cashAvailableArs: "1000.00",
        },
      },
      calls: CALLS_CASH_OUT,
    },
  },
  {
    name: "CASH_OUT con reservas previas: valida contra settled − reservas (627500), no contra el settled",
    amountArs: "630000.00",
    side: "CASH_OUT",
    seed: {
      instruments: [ARS],
      movements: [cashIn(753_000)],
      restingOrders: [restingBuy(1, 500, "251.00")], // reserva 125500
    },
    expected: {
      order: {
        id: 501,
        status: "REJECTED",
        sizeShares: 630_000,
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
      },
      reason: "INSUFFICIENT_FUNDS",
      draft: {
        status: "REJECTED",
        sizeShares: 630_000,
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
          residualArs: "0.00",
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
    seed: { instruments: [ARS], movements: [cashIn(5_000)] },
    expected: {
      order: {
        id: 501,
        status: "FILLED",
        sizeShares: 5000,
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_OUT",
      },
      reason: null,
      draft: {
        status: "FILLED",
        sizeShares: 5000,
        filledPriceArs: "1.00",
        filledAt: "DATE",
        side: "CASH_OUT",
        idempotencyKey: null,
      },
      event: {
        eventType: "ACCEPTED",
        reason: null,
        metadata: {
          ticker: "ARS",
          amountArs: "5000.00",
          residualArs: "0.00",
        },
      },
      calls: CALLS_CASH_OUT,
    },
  },
  {
    name: "CASH_OUT de un centavo MÁS que el disponible (4999.99) ⇒ REJECTED (el size floor-ea a 5000)",
    amountArs: "5000.00",
    side: "CASH_OUT",
    seed: {
      instruments: [ARS],
      movements: [cashIn(5_000)],
      restingOrders: [restingBuy(1, 1, "0.01")], // reserva 0.01 ⇒ disponible 4999.99
    },
    expected: {
      order: {
        id: 501,
        status: "REJECTED",
        sizeShares: 5000,
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
      },
      reason: "INSUFFICIENT_FUNDS",
      draft: {
        status: "REJECTED",
        sizeShares: 5000,
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
          residualArs: "0.00",
          requiredArs: "5000.00",
          cashAvailableArs: "4999.99",
        },
      },
      calls: CALLS_CASH_OUT,
    },
  },
  {
    name: "CASH_OUT de menos de 1 peso ⇒ REJECTED ZERO_SIZE sin leer fondos",
    amountArs: "0.50",
    side: "CASH_OUT",
    seed: { instruments: [ARS], movements: [cashIn(10_000)] },
    expected: {
      order: {
        id: 501,
        status: "REJECTED",
        sizeShares: 0,
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
      },
      reason: "ZERO_SIZE",
      draft: {
        status: "REJECTED",
        sizeShares: 0,
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
        idempotencyKey: null,
      },
      event: {
        eventType: "REJECTED",
        reason: "ZERO_SIZE",
        metadata: {
          ticker: "ARS",
          amountArs: "0.50",
          residualArs: "0.50",
        },
      },
      calls: CALLS_BEFORE_FUNDS,
    },
  },
  {
    name: "REPLAY idempotente de un REJECTED ⇒ la orden original, reason null y sin evento",
    amountArs: "5000.00",
    side: "CASH_OUT",
    seed: {
      instruments: [ARS],
      movements: [cashIn(1_000)],
      createOutcome: "IDEMPOTENT_REPLAY",
      existingOrder: {
        id: 900,
        instrumentId: CASH_INSTRUMENT_ID,
        userId: 1,
        side: "CASH_OUT",
        type: "MARKET",
        timeInForce: "GTC",
        status: "REJECTED",
        sizeShares: 5000,
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
        sizeShares: 5000,
        filledPriceArs: null,
        filledAt: null,
        side: "CASH_OUT",
      },
      reason: null,
      draft: {
        status: "REJECTED",
        sizeShares: 5000,
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
      movements: [cashIn(1_000)],
      createOutcome: "IDEMPOTENT_CONFLICT",
      existingOrder: {
        id: 900,
        instrumentId: CASH_INSTRUMENT_ID,
        userId: 1,
        side: "CASH_OUT",
        type: "MARKET",
        timeInForce: "GTC",
        status: "REJECTED",
        sizeShares: 5000,
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
      amountArs: new Decimal(testCase.amountArs),
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
      amountArs: new Decimal(testCase.amountArs),
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

const createdDraft = (fakes: SubmitOrderFakes): OrderRecord => {
  expect(fakes.createdDrafts).toHaveLength(1);
  const created = fakes.createdDrafts[0];
  if (created === undefined) {
    throw new Error("createOrder no recibió ningún draft.");
  }
  return {
    id: 501,
    instrumentId: created.instrumentId,
    userId: created.userId,
    side: created.side,
    type: created.type,
    timeInForce: created.timeInForce,
    status: created.status,
    sizeShares: created.sizeShares,
    priceArs: created.priceArs,
    filledPriceArs: created.filledPriceArs,
    filledAt: created.filledAt,
    idempotencyKey: created.idempotencyKey,
    datetime: created.datetime,
  };
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
      movements: [cashIn(10_000)],
    });

    const result = await submitTransfer(fakes.deps, {
      userId: 1,
      amountArs: new Decimal("5000.00"),
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
      movements: [cashIn(1_000)],
    });

    const result = await submitTransfer(fakes.deps, {
      userId: 1,
      amountArs: new Decimal("5000.00"),
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
      amountArs: new Decimal("5000.00"),
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
      amountArs: new Decimal("5000.00"),
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
