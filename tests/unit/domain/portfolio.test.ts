// Tests unitarios del dominio de portfolio (FASE 2 — Célula A): escenarios
// EXACTOS A CENTAVOS con Decimal, sin DB. Los valores del seed salen de
// tests/helpers/fixtures.ts (golden values verificados en
// docs/database.md §3) — no se hardcodean sueltos.

import {
  deriveCash,
  derivePositions,
  deriveReservations,
  weightedAverageCost,
} from "../../../src/domain/portfolio/index.js";
import {
  SEED_INSTRUMENT_ARS_ID,
  SEED_INSTRUMENT_BMA_ID,
  SEED_INSTRUMENT_LOMA_ID,
  SEED_INSTRUMENT_METR_ID,
  SEED_INSTRUMENT_PAMP_ID,
  SEED_REFERENCE_CLOSES,
  SEED_USER_1_PORTFOLIO,
} from "../../helpers/fixtures.js";
import {
  buildMovement,
  buildRestingOrder,
  buildSnapshot,
  positionOfInstrument,
} from "./helpers.js";

/**
 * Movimientos FILLED del user 1 del seed (db/seed.sql), en orden cronológico:
 * la transferencia entra, se compra/vende entrelazado, y sale cash.
 */
const seedSettledMovements = [
  buildMovement({
    instrumentId: SEED_INSTRUMENT_ARS_ID,
    side: "CASH_IN",
    sizeShares: 1_000_000,
    priceArs: "1.00",
  }),
  buildMovement({
    instrumentId: SEED_INSTRUMENT_PAMP_ID,
    side: "BUY",
    sizeShares: 50,
    priceArs: "930.00",
  }),
  buildMovement({
    instrumentId: SEED_INSTRUMENT_PAMP_ID,
    side: "SELL",
    sizeShares: 10,
    priceArs: "940.00",
  }),
  buildMovement({
    instrumentId: SEED_INSTRUMENT_ARS_ID,
    side: "CASH_OUT",
    sizeShares: 100_000,
    priceArs: "1.00",
  }),
  buildMovement({
    instrumentId: SEED_INSTRUMENT_BMA_ID,
    side: "BUY",
    sizeShares: 20,
    priceArs: "1540.00",
  }),
  buildMovement({
    instrumentId: SEED_INSTRUMENT_METR_ID,
    side: "BUY",
    sizeShares: 500,
    priceArs: "250.00",
  }),
  buildMovement({
    instrumentId: SEED_INSTRUMENT_BMA_ID,
    side: "SELL",
    sizeShares: 30,
    priceArs: "1530.00",
  }),
];

/** Snapshots de la última fecha de marketdata del seed, por instrumento. */
const seedSnapshots = [
  buildSnapshot({
    instrumentId: SEED_INSTRUMENT_PAMP_ID,
    closeArs: SEED_REFERENCE_CLOSES.PAMP,
  }),
  buildSnapshot({
    instrumentId: SEED_INSTRUMENT_METR_ID,
    closeArs: SEED_REFERENCE_CLOSES.METR,
  }),
  buildSnapshot({
    instrumentId: SEED_INSTRUMENT_BMA_ID,
    closeArs: SEED_REFERENCE_CLOSES.BMA,
  }),
];

describe("deriveCash — cash liquidado de movimientos FILLED", () => {
  it("devuelve 0 si no hay movimientos", () => {
    expect(deriveCash([]).toFixed(2)).toBe("0.00");
  });

  it("reproduce el cash del seed del user 1: CASH_IN/CASH_OUT/BUY/SELL entrelazados, exacto a centavos", () => {
    // 1.000.000 − 46.500 + 9.400 − 100.000 − 30.800 − 125.000 + 45.900
    expect(deriveCash(seedSettledMovements).toFixed(2)).toBe(
      SEED_USER_1_PORTFOLIO.cashSettledArs, // "753000.00" (docs/database.md §3)
    );
  });

  it("centavos exactos con precios no redondos", () => {
    // 3×33.50 − 1×0.25 − 3×33.33 + 1×10.10 = 100.50 − 0.25 − 99.99 + 10.10
    const movements = [
      buildMovement({ side: "CASH_IN", sizeShares: 3, priceArs: "33.50" }),
      buildMovement({ side: "CASH_OUT", sizeShares: 1, priceArs: "0.25" }),
      buildMovement({ side: "BUY", sizeShares: 3, priceArs: "33.33" }),
      buildMovement({ side: "SELL", sizeShares: 1, priceArs: "10.10" }),
    ];
    expect(deriveCash(movements).toFixed(2)).toBe("10.36");
  });
});

