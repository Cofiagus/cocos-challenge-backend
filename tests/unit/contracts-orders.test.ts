// Contrato de POST /orders: cotas del borde que, si faltan, llegan como 500
// del INSERT en vez de 400 del contrato. Cubre:
//  - `size` ≤ INTEGER (INT4) de Postgres — un valor mayor explota en el INSERT;
//  - `price: null` en MARKET = "sin precio" (el enunciado no lo exige), sin
//    relajar LIMIT (que sigue necesitando un precio > 0) ni permitir precio
//    numérico en MARKET.

import {
  CreateOrderRequestSchema,
  MAX_ORDER_SIZE_SHARES,
} from "../../src/contracts/orders.js";

/** Body LIMIT BUY válido del que parten los casos. */
const validLimitOrder = {
  instrumentId: 1,
  side: "BUY",
  type: "LIMIT",
  size: 10,
  price: "100.00",
} as const;

/** Paths de los issues de Zod (vacío si el body es válido). */
const rejectionPaths = (input: unknown): readonly string[] => {
  const result = CreateOrderRequestSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
};

describe("CreateOrderRequestSchema — cota de size al rango INTEGER", () => {
  it("expone la cota como 2^31−1 (máximo de INT4)", () => {
    expect(MAX_ORDER_SIZE_SHARES).toBe(2147483647);
  });

  it("acepta size = 2147483647 (borde superior de INT4)", () => {
    const result = CreateOrderRequestSchema.safeParse({
      ...validLimitOrder,
      size: MAX_ORDER_SIZE_SHARES,
    });
    expect(result.success).toBe(true);
    expect(result.success ? result.data.size : undefined).toBe(2147483647);
  });

  it("rechaza size = 2147483648 antes de tocar la DB", () => {
    expect(
      rejectionPaths({ ...validLimitOrder, size: MAX_ORDER_SIZE_SHARES + 1 }),
    ).toContain("size");
  });

  it("sigue rechazando size 0 y negativos (la cota no relaja la positividad)", () => {
    for (const size of [0, -1, -2147483648]) {
      expect(rejectionPaths({ ...validLimitOrder, size })).toContain("size");
    }
  });
});

describe("CreateOrderRequestSchema — sigue siendo sólo trading", () => {
  it("rechaza CASH_IN/CASH_OUT: las transferencias van por su ruta", () => {
    for (const side of ["CASH_IN", "CASH_OUT"]) {
      expect(rejectionPaths({ ...validLimitOrder, side })).toContain("side");
    }
  });
});

describe("CreateOrderRequestSchema — price null en MARKET", () => {
  it("acepta MARKET con price: null como 'sin precio'", () => {
    const result = CreateOrderRequestSchema.safeParse({
      ...validLimitOrder,
      type: "MARKET",
      price: null,
    });
    expect(result.success).toBe(true);
    expect(result.success ? result.data.price : undefined).toBeNull();
  });

  it("acepta MARKET sin price (campo ausente)", () => {
    const marketOrderWithoutPrice = {
      instrumentId: validLimitOrder.instrumentId,
      side: validLimitOrder.side,
      type: "MARKET",
      size: validLimitOrder.size,
    };
    expect(CreateOrderRequestSchema.safeParse(marketOrderWithoutPrice).success).toBe(true);
  });

  it("sigue rechazando MARKET con price numérico o string", () => {
    for (const price of [100, "100.00"]) {
      expect(
        rejectionPaths({ ...validLimitOrder, type: "MARKET", price }),
      ).toContain("price");
    }
  });

  it("sigue rechazando LIMIT con price: null (LIMIT requiere precio)", () => {
    expect(rejectionPaths({ ...validLimitOrder, price: null })).toContain("price");
  });

  it("sigue rechazando LIMIT con price: 0 (positividad intacta)", () => {
    expect(rejectionPaths({ ...validLimitOrder, price: 0 })).toContain("price");
  });
});
