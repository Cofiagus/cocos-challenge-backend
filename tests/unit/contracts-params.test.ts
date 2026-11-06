// Cotas de los IDs de borde (D-06): userId, orderId e instrumentId se
// persisten en columnas Int (INT4). Sin la cota, un id entre INT4+1 y 2^53−1
// pasa Zod y golpea Postgres (SQLSTATE 22003 / Prisma P2020) ⇒ 500; con la
// cota compartida el borde responde 400 antes de consultar.
//
// La cota es UNA sola definición (PositiveIntParamSchema, contracts/orders)
// usada por los tres params y por el instrumentId del body.

import {
  CancelOrderParamsSchema,
  CreateOrderParamsSchema,
  CreateOrderRequestSchema,
  MAX_INT4,
  PositiveIntParamSchema,
} from "../../src/contracts/orders.js";
import { PortfolioParamsSchema } from "../../src/contracts/portfolio.js";

/** ¿El valor pasa el schema? (400 del borde ⇔ safeParse falla). */
const accepts = (
  schema: { safeParse: (input: unknown) => { success: boolean } },
  input: unknown,
): boolean => schema.safeParse(input).success;

/** Body LIMIT BUY mínimo válido del que parten los casos. */
const validLimitOrder = {
  instrumentId: 1,
  side: "BUY",
  type: "LIMIT",
  size: 10,
  price: "100.00",
} as const;

describe("PositiveIntParamSchema — entero 1..INT4", () => {
  it("expone el máximo de INT4 (2^31−1)", () => {
    expect(MAX_INT4).toBe(2147483647);
  });

  it("acepta los bordes 1 y 2147483647 (params de ruta como string)", () => {
    expect(accepts(PositiveIntParamSchema, "1")).toBe(true);
    expect(accepts(PositiveIntParamSchema, "2147483647")).toBe(true);
  });

  it("rechaza 0, negativos, fracciones y no numéricos", () => {
    for (const value of ["0", "-1", "1.5", "abc", ""]) {
      expect(accepts(PositiveIntParamSchema, value)).toBe(false);
    }
  });

  it("rechaza INT4+1 y el entero seguro de JS (2^53−1)", () => {
    for (const value of ["2147483648", "9007199254740991"]) {
      expect(accepts(PositiveIntParamSchema, value)).toBe(false);
    }
  });
});

describe("params de ruta — userId/orderId acotados a INT4", () => {
  it("CreateOrderParamsSchema acepta 2147483647 y rechaza 2147483648", () => {
    expect(accepts(CreateOrderParamsSchema, { userId: "2147483647" })).toBe(true);
    expect(accepts(CreateOrderParamsSchema, { userId: "2147483648" })).toBe(false);
  });

  it("PortfolioParamsSchema acepta 2147483647 y rechaza 2147483648", () => {
    expect(accepts(PortfolioParamsSchema, { userId: "2147483647" })).toBe(true);
    expect(accepts(PortfolioParamsSchema, { userId: "2147483648" })).toBe(false);
  });

  it("CancelOrderParamsSchema acepta 2147483647 y rechaza 2147483648", () => {
    expect(accepts(CancelOrderParamsSchema, { orderId: "2147483647" })).toBe(true);
    expect(accepts(CancelOrderParamsSchema, { orderId: "2147483648" })).toBe(false);
  });

  it("los tres params siguen rechazando 0 y negativos", () => {
    expect(accepts(CreateOrderParamsSchema, { userId: "0" })).toBe(false);
    expect(accepts(PortfolioParamsSchema, { userId: "-1" })).toBe(false);
    expect(accepts(CancelOrderParamsSchema, { orderId: "0" })).toBe(false);
  });
});

describe("CreateOrderRequestSchema — instrumentId acotado a INT4", () => {
  it("acepta instrumentId = 2147483647", () => {
    expect(
      accepts(CreateOrderRequestSchema, {
        ...validLimitOrder,
        instrumentId: MAX_INT4,
      }),
    ).toBe(true);
  });

  it("rechaza instrumentId = 2147483648 antes de tocar la DB", () => {
    expect(
      accepts(CreateOrderRequestSchema, {
        ...validLimitOrder,
        instrumentId: MAX_INT4 + 1,
      }),
    ).toBe(false);
  });

  it("sigue rechazando instrumentId 0 y negativos", () => {
    for (const instrumentId of [0, -1]) {
      expect(
        accepts(CreateOrderRequestSchema, { ...validLimitOrder, instrumentId }),
      ).toBe(false);
    }
  });
});