describe("deriveReservations — reservas derivadas de órdenes NEW", () => {
  it("sin órdenes NEW: cash reservado 0 y mapa vacío", () => {
    const reservations = deriveReservations([]);
    expect(reservations.cashReservedArs.toFixed(2)).toBe("0.00");
    expect(reservations.sharesReservedByInstrument.size).toBe(0);
  });

  it("BUY y SELL combinadas: BUY reserva cash (limit×size), SELL reserva acciones por instrumento", () => {
    const restingOrders = [
      buildRestingOrder({
        id: 5,
        instrumentId: SEED_INSTRUMENT_LOMA_ID,
        side: "BUY",
        sizeShares: 50,
        limitPriceArs: "710.00",
      }),
      buildRestingOrder({
        id: 7,
        instrumentId: SEED_INSTRUMENT_BMA_ID,
        side: "BUY",
        sizeShares: 60,
        limitPriceArs: "1500.00",
      }),
      buildRestingOrder({
        id: 6,
        instrumentId: SEED_INSTRUMENT_PAMP_ID,
        side: "SELL",
        sizeShares: 100,
        limitPriceArs: "950.00",
      }),
      buildRestingOrder({
        id: 8,
        instrumentId: SEED_INSTRUMENT_PAMP_ID,
        side: "SELL",
        sizeShares: 40,
        limitPriceArs: "945.00",
      }),
    ];

    const reservations = deriveReservations(restingOrders);

    // 50×710 + 60×1500 = 35.500 + 90.000 (golden del seed, fixtures.ts)
    expect(reservations.cashReservedArs.toFixed(2)).toBe(
      SEED_USER_1_PORTFOLIO.cashReservedArs, // "125500.00"
    );
    // Sólo SELL NEW reserva acciones, acumuladas por instrumento (47 → 140);
    // los BUY no crean entrada en el mapa.
    expect(reservations.sharesReservedByInstrument).toEqual(
      new Map([[SEED_INSTRUMENT_PAMP_ID, 140]]),
    );
  });

  it("sólo SELL NEW no reserva cash; los centavos del límite suman exactos", () => {
    const restingOrders = [
      buildRestingOrder({
        side: "SELL",
        sizeShares: 13,
        limitPriceArs: "7.55",
      }),
      buildRestingOrder({
        side: "SELL",
        sizeShares: 13,
        limitPriceArs: "8.05",
      }),
    ];
    const reservations = deriveReservations(restingOrders);
    expect(reservations.cashReservedArs.toFixed(2)).toBe("0.00");
    expect(reservations.sharesReservedByInstrument).toEqual(
      new Map([[SEED_INSTRUMENT_PAMP_ID, 26]]),
    );
  });
});

describe("weightedAverageCost — costo promedio ponderado de un instrumento", () => {
  it("0 si no hay compras", () => {
    expect(weightedAverageCost([]).toFixed(2)).toBe("0.00");
    expect(
      weightedAverageCost([
        buildMovement({ side: "SELL", sizeShares: 5, priceArs: "940.00" }),
      ]).toFixed(2),
    ).toBe("0.00");
  });

  it("dos compras a distinto precio: Σ(size×price)/Σsize exacto a centavos", () => {
    const buys = [
      buildMovement({
        instrumentId: SEED_INSTRUMENT_METR_ID,
        side: "BUY",
        sizeShares: 10,
        priceArs: "260.00",
      }),
      buildMovement({
        instrumentId: SEED_INSTRUMENT_METR_ID,
        side: "BUY",
        sizeShares: 30,
        priceArs: "245.00",
      }),
    ];
    // (10×260 + 30×245) / 40 = 9.950 / 40 = 248.75
    expect(weightedAverageCost(buys).toFixed(2)).toBe("248.75");
  });

  it("una venta intercalada NO toca el promedio (sólo se miran las compras)", () => {
    const withSell = [
      buildMovement({
        instrumentId: SEED_INSTRUMENT_METR_ID,
        side: "BUY",
        sizeShares: 10,
        priceArs: "260.00",
      }),
      buildMovement({
        instrumentId: SEED_INSTRUMENT_METR_ID,
        side: "SELL",
        sizeShares: 25,
        priceArs: "240.00",
      }),
      buildMovement({
        instrumentId: SEED_INSTRUMENT_METR_ID,
        side: "BUY",
        sizeShares: 30,
        priceArs: "245.00",
      }),
    ];
    expect(weightedAverageCost(withSell).toFixed(2)).toBe("248.75");
  });
});

