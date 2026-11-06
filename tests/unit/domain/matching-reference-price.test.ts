// D-07 — precio de referencia estrictamente positivo: con ref 0.00 (o
// negativa) evaluateCross/matchRestingOrders NO pueden devolver un fill a
// 0.00. La precondición del dominio es dura (RangeError); la capa de
// aplicación la convierte en REJECTED NO_PRICE antes de llegar acá.

import {
  evaluateCross,
  matchRestingOrders,
} from "../../../src/domain/matching/index.js";
import { FinancialDecimal } from "../../../src/contracts/index.js";
import { buildRestingOrder } from "./helpers.js";

const INVALID_REFERENCE_MESSAGE =
  "Precio de referencia inválido: debe ser mayor a 0 (no se llena a 0.00).";

describe("evaluateCross — referencia 0.00 nunca llena a 0.00", () => {
  it("IOC BUY con ref 0.00 ⇒ RangeError (no FILLED a 0.00)", () => {
    expect(() =>
      evaluateCross({
        side: "BUY",
        timeInForce: "IOC",
        limitPriceArs: new FinancialDecimal("100.00"),
        referencePriceArs: new FinancialDecimal("0.00"),
      }),
    ).toThrow(INVALID_REFERENCE_MESSAGE);
  });

  it("IOC SELL con ref 0.00 ⇒ RangeError", () => {
    expect(() =>
      evaluateCross({
        side: "SELL",
        timeInForce: "IOC",
        limitPriceArs: new FinancialDecimal("100.00"),
        referencePriceArs: new FinancialDecimal("0.00"),
      }),
    ).toThrow(INVALID_REFERENCE_MESSAGE);
  });

  it("FOK con referencia negativa ⇒ RangeError", () => {
    expect(() =>
      evaluateCross({
        side: "BUY",
        timeInForce: "FOK",
        limitPriceArs: new FinancialDecimal("100.00"),
        referencePriceArs: new FinancialDecimal("-1.00"),
      }),
    ).toThrow(INVALID_REFERENCE_MESSAGE);
  });

  it("el borde positivo 0.01 SÍ es un precio ejecutable", () => {
    const decision = evaluateCross({
      side: "BUY",
      timeInForce: "IOC",
      limitPriceArs: new FinancialDecimal("100.00"),
      referencePriceArs: new FinancialDecimal("0.01"),
    });
    expect(decision.outcome).toBe("FILLED");
    if (decision.outcome !== "FILLED") throw new Error("se esperaba FILLED");
    expect(decision.filledPriceArs.toFixed(2)).toBe("0.01");
  });
});

describe("matchRestingOrders — misma precondición de referencia positiva", () => {
  it("ref 0.00 ⇒ RangeError (no llena todas las BUY a 0.00)", () => {
    expect(() =>
      matchRestingOrders(new FinancialDecimal("0.00"), [
        buildRestingOrder({
          id: 5,
          side: "BUY",
          sizeShares: 50,
          limitPriceArs: "100.00",
        }),
      ]),
    ).toThrow(INVALID_REFERENCE_MESSAGE);
  });
});
