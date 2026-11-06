// D-07 — invariante de precio de referencia > 0 en la DECISIÓN: con un
// close 0.00 (o negativo) la orden se REJECTED NO_PRICE (razón ya existente),
// nunca FILLED a 0.00. La precondición dura del dominio vive en
// evaluateCross; acá se prueba el resultado persistible que decide la
// aplicación antes de la primera escritura.

import { FinancialDecimal } from "../../../src/contracts/index.js";
import {
  decideAcceptedOrder,
  decideLimitOrder,
  decideMarketFill,
} from "../../../src/application/orders/decide-order.js";
import { isUsableReferencePrice } from "../../../src/domain/matching/index.js";
import type {
  CreateOrderRequest,
  OrderEventMetadata,
  TimeInForce,
} from "../../../src/contracts/index.js";

const decidedAt = new Date("2023-07-14T11:00:00.000Z");

const auditBase = (referencePriceArs: string | null): OrderEventMetadata => ({
  ticker: "PAMP",
  referencePriceArs,
  sizingPriceArs: null,
  sizeDerivedFromAmount: false,
  residualArs: null,
});

const marketRequest = (size: number): CreateOrderRequest => ({
  instrumentId: 1,
  side: "BUY",
  type: "MARKET",
  timeInForce: "GTC",
  size,
});

const limitRequest = (
  side: "BUY" | "SELL",
  timeInForce: TimeInForce,
  price: string,
): CreateOrderRequest => ({
  instrumentId: 1,
  side,
  type: "LIMIT",
  timeInForce,
  size: 2,
  price: new FinancialDecimal(price),
});

const acceptedInput = (
  request: CreateOrderRequest,
  referencePriceArs: string | null,
  limitPriceArs: string | null,
  sizeShares = 2,
): Parameters<typeof decideAcceptedOrder>[0] => ({
  request,
  sizeShares,
  referencePriceArs:
    referencePriceArs === null ? null : new FinancialDecimal(referencePriceArs),
  limitPriceArs:
    limitPriceArs === null ? null : new FinancialDecimal(limitPriceArs),
  auditBase: auditBase(referencePriceArs),
  decidedAt,
});

describe("isUsableReferencePrice", () => {
  it("null, 0.00 y negativa NO son usables; 0.01 sí", () => {
    expect(isUsableReferencePrice(null)).toBe(false);
    expect(isUsableReferencePrice(new FinancialDecimal("0.00"))).toBe(false);
    expect(isUsableReferencePrice(new FinancialDecimal("-1.00"))).toBe(false);
    expect(isUsableReferencePrice(new FinancialDecimal("0.01"))).toBe(true);
  });
});

describe("decideMarketFill — referencia 0.00 ⇒ REJECTED NO_PRICE", () => {
  it("no llena a 0.00: REJECTED NO_PRICE con el size y la metadata de auditoría", () => {
    const input = acceptedInput(marketRequest(3), "0.00", null, 3);

    expect(decideMarketFill(input)).toEqual({
      status: "REJECTED",
      sizeShares: 3,
      filledPriceArs: null,
      filledAt: null,
      eventType: "REJECTED",
      reason: "NO_PRICE",
      metadata: auditBase("0.00"),
    });
  });

  it("decideAcceptedOrder MARKET con ref 0.00 tampoco llena", () => {
    const input = acceptedInput(marketRequest(2), "0.00", null);
    const decision = decideAcceptedOrder(input);
    expect(decision.status).toBe("REJECTED");
    expect(decision.reason).toBe("NO_PRICE");
    expect(decision.filledPriceArs).toBeNull();
  });

  it("referencia positiva sigue FILLED al ref (el invariante no bloquea el caso válido)", () => {
    const decision = decideMarketFill(
      acceptedInput(marketRequest(2), "925.85", null),
    );
    expect(decision.status).toBe("FILLED");
    expect(decision.filledPriceArs?.toFixed(2)).toBe("925.85");
    expect(decision.filledAt).toBe(decidedAt);
  });
});

describe("decideLimitOrder IOC/FOK — referencia 0.00 ⇒ REJECTED NO_PRICE", () => {
  it("IOC BUY no se llena a 0.00: REJECTED NO_PRICE", () => {
    const decision = decideLimitOrder(
      acceptedInput(
        limitRequest("BUY", "IOC", "100.00"),
        "0.00",
        "100.00",
      ),
    );
    expect(decision).toEqual({
      status: "REJECTED",
      sizeShares: 2,
      filledPriceArs: null,
      filledAt: null,
      eventType: "REJECTED",
      reason: "NO_PRICE",
      metadata: auditBase("0.00"),
    });
  });

  it("FOK SELL con referencia negativa ⇒ REJECTED NO_PRICE", () => {
    const decision = decideLimitOrder(
      acceptedInput(
        limitRequest("SELL", "FOK", "100.00"),
        "-1.00",
        "100.00",
      ),
    );
    expect(decision.status).toBe("REJECTED");
    expect(decision.reason).toBe("NO_PRICE");
    expect(decision.filledPriceArs).toBeNull();
  });

  it("LIMIT GTC sigue NEW sin precio (no necesita referencia)", () => {
    const decision = decideAcceptedOrder(
      acceptedInput(limitRequest("BUY", "GTC", "100.00"), null, "100.00"),
    );
    expect(decision.status).toBe("NEW");
    expect(decision.filledPriceArs).toBeNull();
  });
});
