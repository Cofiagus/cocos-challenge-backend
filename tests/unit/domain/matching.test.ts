// Tests unitarios del dominio de matching (FASE 2 — Célula A): TODAS las
// ramas de evaluateCross (GTC/IOC/FOK × BUY/SELL × cruza/no cruza) y
// matchRestingOrders pura. Precios con centavos reales del seed
// (SEED_REFERENCE_CLOSES) — exactos, nunca aproximados.

import {
  evaluateCross,
  matchRestingOrders,
} from "../../../src/domain/matching/index.js";
import type {
  CrossDecision,
  RestingOrderFill,
} from "../../../src/domain/matching/index.js";
import { FinancialDecimal } from "../../../src/contracts/index.js";
import type {
  TimeInForce,
  TradingSide,
} from "../../../src/contracts/index.js";
import { SEED_REFERENCE_CLOSES } from "../../helpers/fixtures.js";
import { buildRestingOrder } from "./helpers.js";

interface EvaluateCrossOverrides {
  readonly side?: TradingSide;
  readonly limitPriceArs?: string;
  readonly timeInForce?: TimeInForce;
  readonly referencePriceArs?: string;
}

const buildEvaluateCrossInput = (
  overrides: EvaluateCrossOverrides = {},
): Parameters<typeof evaluateCross>[0] => ({
  side: overrides.side ?? "BUY",
  limitPriceArs: new FinancialDecimal(overrides.limitPriceArs ?? "100.00"),
  timeInForce: overrides.timeInForce ?? "IOC",
  referencePriceArs: new FinancialDecimal(overrides.referencePriceArs ?? "100.00"),
});

/** Fail ruidoso si la decisión no es FILLED, con el precio esperado a centavos. */
const expectFilled = (decision: CrossDecision, expectedPriceArs: string): void => {
  if (decision.outcome !== "FILLED") {
    throw new Error(
      `se esperaba FILLED a ${expectedPriceArs}, vino ${decision.outcome}`,
    );
  }
  expect(decision.filledPriceArs.toFixed(2)).toBe(expectedPriceArs);
};

const expectCancelledNoImmediateMatch = (decision: CrossDecision): void => {
  expect(decision).toEqual({ outcome: "CANCELLED", reason: "NO_IMMEDIATE_MATCH" });
};

describe("evaluateCross — evaluación única contra el precio de referencia", () => {
  it("GTC → NEW siempre, aun cuando el cruce favorecería (nunca se llena al enviar)", () => {
    // BUY 100.00 con ref 1.00: cruzaría escandalosamente; GTC no evalúa.
    const decision = evaluateCross(
      buildEvaluateCrossInput({
        timeInForce: "GTC",
        limitPriceArs: "100.00",
        referencePriceArs: "1.00",
      }),
    );
    expect(decision).toEqual({ outcome: "NEW" });
  });

  it("GTC SELL también queda NEW (espejo)", () => {
    const decision = evaluateCross(
      buildEvaluateCrossInput({
        side: "SELL",
        timeInForce: "GTC",
        limitPriceArs: "100.00",
        referencePriceArs: "1000.00",
      }),
    );
    expect(decision).toEqual({ outcome: "NEW" });
  });

  it("IOC BUY cruza con mejora por gap: llena al ref (min(límite, ref))", () => {
    const decision = evaluateCross(
      buildEvaluateCrossInput({
        side: "BUY",
        timeInForce: "IOC",
        limitPriceArs: "930.00",
        referencePriceArs: SEED_REFERENCE_CLOSES.PAMP, // 925.85
      }),
    );
    expectFilled(decision, "925.85"); // paga el ref, no el límite de 930
  });

  it("FOK BUY cruza con mejora por gap (mismas reglas que IOC)", () => {
    const decision = evaluateCross(
      buildEvaluateCrossInput({
        side: "BUY",
        timeInForce: "FOK",
        limitPriceArs: "100.50",
        referencePriceArs: "100.49",
      }),
    );
    expectFilled(decision, "100.49");
  });

  it("IOC BUY cruce EXACTO al límite: llena al propio límite, sin mejora", () => {
    const decision = evaluateCross(
      buildEvaluateCrossInput({
        side: "BUY",
        timeInForce: "IOC",
        limitPriceArs: SEED_REFERENCE_CLOSES.PAMP, // 925.85
        referencePriceArs: SEED_REFERENCE_CLOSES.PAMP,
      }),
    );
    expectFilled(decision, "925.85");
  });

  it("FOK BUY cruce exacto al límite: llena al límite", () => {
    const decision = evaluateCross(
      buildEvaluateCrossInput({
        side: "BUY",
        timeInForce: "FOK",
        limitPriceArs: "150.00",
        referencePriceArs: "150.00",
      }),
    );
    expectFilled(decision, "150.00");
  });

  it("IOC BUY no cruza (ref > límite): CANCELLED con NO_IMMEDIATE_MATCH", () => {
    const decision = evaluateCross(
      buildEvaluateCrossInput({
        side: "BUY",
        timeInForce: "IOC",
        limitPriceArs: "920.00",
        referencePriceArs: SEED_REFERENCE_CLOSES.PAMP, // 925.85 > 920
      }),
    );
    expectCancelledNoImmediateMatch(decision);
  });

  it("FOK BUY no cruza: CANCELLED con NO_IMMEDIATE_MATCH", () => {
    const decision = evaluateCross(
      buildEvaluateCrossInput({
        side: "BUY",
        timeInForce: "FOK",
        limitPriceArs: "100.00",
        referencePriceArs: "100.01",
      }),
    );
    expectCancelledNoImmediateMatch(decision);
  });

  it("IOC SELL cruza con mejora por gap: llena al ref (max(límite, ref))", () => {
    const decision = evaluateCross(
      buildEvaluateCrossInput({
        side: "SELL",
        timeInForce: "IOC",
        limitPriceArs: "900.00",
        referencePriceArs: SEED_REFERENCE_CLOSES.PAMP, // 925.85
      }),
    );
    expectFilled(decision, "925.85"); // cobra el ref, no el límite de 900
  });

  it("FOK SELL cruza con mejora por gap, centavos exactos", () => {
    const decision = evaluateCross(
      buildEvaluateCrossInput({
        side: "SELL",
        timeInForce: "FOK",
        limitPriceArs: "710.00",
        referencePriceArs: "712.34",
      }),
    );
    expectFilled(decision, "712.34");
  });

  it("IOC SELL cruce EXACTO al límite: llena al límite, sin mejora", () => {
    const decision = evaluateCross(
      buildEvaluateCrossInput({
        side: "SELL",
        timeInForce: "IOC",
        limitPriceArs: SEED_REFERENCE_CLOSES.METR, // 229.50
        referencePriceArs: SEED_REFERENCE_CLOSES.METR,
      }),
    );
    expectFilled(decision, "229.50");
  });

  it("IOC SELL no cruza (ref < límite): CANCELLED con NO_IMMEDIATE_MATCH", () => {
    const decision = evaluateCross(
      buildEvaluateCrossInput({
        side: "SELL",
        timeInForce: "IOC",
        limitPriceArs: "950.00",
        referencePriceArs: SEED_REFERENCE_CLOSES.PAMP, // 925.85 < 950
      }),
    );
    expectCancelledNoImmediateMatch(decision);
  });

  it("FOK SELL no cruza: CANCELLED con NO_IMMEDIATE_MATCH", () => {
    const decision = evaluateCross(
      buildEvaluateCrossInput({
        side: "SELL",
        timeInForce: "FOK",
        limitPriceArs: "1000.00",
        referencePriceArs: "999.99",
      }),
    );
    expectCancelledNoImmediateMatch(decision);
  });
});

