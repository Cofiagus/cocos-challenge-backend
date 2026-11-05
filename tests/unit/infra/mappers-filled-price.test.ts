// Mappers de infra (sin DB) — T5 de specs/datos-financieros-grandes-montos.md.
//
//  - Precio de ejecución de la proyección FILLED: `filledPrice ?? price`; AMBOS
//    NULL es corrupción, no se normaliza en silencio.
//  - `size` discriminado (D2): BUY/SELL → number entero SÓLO tras validar
//    finitud/integralidad/INT4; CASH_* → FinancialDecimal exacto (sin Number).
//  - NULL donde el contrato exige valor, 0 fuera de REJECTED y unidades cash
//    incompatibles fallan ruidosamente con CorruptRowError.

import { Prisma, type Order } from "@prisma/client";
import { CorruptRowError } from "../../../src/infra/prisma/corrupt-row.error.js";
import {
  mapOrderRow,
  mapRestingOrderRow,
  mapSettledMovementRow,
} from "../../../src/infra/prisma/mappers.js";
import type {
  CashOrderRecord,
  OrderRecord,
  TradingOrderRecord,
} from "../../../src/contracts/index.js";

const decimalOrNull = (value: string | null): Prisma.Decimal | null =>
  value === null ? null : new Prisma.Decimal(value);

interface OrderRowOverrides {
  readonly size?: string | null;
  readonly side?: Order["side"];
  readonly status?: Order["status"];
  readonly price?: string | null;
  readonly filledPrice?: string | null;
}

/** Fila de orders mínima y tipada con la columna Decimal del schema nuevo. */
const orderRow = (overrides: OrderRowOverrides = {}): Order => ({
  id: 1,
  instrumentId: 47,
  userId: 1,
  size: decimalOrNull(overrides.size === undefined ? "10" : overrides.size),
  price: decimalOrNull(overrides.price === undefined ? "1502.80" : overrides.price),
  type: "LIMIT",
  side: overrides.side === undefined ? "BUY" : overrides.side,
  status: overrides.status === undefined ? "FILLED" : overrides.status,
  datetime: new Date("2023-07-14T00:00:00.000Z"),
  timeInForce: "GTC",
  filledPrice: decimalOrNull(
    overrides.filledPrice === undefined ? null : overrides.filledPrice,
  ),
  filledAt: new Date("2023-07-14T00:00:00.000Z"),
  idempotencyKey: null,
});

const asTrading = (order: OrderRecord): TradingOrderRecord => {
  if (order.side !== "BUY" && order.side !== "SELL") {
    throw new Error(`esperaba trading, llegó ${order.side}`);
  }
  return order;
};

const asCash = (order: OrderRecord): CashOrderRecord => {
  if (order.side !== "CASH_IN" && order.side !== "CASH_OUT") {
    throw new Error(`esperaba cash, llegó ${order.side}`);
  }
  return order;
};

describe("mapSettledMovementRow — precio de ejecución", () => {
  it("filledPrice con price NULL: usa filledPrice", () => {
    const movement = mapSettledMovementRow(orderRow({ price: null, filledPrice: "1502.80" }));
    if (movement.side !== "BUY" && movement.side !== "SELL") {
      throw new Error("movimiento de trading esperado");
    }
    expect(movement.priceArs.toFixed(2)).toBe("1502.80");
  });

  it("filledPrice NULL con price: usa price (FILLED heredada del dataset)", () => {
    const movement = mapSettledMovementRow(orderRow({ price: "1502.80", filledPrice: null }));
    if (movement.side !== "BUY" && movement.side !== "SELL") {
      throw new Error("movimiento de trading esperado");
    }
    expect(movement.priceArs.toFixed(2)).toBe("1502.80");
  });

  it("ambos NULL: falla fuerte con CorruptRowError", () => {
    expect(() =>
      mapSettledMovementRow(orderRow({ price: null, filledPrice: null })),
    ).toThrow(CorruptRowError);
    expect(() =>
      mapSettledMovementRow(orderRow({ price: null, filledPrice: null })),
    ).toThrow(/orders\(FILLED\)\.filledPrice\|price/);
  });

  it("ambos con valor: gana filledPrice (la ejecución, no el límite)", () => {
    const movement = mapSettledMovementRow(
      orderRow({ price: "999.00", filledPrice: "1502.80" }),
    );
    if (movement.side !== "BUY" && movement.side !== "SELL") {
      throw new Error("movimiento de trading esperado");
    }
    expect(movement.priceArs.toFixed(2)).toBe("1502.80");
  });
});

