// persistOrderDecision: la persistencia compartida por el envío de órdenes y
// las transferencias de cash. Sin DB: el OrderRepository es el fake en
// memoria que registra cada llamada con su tx.
//
// Fija las tres salidas del claim idempotente (CREATED / REPLAY / CONFLICT),
// el orden de las escrituras (createOrder SIEMPRE primero) y que el evento de
// auditoría va en la MISMA transacción.

import { Decimal } from "decimal.js";
import {
  IdempotencyConflictError,
  persistOrderDecision,
  type OrderDraftBase,
} from "../../../src/application/orders/persist-order-decision.js";
import type { DecidedOrder } from "../../../src/application/orders/decide-order.js";
import type { OrderRecord } from "../../../src/contracts/index.js";
import {
  buildSubmitOrderFakes,
  callLabels,
  type SubmitOrderFakeSeed,
  type SubmitOrderFakes,
} from "../../helpers/fakes/submit-order-fakes.js";

const DATETIME = new Date("2023-07-14T10:00:00.000Z");
const FILLED_AT = new Date("2023-07-14T10:00:01.000Z");

const BASE: OrderDraftBase = {
  userId: 1,
  instrumentId: 1,
  side: "BUY",
  type: "MARKET",
  timeInForce: "GTC",
  priceArs: null,
  idempotencyKey: "idem-1",
  datetime: DATETIME,
};

const FILLED: DecidedOrder = {
  status: "FILLED",
  sizeShares: 3,
  filledPriceArs: new Decimal("925.85"),
  filledAt: FILLED_AT,
  eventType: "ACCEPTED",
  reason: null,
  metadata: { ticker: "PAMP", referencePriceArs: "925.85" },
};

const REJECTED: DecidedOrder = {
  status: "REJECTED",
  sizeShares: 3,
  filledPriceArs: null,
  filledAt: null,
  eventType: "REJECTED",
  reason: "INSUFFICIENT_FUNDS",
  metadata: { ticker: "PAMP", requiredCostArs: "2777.55" },
};

const EXISTING_ORDER: OrderRecord = {
  id: 900,
  instrumentId: 1,
  userId: 1,
  side: "BUY",
  type: "MARKET",
  timeInForce: "GTC",
  status: "FILLED",
  sizeShares: 3,
  priceArs: null,
  filledPriceArs: new Decimal("925.85"),
  filledAt: FILLED_AT,
  idempotencyKey: "idem-1",
  datetime: DATETIME,
};

const fakesFor = (seed: SubmitOrderFakeSeed): SubmitOrderFakes =>
  buildSubmitOrderFakes(seed);

/** Todas las llamadas que recibieron tx la recibieron de la MISMA transacción. */
const expectSameTransaction = (fakes: SubmitOrderFakes): void => {
  const callsWithTx = fakes.calls.filter((call) => call.tx !== undefined);
  expect(callsWithTx.length).toBeGreaterThan(0);
  expect(callsWithTx.every((call) => call.tx === fakes.transaction)).toBe(true);
};

describe("persistOrderDecision — claim idempotente y auditoría", () => {
  it("CREATED: persiste el draft completo y agrega el evento en la misma tx", async () => {
    const fakes = fakesFor({});

    const result = await persistOrderDecision(
      fakes.deps.orders,
      fakes.transaction,
      FILLED,
      BASE,
    );

    expect(fakes.createdDrafts).toEqual([
      {
        ...BASE,
        status: "FILLED",
        sizeShares: 3,
        filledPriceArs: new Decimal("925.85"),
        filledAt: FILLED_AT,
      },
    ]);
    expect(fakes.appendedEvents).toEqual([
      {
        orderId: 501,
        eventType: "ACCEPTED",
        reason: null,
        metadata: { ticker: "PAMP", referencePriceArs: "925.85" },
      },
    ]);
    expect(result.order.id).toBe(501);
    expect(result.order.status).toBe("FILLED");
    expect(result.reason).toBeNull();
    // createOrder es la PRIMERA escritura; el evento va después.
    expect(callLabels(fakes.calls)).toEqual([
      "orders.createOrder",
      "orders.appendOrderEvent",
    ]);
    expectSameTransaction(fakes);
  });

  it("CREATED de un REJECTED: devuelve la razón decidida y la audita", async () => {
    const fakes = fakesFor({});

    const result = await persistOrderDecision(
      fakes.deps.orders,
      fakes.transaction,
      REJECTED,
      BASE,
    );

    expect(result.reason).toBe("INSUFFICIENT_FUNDS");
    expect(fakes.appendedEvents).toEqual([
      {
        orderId: 501,
        eventType: "REJECTED",
        reason: "INSUFFICIENT_FUNDS",
        metadata: { ticker: "PAMP", requiredCostArs: "2777.55" },
      },
    ]);
    expectSameTransaction(fakes);
  });

  it("REPLAY: devuelve la orden ORIGINAL con reason null y sin evento", async () => {
    const fakes = fakesFor({
      createOutcome: "IDEMPOTENT_REPLAY",
      existingOrder: EXISTING_ORDER,
    });

    const result = await persistOrderDecision(
      fakes.deps.orders,
      fakes.transaction,
      FILLED,
      BASE,
    );

    expect(result.order).toBe(EXISTING_ORDER);
    expect(result.reason).toBeNull();
    expect(fakes.appendedEvents).toEqual([]);
    expect(callLabels(fakes.calls)).toEqual(["orders.createOrder"]);
    expectSameTransaction(fakes);
  });

  it("CONFLICT: lanza IdempotencyConflictError (409) sin evento", async () => {
    const fakes = fakesFor({
      createOutcome: "IDEMPOTENT_CONFLICT",
      existingOrder: EXISTING_ORDER,
    });

    const error = await persistOrderDecision(
      fakes.deps.orders,
      fakes.transaction,
      FILLED,
      BASE,
    ).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(IdempotencyConflictError);
    if (!(error instanceof IdempotencyConflictError)) {
      throw new Error("Se esperaba un IdempotencyConflictError.");
    }
    expect(error.name).toBe("IdempotencyConflictError");
    expect(error.status).toBe(409);
    expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(error.message).toBe(
      "Idempotency-Key ya usada con otro payload (orden existente 900).",
    );
    expect(fakes.appendedEvents).toEqual([]);
    expect(callLabels(fakes.calls)).toEqual(["orders.createOrder"]);
    expectSameTransaction(fakes);
  });
});