describe("derivePositions — posiciones con P&L no realizado", () => {
  it("reproduce las posiciones del seed del user 1, ordenadas por instrumentId, exactas a centavos", () => {
    const positions = derivePositions(seedSettledMovements, seedSnapshots);

    // 31 (BMA) < 47 (PAMP) < 54 (METR): orden determinístico por instrumentId.
    expect(positions.map((position) => position.instrumentId)).toEqual([
      SEED_INSTRUMENT_BMA_ID,
      SEED_INSTRUMENT_PAMP_ID,
      SEED_INSTRUMENT_METR_ID,
    ]);

    // BMA: 20 compradas − 30 vendidas = −10 (negativa del seed, se lista tal cual).
    const bma = positionOfInstrument(positions, SEED_INSTRUMENT_BMA_ID);
    expect(bma.quantityShares).toBe(-10);
    expect(bma.weightedAverageCostArs.toFixed(2)).toBe("1540.00");
    expect(bma.marketValueArs?.toFixed(2)).toBe("-15028.00"); // −10 × 1502.80
    expect(bma.priceAvailable).toBe(true);
    // (−15.028 − (−15.400)) / (−15.400) × 100 = −2.4155…% → −2.42 (2 dec.)
    expect(bma.totalReturnPctX100?.toFixed(2)).toBe("-2.42");

    // PAMP: 50 − 10 = 40 @ 930 de promedio (una sola compra).
    const pamp = positionOfInstrument(positions, SEED_INSTRUMENT_PAMP_ID);
    expect(pamp.quantityShares).toBe(40);
    expect(pamp.weightedAverageCostArs.toFixed(2)).toBe("930.00");
    expect(pamp.marketValueArs?.toFixed(2)).toBe("37034.00"); // 40 × 925.85
    expect(pamp.totalReturnPctX100?.toFixed(2)).toBe("-0.45"); // −166/37.200×100

    // METR: 500 @ 250, mark 229.50 → −8.20% exacto.
    const metr = positionOfInstrument(positions, SEED_INSTRUMENT_METR_ID);
    expect(metr.quantityShares).toBe(500);
    expect(metr.weightedAverageCostArs.toFixed(2)).toBe("250.00");
    expect(metr.marketValueArs?.toFixed(2)).toBe("114750.00");
    expect(metr.totalReturnPctX100?.toFixed(2)).toBe("-8.20");
  });

  it("el promedio queda sobre las COMPRAS aunque haya ventas después (la venta no lo toca)", () => {
    const movements = [
      buildMovement({ side: "BUY", sizeShares: 10, priceArs: "260.00" }),
      buildMovement({ side: "BUY", sizeShares: 30, priceArs: "240.00" }),
      buildMovement({ side: "SELL", sizeShares: 25, priceArs: "240.00" }),
    ];
    const positions = derivePositions(
      movements,
      [buildSnapshot({ closeArs: "294.00" })],
    );

    const position = positionOfInstrument(
      positions,
      SEED_INSTRUMENT_PAMP_ID,
    );
    expect(position.quantityShares).toBe(15);
    expect(position.weightedAverageCostArs.toFixed(2)).toBe("245.00"); // 9.800/40
    expect(position.marketValueArs?.toFixed(2)).toBe("4410.00"); // 15 × 294
    // (4.410 − 3.675) / 3.675 × 100 = 20.00 exacto.
    expect(position.totalReturnPctX100?.toFixed(2)).toBe("20.00");
  });

  it("posición con cantidad 0 (compra y venta completas) NO se lista", () => {
    const movements = [
      buildMovement({ side: "BUY", sizeShares: 10, priceArs: "100.00" }),
      buildMovement({ side: "SELL", sizeShares: 10, priceArs: "101.00" }),
    ];
    expect(derivePositions(movements, [buildSnapshot()])).toEqual([]);
  });

  it("posición negativa se devuelve tal cual, con retorno exacto negativo", () => {
    const movements = [
      buildMovement({
        instrumentId: SEED_INSTRUMENT_BMA_ID,
        side: "BUY",
        sizeShares: 20,
        priceArs: "150.00",
      }),
      buildMovement({
        instrumentId: SEED_INSTRUMENT_BMA_ID,
        side: "SELL",
        sizeShares: 30,
        priceArs: "148.00",
      }),
    ];
    const positions = derivePositions(
      movements,
      [buildSnapshot({ instrumentId: SEED_INSTRUMENT_BMA_ID, closeArs: "135.00" })],
    );

    const bma = positionOfInstrument(positions, SEED_INSTRUMENT_BMA_ID);
    expect(bma.quantityShares).toBe(-10);
    expect(bma.weightedAverageCostArs.toFixed(2)).toBe("150.00");
    expect(bma.marketValueArs?.toFixed(2)).toBe("-1350.00");
    // (−1.350 − (−1.500)) / (−1.500) × 100 = −10.00 exacto.
    expect(bma.totalReturnPctX100?.toFixed(2)).toBe("-10.00");
  });

  it("CASH_IN/CASH_OUT no son posiciones: se ignoran aunque tengan instrumentId", () => {
    const movements = [
      buildMovement({
        instrumentId: SEED_INSTRUMENT_ARS_ID,
        side: "CASH_IN",
        sizeShares: 100,
        priceArs: "1.00",
      }),
      buildMovement({
        instrumentId: SEED_INSTRUMENT_ARS_ID,
        side: "CASH_OUT",
        sizeShares: 50,
        priceArs: "1.00",
      }),
    ];
    // Snapshot de ARS presente y todo: no aparece posición de la MONEDA.
    expect(
      derivePositions(movements, [
        buildSnapshot({ instrumentId: SEED_INSTRUMENT_ARS_ID, closeArs: "1.00" }),
      ]),
    ).toEqual([]);
  });

  it("sin snapshot del instrumento: marketValue null, priceAvailable false, totalReturn null", () => {
    // Instrumento 3: sin marketdata en el seed (SEED_INSTRUMENTS_WITHOUT_MARKETDATA).
    const movements = [
      buildMovement({ instrumentId: 3, side: "BUY", sizeShares: 10, priceArs: "100.00" }),
    ];
    const positions = derivePositions(
      movements,
      [buildSnapshot({ instrumentId: SEED_INSTRUMENT_PAMP_ID, closeArs: "925.85" })],
    );

    const position = positionOfInstrument(positions, 3);
    expect(position.quantityShares).toBe(10);
    expect(position.weightedAverageCostArs.toFixed(2)).toBe("100.00");
    expect(position.marketValueArs).toBeNull(); // NO_PRICE: no suma al total
    expect(position.priceAvailable).toBe(false);
    expect(position.totalReturnPctX100).toBeNull();
  });

  it("costo 0 (posición con sólo ventas, sin compras): totalReturn null aunque haya precio", () => {
    const movements = [
      buildMovement({
        instrumentId: SEED_INSTRUMENT_PAMP_ID,
        side: "SELL",
        sizeShares: 5,
        priceArs: "100.00",
      }),
    ];
    const positions = derivePositions(
      movements,
      [buildSnapshot({ closeArs: "50.00" })],
    );

    const position = positionOfInstrument(positions, SEED_INSTRUMENT_PAMP_ID);
    expect(position.quantityShares).toBe(-5);
    expect(position.weightedAverageCostArs.toFixed(2)).toBe("0.00");
    expect(position.marketValueArs?.toFixed(2)).toBe("-250.00");
    expect(position.priceAvailable).toBe(true);
    expect(position.totalReturnPctX100).toBeNull(); // costo 0: % indefinido
  });

  it("orden determinístico por instrumentId aunque las filas vengan desordenadas", () => {
    const movements = [
      buildMovement({ instrumentId: 54, side: "BUY", sizeShares: 1, priceArs: "1.00" }),
      buildMovement({ instrumentId: 31, side: "BUY", sizeShares: 1, priceArs: "1.00" }),
      buildMovement({ instrumentId: 47, side: "BUY", sizeShares: 1, priceArs: "1.00" }),
    ];
    expect(
      derivePositions(movements, []).map((position) => position.instrumentId),
    ).toEqual([31, 47, 54]);
  });
});