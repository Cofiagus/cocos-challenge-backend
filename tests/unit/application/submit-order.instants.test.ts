// Los DOS instantes de submitOrder (UC-3): `datetime` (hora de envío) se toma
// después de resolver el precio de referencia y antes de decidir; `filledAt`
// (sólo en una orden FILLED) se toma al DECIDIR, después de leer los
// movimientos liquidados y las reservas. No son un solo `new Date()`.
//
// Con reloj falso (jest modern) cada lectura de port avanza el reloj 1000 ms
// al completarse, así los instantes quedan distinguibles: la vela se lee en
// T0, los movimientos en T0+1000 y las reservas en T0+2000 — `datetime` queda
// en T0+1000 cuando hubo snapshot (T0+0 en LIMIT GTC, que no lee vela) y
// `filledAt` en T0+3000 sólo si se decidió un FILLED.

import { Decimal } from "decimal.js";
import type { SubmitOrderDeps } from "../../../src/application/orders/submit-order.js";
import { submitOrder } from "../../../src/application/orders/submit-order.js";
import type {
  InstrumentRecord,
  MarketdataSnapshot,
  OrderDraft,
  SettledOrderMovement,
} from "../../../src/contracts/index.js";
import {
  buildSubmitOrderFakes,
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

const snapshot = (
  instrumentId: number,
  closeArs: string,
): MarketdataSnapshot => ({
  instrumentId,
  date: "2023-07-14",
  closeArs: new Decimal(closeArs),
  previousCloseArs: new Decimal(closeArs),
});

/** CASH_IN de 1.00 por unidad: sizeShares = pesos liquidados. */
const cashIn = (sizeShares: number): SettledOrderMovement => ({
  instrumentId: 66,
  side: "CASH_IN",
  sizeShares,
  priceArs: new Decimal("1.00"),
});

// ---------------------------------------------------------------------------
// Reloj falso: cada lectura de port completa 1000 ms después de la anterior
// ---------------------------------------------------------------------------

const T0 = new Date("2023-07-14T10:00:00.000Z");

/** Milisegundos que cada lectura de port avanza el reloj falso al terminar. */
const READ_STEP_MS = 1000;

/** Instante esperado (valor escrito a mano): T0 + milisegundos. */
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

/**
 * Envuelve las tres lecturas para que CADA una avance el reloj falso 1000 ms
 * al completarse: así `datetime` queda tomado tras la vela (y antes de las
 * lecturas de fondos) y `filledAt` tras leer movimientos y reservas.
 */
const fakesWithClockReads = (seed: SubmitOrderFakeSeed): SubmitOrderFakes => {
  const fakes = buildSubmitOrderFakes(seed);
  const advanceClock = (): void => {
    jest.setSystemTime(new Date(Date.now() + READ_STEP_MS));
  };
  const deps: SubmitOrderDeps = {
    ...fakes.deps,
    marketdata: {
      ...fakes.deps.marketdata,
      getLatestSnapshot: async (instrumentId, tx) => {
        const snapshotRead = await fakes.deps.marketdata.getLatestSnapshot(
          instrumentId,
          tx,
        );
        advanceClock();
        return snapshotRead;
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

const draft = (fakes: SubmitOrderFakes): OrderDraft => {
  expect(fakes.createdDrafts).toHaveLength(1);
  const created = fakes.createdDrafts[0];
  if (created === undefined) {
    throw new Error("createOrder no recibió ningún draft.");
  }
  return created;
};

const expectFilledAt = (
  fakes: SubmitOrderFakes,
  datetimeOffsetMs: number,
  filledAtOffsetMs: number,
): void => {
  const created = draft(fakes);
  expect(created.datetime).toEqual(at(datetimeOffsetMs));
  expect(created.filledAt).toEqual(at(filledAtOffsetMs));
  if (created.filledAt === null) {
    throw new Error("La orden FILLED debe llevar filledAt.");
  }
  // El fill se fecha al DECIDIR, estrictamente después de recibir el envío.
  expect(created.filledAt.getTime()).toBeGreaterThan(created.datetime.getTime());
};

// ---------------------------------------------------------------------------
// Ejecución: jest.useFakeTimers() (modern) fija el reloj en T0; cada test
// restaura el reloj real en afterEach.
// ---------------------------------------------------------------------------

describe("submitOrder — los dos instantes del envío (UC-3)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("MARKET BUY FILLED: datetime tras la vela, filledAt tras leer los fondos", async () => {
    const fakes = fakesWithClockReads({
      instruments: [PAMP],
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn(100_000)],
    });

    const result = await submitOrder(fakes.deps, {
      userId: 1,
      request: {
        instrumentId: 1,
        side: "BUY",
        type: "MARKET",
        timeInForce: "GTC",
        size: 3,
      },
      idempotencyKey: null,
    });

    expect(result.order.status).toBe("FILLED");
    expectFilledAt(fakes, READ_STEP_MS, 3 * READ_STEP_MS);
  });

  it("LIMIT IOC BUY que cruza (FILLED): los mismos dos instantes", async () => {
    const fakes = fakesWithClockReads({
      instruments: [PAMP],
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn(100_000)],
    });

    const result = await submitOrder(fakes.deps, {
      userId: 1,
      request: {
        instrumentId: 1,
        side: "BUY",
        type: "LIMIT",
        timeInForce: "IOC",
        size: 2,
        price: new Decimal("950.00"),
      },
      idempotencyKey: null,
    });

    expect(result.order.status).toBe("FILLED");
    expectFilledAt(fakes, READ_STEP_MS, 3 * READ_STEP_MS);
  });

  it("LIMIT GTC BUY (NEW, sin vela): datetime en T0+0 y filledAt nulo", async () => {
    const fakes = fakesWithClockReads({
      instruments: [PAMP],
      movements: [cashIn(100_000)],
    });

    const result = await submitOrder(fakes.deps, {
      userId: 1,
      request: {
        instrumentId: 1,
        side: "BUY",
        type: "LIMIT",
        timeInForce: "GTC",
        size: 1,
        price: new Decimal("210.00"),
      },
      idempotencyKey: null,
    });

    expect(result.order.status).toBe("NEW");
    const created = draft(fakes);
    // Sin snapshot el envío se fecha justo al llegar (T0 + 0).
    expect(created.datetime).toEqual(at(0));
    expect(created.filledAt).toBeNull();
  });

  it("MARKET BUY sin fondos (REJECTED): filledAt nulo y datetime tras la vela", async () => {
    const fakes = fakesWithClockReads({
      instruments: [PAMP],
      snapshot: snapshot(1, "925.85"),
      movements: [cashIn(1_000)],
    });

    const result = await submitOrder(fakes.deps, {
      userId: 1,
      request: {
        instrumentId: 1,
        side: "BUY",
        type: "MARKET",
        timeInForce: "GTC",
        size: 1000,
      },
      idempotencyKey: null,
    });

    expect(result.order.status).toBe("REJECTED");
    expect(result.reason).toBe("INSUFFICIENT_FUNDS");
    const created = draft(fakes);
    // La vela se leyó en T0+1000: el envío se fecha ahí, pero el REJECTED no
    // lleva fecha de fill (nunca se decidió).
    expect(created.datetime).toEqual(at(READ_STEP_MS));
    expect(created.filledAt).toBeNull();
  });
});