describe("mapSettledMovementRow — size discriminado por side (D2)", () => {
  it("BUY entero: sizeShares number (no Decimal)", () => {
    const movement = mapSettledMovementRow(orderRow({ size: "10" }));
    if (movement.side !== "BUY" && movement.side !== "SELL") {
      throw new Error("movimiento de trading esperado");
    }
    expect(movement.sizeShares).toBe(10);
    expect(typeof movement.sizeShares).toBe("number");
  });

  it("BUY máximo INT4: acepta 2147483647", () => {
    const movement = mapSettledMovementRow(orderRow({ size: "2147483647" }));
    if (movement.side !== "BUY" && movement.side !== "SELL") {
      throw new Error("movimiento de trading esperado");
    }
    expect(movement.sizeShares).toBe(2147483647);
  });

  it.each(["10.5", "2147483648", "-1"])(
    "BUY con size %s fuera de entero/INT4 ⇒ CorruptRowError",
    (size) => {
      expect(() => mapSettledMovementRow(orderRow({ size }))).toThrow(CorruptRowError);
    },
  );

  it("CASH conserva el monto máximo EXACTO como Decimal (nunca Number)", () => {
    const max = "9999999999999999999999.99";
    const movement = mapSettledMovementRow(
      orderRow({ side: "CASH_IN", size: max, price: "1.00" }),
    );
    if (movement.side !== "CASH_IN" && movement.side !== "CASH_OUT") {
      throw new Error("movimiento cash esperado");
    }
    expect(movement.amountArs.toFixed(2)).toBe(max);
    expect("sizeShares" in movement).toBe(false);
  });

  it("CASH size 123 histórico se expone 123.00 sin reescribir la columna", () => {
    const movement = mapSettledMovementRow(
      orderRow({ side: "CASH_OUT", size: "123", price: "1.00" }),
    );
    if (movement.side !== "CASH_IN" && movement.side !== "CASH_OUT") {
      throw new Error("movimiento cash esperado");
    }
    expect(movement.amountArs.toFixed(2)).toBe("123.00");
  });

  it.each([
    ["size NULL", { side: "CASH_IN" as const, size: null, price: "1.00" }],
    ["size 0 FILLED", { side: "CASH_IN" as const, size: "0", price: "1.00" }],
    ["price NULL (unidad ausente)", { side: "CASH_IN" as const, size: "10", price: null }],
    ["price distinto de 1.00", { side: "CASH_IN" as const, size: "10", price: "2.00" }],
  ])("CASH con %s ⇒ CorruptRowError", (_label, overrides) => {
    expect(() => mapSettledMovementRow(orderRow(overrides))).toThrow(CorruptRowError);
  });
});

describe("mapOrderRow — fila completa discriminada", () => {
  it("BUY convierte size Decimal a number entero", () => {
    const order = asTrading(mapOrderRow(orderRow({ size: "25" })));
    expect(order.sizeShares).toBe(25);
  });

  it("CASH expone amountArs Decimal exacto (sin Number)", () => {
    const order = asCash(
      mapOrderRow(orderRow({ side: "CASH_IN", size: "123.45", price: "1.00" })),
    );
    expect(order.amountArs.toFixed(2)).toBe("123.45");
    expect("sizeShares" in order).toBe(false);
  });

  it("CASH ZERO_SIZE histórico REJECTED se mapea 0.00", () => {
    const order = asCash(
      mapOrderRow(
        orderRow({ side: "CASH_OUT", size: "0", status: "REJECTED", price: "1.00" }),
      ),
    );
    expect(order.amountArs.toFixed(2)).toBe("0.00");
  });

  it("trading ZERO_SIZE REJECTED conserva 0", () => {
    const order = asTrading(
      mapOrderRow(orderRow({ size: "0", status: "REJECTED", price: "10.00" })),
    );
    expect(order.sizeShares).toBe(0);
  });

  it.each([
    ["trading size 0 fuera de REJECTED", { size: "0", status: "FILLED" as const }],
    ["cash size 0 fuera de REJECTED", { side: "CASH_IN" as const, size: "0" }],
    ["cash size NULL", { side: "CASH_IN" as const, size: null }],
    ["trading size fraccionario", { size: "10.5" }],
    ["trading size fuera de INT4", { size: "2147483648" }],
  ])("%s ⇒ CorruptRowError", (_label, overrides) => {
    expect(() => mapOrderRow(orderRow(overrides))).toThrow(CorruptRowError);
  });
});

describe("mapRestingOrderRow — acciones enteras", () => {
  it("NEW BUY: sizeShares number y límite Decimal", () => {
    const resting = mapRestingOrderRow(
      orderRow({ side: "BUY", status: "NEW", size: "50", price: "710.00" }),
    );
    expect(resting.sizeShares).toBe(50);
    expect(resting.limitPriceArs.toFixed(2)).toBe("710.00");
  });

  it("NEW con size Decimal fraccionario ⇒ CorruptRowError", () => {
    expect(() =>
      mapRestingOrderRow(orderRow({ status: "NEW", size: "10.5" })),
    ).toThrow(CorruptRowError);
  });
});