describe("matchRestingOrders — qué NEW llenaría a este ref (PURA)", () => {
  const referencePriceArs = new FinancialDecimal(SEED_REFERENCE_CLOSES.PAMP); // 925.85

  const fillOf = (
    fills: readonly RestingOrderFill[],
    orderId: number,
  ): RestingOrderFill => {
    const fill = fills.find((candidate) => candidate.orderId === orderId);
    if (fill === undefined) {
      throw new Error(`se esperaba fill de la orden ${orderId}`);
    }
    return fill;
  };

  it("mezcla BUY/SELL: llena sólo las que cruzan, con mejora, en el orden de entrada", () => {
    const restingOrders = [
      buildRestingOrder({ id: 5, side: "BUY", sizeShares: 50, limitPriceArs: "920.00" }), // ref 925.85 > 920: NO cruza
      buildRestingOrder({ id: 7, side: "BUY", sizeShares: 60, limitPriceArs: "1000.00" }), // cruza holgado
      buildRestingOrder({ id: 12, side: "BUY", sizeShares: 25, limitPriceArs: "925.85" }), // cruce exacto
      buildRestingOrder({ id: 6, side: "SELL", sizeShares: 100, limitPriceArs: "950.00" }), // ref < 950: NO cruza
      buildRestingOrder({ id: 9, side: "SELL", sizeShares: 40, limitPriceArs: "925.85" }), // cruce exacto
      buildRestingOrder({ id: 11, side: "SELL", sizeShares: 30, limitPriceArs: "900.00" }), // cruza holgado
    ];

    const fills = matchRestingOrders(referencePriceArs, restingOrders);

    // Sólo las que cruzan, preservando el orden de entrada.
    expect(fills.map((fill) => fill.orderId)).toEqual([7, 12, 9, 11]);
    // BUY llena al ref (min(límite, ref)): el límite de 1000 NO se usa.
    expect(fillOf(fills, 7).filledPriceArs.toFixed(2)).toBe("925.85");
    expect(fillOf(fills, 12).filledPriceArs.toFixed(2)).toBe("925.85");
    // SELL llena al ref (max(límite, ref)): el límite de 900 NO se usa.
    expect(fillOf(fills, 9).filledPriceArs.toFixed(2)).toBe("925.85");
    expect(fillOf(fills, 11).filledPriceArs.toFixed(2)).toBe("925.85");
  });

  it("es PURA: no muta las órdenes de entrada (freeze) ni devuelve la misma lista", () => {
    const restingOrders = [
      buildRestingOrder({ id: 5, side: "BUY", sizeShares: 50, limitPriceArs: "920.00" }),
      buildRestingOrder({ id: 7, side: "SELL", sizeShares: 60, limitPriceArs: "900.00" }),
    ].map((order) => Object.freeze(order));
    const snapshot = restingOrders.map((order) => ({ ...order }));

    const fills = matchRestingOrders(referencePriceArs, restingOrders);

    // Sin fills parciales ni efectos: la lista de entrada queda intacta
    // (una mutación sobre Object.freeze lanza en modo estricto).
    expect(restingOrders).toEqual(snapshot.map(Object.freeze));
    expect(fills).not.toBe(restingOrders);
  });

  it("sin órdenes resting no hay fills", () => {
    expect(matchRestingOrders(referencePriceArs, [])).toEqual([]);
  });

  it("ninguna cruza cuando el ref está lejos de todos los límites", () => {
    const restingOrders = [
      buildRestingOrder({ id: 5, side: "BUY", sizeShares: 50, limitPriceArs: "900.00" }),
      buildRestingOrder({ id: 6, side: "SELL", sizeShares: 100, limitPriceArs: "950.00" }),
    ];
    expect(matchRestingOrders(referencePriceArs, restingOrders)).toEqual([]);
  });
});